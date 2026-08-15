# Atlas Kit — runtime protocols

A concrete map of the conventions that govern how dev/knowledge agents are steered,
shipped, torn down, and coupled to the Atlas vault. Code references over prose —
read the cited source before relying on any of this, since line numbers drift.

---

## 1. Dev-agent steering semantics

The lifecycle is an explicit state machine, orthogonal to the momentary tmux-derived
`status` (running/idle/done/error): **`agent-lifecycle.mjs`** (`S`) defines

```
spawned → working → ship_ready → shipping → shipped
                                                ↓
                               ingesting → ingested → reaping → reaped
```

plus a `needs_attention` sink for anything that can't make progress (a ship that never
confirmed its merge, a session that vanished mid-close). `decide()` (lines 140–222) is
the pure transition function; `agent-local.mjs`'s `driveSession`/`driveAll`
 gather the facts (transcript markers, tmux busy/menu state) and run it
once per session per tick.

Five operations act on a live session, each with a different disruption profile:

| Action | Implementation | Behavior | Use when |
|---|---|---|---|
| **queue** | `queuePrompt()` — `agent-local.mjs` | Appends to `s.queued` (a FIFO). `flushQueued()`, on a 3s timer (`QUEUE_FLUSH_MS`), delivers the FIFO head when **`queue-delivery.mjs` says it may** — see [§1a](#1a-when-a-queued-message-is-delivered). A menu, or being the active ship-train head, still holds everything. | The agent is mid-turn; you want to add context without breaking its flow. The gentle default. |
| **prompt** | `prompt()` — `agent-local.mjs` | Delivers immediately. Refuses with `409` if a choice menu (plan/permission) is pending, unless `force` is set — typing into a live menu would silently confirm the highlighted option. Delivery itself **sanitises terminal escapes and reads the input box back before pressing Enter** (`tui-input.mjs`): `send-keys -l` is a keyboard, so an escape sequence in pasted text is parsed as keys and swallows the words around it. A buffer that can't be read back is cleared and the call fails rather than submitting something mangled. | The agent is already idle, waiting on you. |
| **interrupt** | `interrupt()` — `agent-local.mjs:2101` | Sends `Escape` (stops the in-flight turn, **keeps** the transcript), waits `INTERRUPT_SETTLE_MS` (400ms) for the TUI to settle, then delivers. Disruptive. | The agent is going wrong and must change course *now*. |
| **kill** | `kill()` — `agent-local.mjs:2856` | For a dev agent **without** a live paired Atlas worker (or on a second press), an immediate `tmux kill-session` — the worktree + `agent/<id>` branch are **kept** for review. For a dev agent **with** a paired worker (first press), closes gracefully: delivers `DEV_RECAP_PROMPT` (line 2671), moves the session to `ingesting/recap`, and lets the driver run recap → worker ingest → Atlas merge → reap. Never touches the git remote beyond killing tmux. | The agent's work is done or it was started in error, but you're not ready to delete its branch. |
| **merge** | `mergePr()` — `agent-local.mjs` | Pre-flights the PR server-side (`merge-preflight.mjs`) and **refuses a stale / conflicted / blocked / red / checks-pending one with the state named**; on pass, runs `gh pr merge --merge` in the session's repo checkout and records who merged. Box-local only. `force: true` skips the pre-flight, audited as such. Neither `kill` nor `cleanup` ever merges anything. | You already know the PR is fresh and green. Otherwise **ship** the agent — merging does not rebase. |
| **cleanup** | `cleanup()` — `agent-local.mjs` | Same graceful recap/ingest path as `kill`, but sets `s.lc.cleanupOnClose = true` so the final `REAP` act (`ACTS[ACT.REAP]`) **also** calls `removeAgentArtifacts()` (line 2910) — `git worktree remove --force` + `git branch -D`. Irreversible from inside the runtime. | Only once the work is actually merged/abandoned — see [§3](#3-cleanup-gating). |

`abortClose()` (`agent-local.mjs:2972`) undoes a wrong kill/cleanup press — but **only**
while the session is still in `ingesting` (re-interrupts the recap/ingest turn and
restores the live lifecycle state). Once `ingested`/`reaping` have started (the Atlas
merge is running, or tmux is already dead) there's nothing left to call back.

---

## 1a. When a queued message is delivered

A parked prompt no longer waits for a full idle. **`queue-delivery.mjs`** is the single
decision, shared by the box executor and the bridge (imported, not copied, so the two
cannot drift), and it reads the message's `kind`:

- **Course-changing kinds** — `operator`, `steer`, `reply-receipt`, `turn-end` (and
  `agent-msg`, reserved for peer mail) — are delivered at the running turn's next
  **tool-call boundary**, which is where Claude Code surfaces mid-turn input. Paced to at
  most one per `BOUNDARY_MIN_GAP_MS` per session, because at idle the pacing came free
  (delivery made the agent busy) and mid-turn nothing paces it.
- **Observational kinds** — a briefing, a fleet note — still wait for a **full idle**, so
  they never interrupt work in flight.
- **Unknown/untagged fails safe**: anything without a recognised `kind` is idle-only. This
  is why `POST /api/agents/queue` stamps `steer`/`operator` on the body *before*
  forwarding — an unstamped entry would silently read as observational.

A pending **menu** holds every kind (typing into a menu is a selection, not text), as does
being the active ship-train head. A delivery the executor refuses (a box it can't clear, a
buffer that won't read back) backs the session off with `deliveryBackoffMs` instead of
retrying every 3 s; the message stays queued. `AGENT_BOUNDARY_DELIVERY=0` /
`BRIDGE_BOUNDARY_DELIVERY=0` restore idle-only delivery, independently per executor.

---

## 2. The ship protocol

**Producer** — `RECONCILE_PREAMBLE` (`agent-routes.mjs`, assembled by `reconcilePreamble()`), appended to every
spawned dev agent, instructs it to end a reply with `ATLAS:READY-TO-SHIP` the moment it
judges its branch complete/committed/pushed/mergeable, and `ATLAS:SHIPPED PR #<n>
<sha>` once the ship protocol's merge actually succeeds.

**Consumer** — `subagent-scan.mjs:128`:

```js
const SHIP_MARKER = /^[ \t]*ATLAS:(READY-TO-SHIP|SHIPPED)\b([^\n]*)$/gm
```

`scanShipMarker()` (~139) scans only **assistant**-authored transcript text (so the
instruction text itself, which lives in a user-side event, can never accidentally
match), and the **latest** marker wins — a `shipped → new task → ready` sequence flips
the state back to ready.

**⚠️ Hazard: these two must move together.** The marker text the preamble emits and the
regex that scans for it are independent strings living in different files. Change the
prefix or format in one without the other and ship detection breaks silently — the
agent keeps printing a marker nobody's listening for, or the regex expects a prefix the
agent no longer prints. This is exactly what happened during this convention's rebrand
from a prior marker prefix — grep both `RECONCILE_PREAMBLE` and `SHIP_MARKER` whenever
you touch either.

**How the lifecycle reads it** — `mirrorState()` (`agent-lifecycle.mjs:78–82`) maps
`'ready'` → `SHIP_READY`, `'shipped'` → `SHIPPED`; `decide()`'s
`WORKING`/`SHIP_READY`/`SHIPPED` case (lines 151–164) re-derives this every tick unless
a ship is actively requested. Once enqueued (`enqueueShip()`, `agent-local.mjs:2205`)
and at the front of the serial ship train (`isShipHead()`), the `SHIPPING`
case (lines 166–185) delivers the ship prompt, then waits for the `ATLAS:SHIPPED`
marker to advance **past** a snapshotted baseline (the `ENTER_SHIPPING` act) —
re-read from the on-disk transcript every tick, never an in-memory flag.

**`READY-TO-SHIP` means the agent opened/updated a PR and believes it's mergeable — it
does NOT mean anything merged.** Only a genuinely *new* `SHIPPED` marker (past the
ship's own baseline) is treated as evidence of a merge inside the lifecycle machine,
and even that is a self-report scanned from the agent's own text. `kill_agent`
(`kill()`, `agent-local.mjs:2856`) never merges, pushes, or opens anything — it only
kills tmux (and optionally asks for a recap) — so an agent being killed or cleaned up
is never evidence of a merge either.

**`merged` is no longer a claim at all.** `sampleMerged()` (`agent-local.mjs`, every
`AGENT_MERGED_CHECK_MS`, default 5 min) asks the *repository*: it refreshes the one
default-branch ref and looks for a merge commit whose second parent is the agent's branch
tip (`mergedVerdict()`, `merged-check.mjs`). That verdict is persisted on the session, is
terminal, and **outranks both markers** in `publicView` — so a PR merged by the
orchestrator, by the operator on github.com, or by anyone else stops reading as `ready`,
and its `shipInfo` is the PR number + merge SHA read off the commit rather than off a
reply. For a bridge repo with no box checkout the same question goes to GitHub's closed-PR
list (`mergedFromPulls()`), keyed on `merged_at` and never on `state`.
⚠️ A **squash- or rebase-merged** PR leaves no merge commit, so the local path cannot see
it and the session falls back to its own marker — there, `gh pr view <n> --json
state,mergedAt` is still the only verification.

**One ship instruction, one entry point.** `ship-prompt.mjs` owns the wording. The spawn
preamble quotes it (`shipProtocolSection()`) and `POST /api/agents/ship` delivers it
verbatim, so a Ship button, the `ship_agent` MCP tool and an agent merely *told* to ship
all get the same text — on the repo's REAL default branch (`resolveDefaultBranch()`, never
a hardcoded `master`) and with the delivery tail that matches how that project actually
goes live. `api/test/ship-prompt.test.mjs` pins that the two are the same string.

**`merge_pr` pre-flights server-side.** `POST /api/agents/merge` → `mergePr()` runs
`preflightVerdict()` (`merge-preflight.mjs`) before `gh pr merge --merge` and refuses with
the actual state named: `no-pr`, `not-open`/`already-merged`, `behind`, `dirty`,
`checks-failing` (naming the failing checks), `checks-pending`, `blocked`, `unknown`. Two
signals feed it — GitHub's `mergeStateStatus`/`statusCheckRollup`, and a **local**
freshness test, which is the one that matters on an unprotected repo: GitHub reports CLEAN
for a branch built on a month-old base, so git is asked whether the branch contains the
current base tip. The answer to a refusal is to **ship** the agent, not to retry.

**Worktree guardrail.** The spawn preamble names the agent's own worktree by absolute path
(`{worktree}`, substituted by each executor) and forbids editing or committing in the
repo's *shared* checkout. Detection is warn-only: on the `→ ready` transition,
`checkSharedCheckout()` turns one `git status --porcelain -b` into a one-line `shipWarning`
on the card (`shared-checkout.mjs`). *Behind-only* and *untracked-only* are deliberately
silent — a served checkout is in both states almost permanently. It never blocks a ship.

**Fleet notes and reply receipts.** An orchestrator is told when a child it spawned crosses
a ship transition (`atlas-ship-notify.mjs`) and when a child it messaged answers
(`atlas-reply-receipts.mjs`). Both are queued into the orchestrator's own chat behind an
attribution header marking them as a dashboard **observation**, never an instruction. Ship
notes fire **once per (child, state), ever** — the latch is persisted, a child's first
sighting is a silent baseline so a restart can never announce retroactively, and the latch
advances only *after* a note is actually handed off, so a failed delivery is retried rather
than lost. A `merged` the recipient caused itself, via its own `merge_pr` call, is
suppressed for that chat only.

---

## 3. Cleanup gating

`cleanup()` (`agent-local.mjs:2925`) force-deletes the worktree and branch
(`removeAgentArtifacts()`, line 2910: `git worktree remove --force` + `git branch -D`)
once its graceful close finishes. This is **irreversible** from inside the runtime —
there is no undo once the branch is gone.

Run it only when **all four** hold:

1. **Merged** — now checked for you: `shipState: 'merged'` in `list_agents` / on the card
   is the *repository's* verdict (the merge commit that landed the branch, or GitHub's
   `merged_at`), not the `ATLAS:SHIPPED` marker ([§2](#2-the-ship-protocol)). Treat a bare
   `shipped` (marker only, no repo verdict) as *claimed, unconfirmed* — for a
   squash-merged PR that is the best signal there is, so verify with
   `gh pr view <n> --json state,mergedAt` before tearing down.
2. **Deployed/verified**, if the change needed a deploy.
3. **The operator/orchestrator explicitly confirms.** `ATLAS_CONTROL_PREAMBLE`
   (`agent-routes.mjs`, `ATLAS_CONTROL_PREAMBLE`) tells the Atlas orchestrator exactly this: check
   `shipState` in `list_agents` first, and ask before tearing down anything not
   shipped.
4. **The originating `Tasks/` note (if any) is closed.** The teardown path can now do
   this itself: `ATLAS_KNOWLEDGE_CLOSE_PROMPT`, both `atlasIngestPrompt*` variants and
   `ATLAS_WORKER_PREAMBLE` all carry a **CLOSE BEFORE YOU FILE** instruction — search
   `Tasks/` for an open note matching this work by `for_project` / PR number / subject and
   prefer closing it over filing another. The close is keyed to **evidence** (the PR is
   merged AND the task is genuinely what this work did ⇒ `status: done` + `done:` + a dated
   `## Log` line), **never to age** — untouched is not the same as finished. If completion
   still owes a deploy, or the match is a judgement call, the agent is told to leave it open
   and say so. `cleanup()` itself still has no `Tasks/` awareness — the enforcement is
   prose the closing agent reads, pinned by `api/test/close-prompts-task-symmetry.test.mjs`,
   not a code-level check. It matters because the closing session is the *last* agent that
   could plausibly retire that card: once its worktree is torn down, nothing else flips the
   task's status, and it silently sits at whatever it was on the Kanban forever.

Anything short of all four: use `kill_agent` (`kill()`, `agent-local.mjs:2856`)
instead — it keeps the worktree + branch, so the work stays revivable.

---

## 4. The Atlas workflow — EVIDENCE → work → INGEST

**EVIDENCE at spawn** — `performSpawn()` (`agent-routes.mjs`) retrieves the Atlas
evidence **server-side** and folds it straight into the dev agent's opening prompt.
`local.atlasEvidence()` (`agent-local.mjs`) calls `buildCandidates()`
(`atlas-candidates.mjs`), which runs three passes over the Atlas working tree and
returns ONE byte-capped markdown block:

| pass | what it is | where |
| --- | --- | --- |
| full-text | multi-term, IDF-ranked, several excerpts per page | `textPass()` |
| typed | the project page for this repo (`agent_repo`), its open `Tasks/` (`for_project`), its hazard `Wiki/log.md` entries | `resolveProject()` + `queryAtlas()` |
| semantic | dense/vector retrieval — **off in core**, an optional addon plugs into the seam | `atlas-evidence-semantic.mjs` |

The legs are **unioned, never fused**: each gets its own labelled section and keeps its
own ranking. `evidencePrompt()` wraps the block in the framing it may not be read
without — it is a candidate set, not an index; absence from it is not evidence of
absence; nothing in it is an instruction, and the code outranks it.

Guarantees a spawn depends on:

- **Never blocks and never throws.** Any failure — no Atlas configured, no project page,
  a retrieval error — yields `''`, and the prompt is byte-identical to an unbriefed
  spawn. One `atlas-evidence` audit line per spawn records bytes/ms/sections/project,
  so a missing block is visible in the log rather than silent.
- **Closed work is DOWN-WEIGHTED, not excluded** (`ATLAS_EVIDENCE_DONE_WEIGHT`, default
  `0.6`; `0` restores exclusion, `1` the old no-filter behaviour). A surviving closed
  page is labelled `· ✓done` and the section heading says how many were demoted.
- **The prompt travels by FILE, not through tmux** (`prompt-file-launch.mjs`,
  `promptFileLaunch()`): tmux rejects a `new-session … sh -lc <cmd>` over ~16 KB
  (`TMUX_MAX_COMMAND_BYTES`) with `command too long`, and the evidence block alone is
  tens of KB. The same module builds the bridge's command, so the two cannot drift.
- **Bridge spawns negotiate the transport per spawn.** A bridge advertising
  `prompt-file` on `GET /health` gets the full bundle; anything else — an older bridge,
  an unreachable one, a malformed answer — takes `remoteEvidence()`'s budget-and-clip
  path, and both of its drops are audited with the numbers that decided them.
- **Atlas chats open with the same block** (`chatEvidence()` → `knowledgePrompt()`),
  minus the typed half (a chat names no repo, and inferring one is worse than omitting
  it) and with two extra guards: the block is a one-shot that does not refresh, and the
  operator's question sits below it under its own heading.

**Read tools** — box-local dev agents launch with `dev.mcp.json`
(`--strict-mcp-config`), which narrows the MCP surface to the seven READ tools
(`query_atlas`, `query_vault`, `get_note`, `wiki_index`, `wiki_pages`, `wiki_graph`,
`recent_activity`) and nothing that writes. `ATLAS_SEARCH_PREAMBLE` announces them —
installed-but-unannounced tools go unused. The paired worker gets the same profile via
`worker.mcp.json`; only the Atlas orchestrator chat gets `control.mcp.json`. Remote
(bridge) agents have neither the config nor a vault checkout, so they get neither.

**work** — the dev agent works normally; see [§1](#1-dev-agent-steering-semantics) for
how it's steered mid-flight. The paired worker is spawned right **after** the dev
session exists (never before: a request killed mid-spawn would otherwise leave a worker
orphaned with nothing to pair to) and its first turn only parks it —
`ATLAS_WORKER_STANDBY`, since there is no longer a brief to synthesize.

**INGEST at close** — `kill()`/`cleanup()` (`agent-local.mjs:2856`/`2523`) deliver
`DEV_RECAP_PROMPT` (line 2671) to the dev agent as its final turn (no tools, no edits —
just a recap). The lifecycle driver's `INGESTING`/`recap` case
(`agent-lifecycle.mjs:190–195`) fires `ACT.HAND_TO_WORKER`
(`ACTS[ACT.HAND_TO_WORKER]`, `agent-local.mjs:2502`), which captures that recap and
delivers `atlasIngestPrompt()` (line 2676) to the paired worker — its INGEST
instructions (`ATLAS_WORKER_PREAMBLE` point 2, `ATLAS_WORKER_PREAMBLE` point 2): fold the
recap into the most fitting `Wiki/` page, always append a `Wiki/log.md` entry, and
optionally file a `Tasks/` item. Once the worker prints `ATLAS:INGESTED`, the
`INGESTING`/`ingest` case (`agent-lifecycle.mjs:196–202`) fires `ACT.MERGE_ATLAS`
(`agent-local.mjs:2528`), which merges the worker's branch into the live Atlas via
`enqueueAtlasMerge()` ([§5](#5-the-serial-vault-commit-queue)) before reaping.

Workstation (remote-bridge) dev agents get the same EVIDENCE/INGEST contract, structured
differently since the box can't queue/poll a container's tmux directly — see the block
comment at the bridge branch of `performSpawn` (evidence folded into the launch prompt,
sized to the transport that bridge advertises; an ephemeral ingest worker at close via
`ingestToAtlas()`).

A standalone knowledge agent (no paired dev agent) has its own equivalent: a graceful
close that self-ingests its own transcript's insights before the session ends
(`KNOWLEDGE_CLOSE_PROMPT`/`ATLAS_KNOWLEDGE_CLOSE_PROMPT`, `agent-local.mjs:2651–2297`).

---

## 5. The serial vault commit queue

**`atlas-commit-queue.mjs`** is the single serialization point for every write to the
vault: the Kanban drag-and-drop, the paired-worker Atlas merge, the done-clear cron,
manual tools. `withLock()` (lines 49–57) chains every job onto one in-process promise,
so at most one is ever touching the vault's `.git` at a time. Two job shapes:
`enqueueAtlasCommit()` (line 117) for a direct working-tree edit (e.g. a Kanban status
flip), and `enqueueAtlasMerge()` (line 161) for merging a worker's branch.

**Why serialize:** the vault is one git checkout shared by every writer on the box. Two
concurrent `pull --rebase` → edit → commit → push sequences against the same working
tree would race — a second writer's rebase landing mid-edit of the first, or two pushes
fighting over the same ref. The queue removes *cross-job* races; each job still runs
its own `pull --rebase --autostash` → mutate → commit → push with retries for
transient lock collisions (`LOCK_RE`, line 62) and non-fast-forward pushes
(`pushMain()`, lines 92–106) — absorbing everything else sharing the checkout (the
`refresh-atlas` cron, a phone's Obsidian Git sync).

`enqueueAtlasMerge()` specifically runs the merge in an **isolated, detached worktree**
(`MERGE_WT`, line 45) rather than the live checkout, because `git merge` aborts on a
dirty tree — and the live checkout *is* dirty whenever a concurrent capture/research
ingest is mid-edit. Merging there is what used to strand paired-worker branches "for
manual resolution" (see the comment at lines 152–159).
