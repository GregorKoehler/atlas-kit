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
| **queue** | `queuePrompt()` — `agent-local.mjs` | Appends to `s.queued` (a FIFO). `flushQueued()`, on a 3s timer (`QUEUE_FLUSH_MS`), delivers the first entry **`queue-delivery.mjs` says it may** — the head at idle — see [§1a](#1a-when-a-queued-message-is-delivered). A menu, or being the active ship-train head, still holds everything. | The agent is mid-turn; you want to add context without breaking its flow. The gentle default. |
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
cannot drift). `decideDelivery` answers for ONE entry, off the message's `kind`;
`selectDelivery` is the scan around it — which entry of the whole queue goes out this
tick ([§1b](#1b-an-observation-is-only-true-when-it-was-made)):

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

## 1b. An observation is only true when it was made

An orchestrator can run one turn for hours while the dashboard keeps observing its
children, so a note written at 09:00 may not be *read* until 16:00 — by which time the
child it is about may be merged, torn down, or off on another turn. Four rules make the
queue account for that, all in the same shared `queue-delivery.mjs`:

- **It says when it was observed.** The producers stamp `observedAt` from their own
  injected clock (`diffShipNotes` / `diffReceipts` — never estimated later at delivery).
  Past `AGENT_NOTE_AGE_DISCLOSE_MS` (60 s) the delivery opens with `⏱ Observed at HH:MM, …`
  (`ageLine`); under it nothing changes, and a fresh single note is delivered
  **byte-identically** to before.
- **It is re-checked before it is typed.** `noteStaleReason` (pure) plus a `revalidate`
  callback `agent-routes.mjs` registers (`local.setNoteRevalidator`, fed the *same* roster
  snapshot that produced the notes) drops an observation whose child is gone, whose ship
  state has been overtaken, that the recipient merged itself, or whose `turn-end` child has
  started another turn. A later queued note about the same child supersedes an earlier one
  with no state at all. Every drop is **loud**: console + `agent-messages.jsonl`
  (`delivered: false`, `reason: "stale: …"`) + a `queue-stale` audit line.
  ⚠️ *Absent is not gone* — a child is only called gone once **unseen** for
  `AGENT_NOTE_GONE_GRACE_MS` (60 s ≈ 10 polls), so an unreachable bridge cannot silently
  drop notes about its live children; a child this process has never seen is never gone.
- **An idle-only entry no longer blocks the queue.** `selectDelivery` scans for the first
  entry the gate *allows*, so one parked `fleet-note` no longer holds every boundary-eligible
  message behind it. Order within a class never changes, at idle it is FIFO again, and menu /
  ship-train / `BOUNDARY_MIN_GAP_MS` are untouched (still `decideDelivery`, per entry). Both
  executors remove the delivered entry **by identity, never `shift()`**.
- **The idle drain is one wake-up.** Several surviving observations go out as ONE
  `⚙ Fleet digest` with a clock time per line, audited as `notes: N` on `queue-flush`.
  Boundary deliveries are never batched.

⚠️ The **attribution header stays first** in any rebuilt text (`msgProvenance.ts` anchors
`⚙ **Automatic fleet update` at the start), which is why a note is queued as `header` +
`note` pieces rather than one string; the steer fingerprint is re-taken whenever the
delivered string was rebuilt. ⚠️ A **`reply-receipt` is exempt** from revalidation and
batching — it answers a message its recipient actually sent, so it is delivered however
late and only gets the age line. `fleet-note` stays **idle-only**, and the latches,
`MAX_NOTES_PER_CHILD` and merge-claim suppression are unchanged — this sits on top of them.

On teardown (`kill` / `cleanup` / the lifecycle reap, and after a successful remote one)
`purgeNotesAbout(childId)` takes that child's undelivered observations out of every parent's
queue at once — one `queue-purge` audit line instead of N drops a tick later. Receipts
survive it.

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
suppressed for that chat only. Both carry the time they were **observed**, and both are
re-checked, aged and (for the observational ones) batched at delivery —
[§1b](#1b-an-observation-is-only-true-when-it-was-made).

---

## 3. Cleanup gating

`cleanup()` (`agent-local.mjs:2925`) force-deletes the worktree and branch
(`removeAgentArtifacts()`, line 2910: `git worktree remove --force` + `git branch -D`)
once its graceful close finishes. This is **irreversible** from inside the runtime —
there is no undo once the branch is gone.

**Gate 0 — is it even yours?** Checked *before* ship state, and the only one the
runtime enforces itself. `POST /api/agents/{kill,cleanup}` accept an optional `by` (the
calling chat's session id, stamped by the MCP `kill_agent`/`cleanup_agent` tools from
`ATLAS_SESSION`) and refuse with **403** when `by` is not the id that spawned the target —
`ownsChild()` in `agent-routes.mjs`, deliberately *narrower* than the message bus's
`messageAllowed()`: **own child only**, no parent and no siblings. A message is data the
recipient can weigh and ignore; a teardown is unilateral and irreversible.

- The refusal **names the owning chat**, because "not allowed" is useless to an
  orchestrator that has to explain itself to the operator.
- A session with **no** spawn parent is the **operator's** (started from the dashboard) —
  refused to a chat by default.
- **`by` absent means allowed.** The dashboard's ✕/⌦ send only `{id}`: that is the operator
  acting directly, and this scoping binds *agents*, never them.
- `scope: "any"` is the override for an explicit "clean up all of them", and every
  agent-initiated teardown — allowed, refused or overridden — appends a `teardown-scope`
  line to the same `audit.log`.

Pinned by `api/test/agent-teardown-scope.test.mjs`; the roster side (`spawnedBy` +
`yours: true` on `list_agents`) is what makes it visible before the call.

Beyond that, run it only when **all four** hold:

1. **Merged** — now checked for you: `shipState: 'merged'` in `list_agents` / on the card
   is the *repository's* verdict (the merge commit that landed the branch, or GitHub's
   `merged_at`), not the `ATLAS:SHIPPED` marker ([§2](#2-the-ship-protocol)). Treat a bare
   `shipped` (marker only, no repo verdict) as *claimed, unconfirmed* — for a
   squash-merged PR that is the best signal there is, so verify with
   `gh pr view <n> --json state,mergedAt` before tearing down.
2. **Deployed/verified**, if the change needed a deploy.
3. **The operator/orchestrator explicitly confirms.** `ATLAS_CONTROL_PREAMBLE`
   (`agent-routes.mjs`, `ATLAS_CONTROL_PREAMBLE`) tells the Atlas orchestrator exactly this:
   own it first (gate 0), then check `shipState` in `list_agents`, and ask before tearing
   down anything not shipped.
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
| semantic | dense/vector retrieval — **off in core**, supplied by an optional addon's `evidenceLeg` hook | `atlas-evidence-semantic.mjs` |

That third row is a **seam**, not a stub: `atlas-evidence-semantic.mjs` delegates to the
`evidenceLeg` of whichever addon supplies one (`addons/semantic-search` does) and answers
`available: false` with a reason when none does. `atlas-candidates.mjs` does not change
either way, and the addon's own leg is **additionally** gated on
`ATLAS_EVIDENCE_SEMANTIC=1` — read that addon's README before enabling it, the default
is off on the strength of its own measurement. See [ADDONS.md](ADDONS.md).

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

**Model backend** — a spawn (dev agent or knowledge chat) may carry an optional `provider`, naming a profile in
`providers.json` (`providers.mjs`) that points this agent's `claude` at an
Anthropic-compatible endpoint. It reaches exactly two places, both in `launchCommand()` /
`providerLaunch()` (`agent-local.mjs`): the profile's env is written to a `0600` file the
session's shell SOURCES and deletes before `claude` starts — **by file, like the launch
prompt**, because an argv is world-readable in `ps` (`tmux new-session -e` was the
obvious implementation and is not this one for exactly that reason) — and the launch
template's `{claudeEnv}` slot empties, because the profile owns `ANTHROPIC_API_KEY`
(explicitly empty, not `-u`-unset, or Claude Code can fall back to first-party auth).
`&&` not `;`, again like the prompt file: an unreadable env file stops the launch instead
of starting the agent on the backend the operator was moving off. With no profile the slot is the literal
`-u ANTHROPIC_API_KEY ` the templates used to hardcode and the line is byte-identical to
one from a kit without the feature. With a profile the model picker passes the TIER ALIAS
(`opus`/`sonnet`) rather than the resolved Anthropic ID, so the profile's
`ANTHROPIC_DEFAULT_<TIER>_MODEL` is what maps it — passing `claude-sonnet-5[1m]` would ask
the gateway for Anthropic's Sonnet. The five launch templates that a spawn or a revive can
carry a profile into all hold the `{claudeEnv}` slot (dev launch/resume, knowledge, Atlas
orchestrator launch/resume); the **paired Atlas worker** is the one that does not — it
takes no `provider` from anywhere and stays on the subscription backend, because it is the
vault's writer and nobody spawns it directly. A revive refuses rather than resume onto a
different backend. See [PROVIDERS.md](PROVIDERS.md).

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
optionally file a `Tasks/` item. One more convention rides along: when the project page
the work is logged against carries a typed `contribution_log:` edge, the worker appends
ONE high-level line (date, what, PR number) to the page that edge links — into the
section it belongs to, append-only, in the SAME write batch as the `Wiki/log.md` entry.
The operator-chatted Atlas orchestrator carries the same rule
(`ATLAS_KNOWLEDGE_PREAMBLE`) as the manual path. Once the worker prints `ATLAS:INGESTED`, the
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

---

## 5a. Union merge doubles a frontmatter key — and that silently deletes a card

🔴 The vault carries `*.md merge=union` (`.gitattributes`) — the setting that makes
`Wiki/log.md` and `Wiki/index.md` merge-safe, and it is **NOT** changed by any of this.
Union merge does not understand YAML: when two writers rewrite the SAME frontmatter line
— a worker recap's `related_prs:`, a dev agent's `ATLAS:NOW` line — git keeps **both**.
That is a duplicate YAML mapping key; `js-yaml` **throws** on it (it does not last-wins),
every frontmatter reader swallows the throw and returns `{}`, and the page goes **untyped
to every consumer at once**, silently: off the project cards, out of `query_atlas`, the
graph and every typed traversal — while rendering fine in Obsidian.

⚠️ **Writer idempotency cannot prevent this.** The MERGE creates the duplicate, from two
individually *correct* single-line writes — which is why [§9a](#9a-the-project-card-now-signal)'s
one-key rule is a third layer, not the fix. Two layers do the work, both in
**`api/src/frontmatter-heal.mjs`**, one policy module so they cannot drift:

**1. Self-heal after every pull/rebase/merge in the write path.** `syncMain()` (after its
`pull --rebase`) and `enqueueAtlasMerge()` — the latter repairing **before the merge is
pushed**, so the broken state never reaches `main` at all. Because *every* vault writer in
the kit funnels through this queue ([§5](#5-the-serial-vault-commit-queue)) — Kanban moves,
the done-clear cron, prospects approve, the `ATLAS:NOW` card rewrite, `seed-self-card`,
worker ingests — one hook covers all of them. The `.md` files that operation touched are
validated, and a doubled key is auto-resolved **loudly** (console + a `frontmatter-heal`
line in `audit.log`) and committed inside the same lock:

- **Scalar** live state (`now`, `status`, `updated`, `due`, …) keeps the **newest**
  occurrence — the max for date-shaped values (the only scalars with a real order), else
  the last, since union merge appends the incoming side.
- **Array** keys (`related`, `related_prs`, `tags`, `depends_on`, …) take the
  **order-preserving set UNION**. Dropping either side loses a writer's work, which is the
  failure the union-merge setting exists to prevent in the body. ⚠️ When one side already
  IS the union — the common case, a writer appended — its line is kept **verbatim**, so a
  repair is a minimal diff and never re-quotes a value it did not have to touch.
- A repair is **pushed even when the caller's own edit was a no-op** (`enqueueAtlasCommit`
  returns `repaired`): an unpushed repair leaves every other checkout broken.

**2. Reader fallback.** `read-routes.mjs`'s one shared `frontmatter()` goes through
`loadFrontmatter`, which resolves duplicates in memory with the same policy and re-parses
— so a card stays rendered, reading exactly what the repair is about to write, through the
window between the merge and the repair. Applied at the shared reader rather than in
`listProjects` alone, since every caller there routes through it.

⚠️ A healthy page is **byte-identical** on both layers: the fallback only runs once the
strict parse has already failed, and `healFrontmatter` returns `null` when nothing is
doubled. ⚠️ Damage that is **not** a duplicate key still degrades to `{}` exactly as
before — but is now **logged**, not silent. ⚠️ A **block** list (`tags:` with `- item`
lines) never needs repair: only the key's own line conflicts, so union merge already unions
those correctly.

⚠️ Skipped: `atlas-query.mjs` keeps its own frontmatter reader and its own `{}`-on-throw.
The self-heal reaches it within one write-path op; adopt `loadFrontmatter` there if a typed
query is ever seen missing a page in between.

Guarded by `api/test/frontmatter-union-heal.test.mjs`, which **reproduces the union merge
with real git** and drives the real `enqueueAtlasMerge` / `enqueueAtlasCommit` paths against
throwaway bare-origin vaults carrying the vault's own `.gitattributes` — a hand-typed
double would prove the parser throws, not that the thing we ship happens.

---

## 6. Bridge resilience — reachable, stale, and how many slots are left

A **bridge** (`agent-bridge/server.mjs`) is a copy of this repo running host-native on
another machine; the box drives its dev containers over HTTP. Everything below exists
because a bridge box is normally *not* a dedicated agent host — it may also be running
your production stack, a CI runner and per-PR preview containers — so it is exactly the
machine that gets saturated, and a saturated machine cannot answer.

**Unreachable is NOT empty.** `bridge-roster.mjs` remembers the last roster each bridge
successfully answered with, and persists it (the API restarts far more often than an
outage lasts). `GET /api/agents` then carries, per bridge:

| field | meaning |
| --- | --- |
| `reachable` | did it answer this poll (after hysteresis)? |
| `stale` | present only while `reachable` is being held true off a *cached* poll |
| `lastSeen` | ISO time it last really answered — present only while unreachable |
| `staleSessions` | the roster it last answered with — present only while unreachable |
| `capacity` | how much room that box has for another agent (below) |

`staleSessions` is **never merged into `sessions`** and never counted as live. That
separation is the whole point: a silent bridge's agents are almost always still running,
and drawing "nothing" for them reads as "my agents were killed". `lastKnownRoster()`
returns `{at, sessions: []}` for *answered with zero* and `null` for *never heard from* —
collapsing those two is the bug this module exists to prevent.

**Hysteresis.** `resolveBridgePoll()` (`agent-routes.mjs`) serves the last-known-good
sessions, marked `stale`, through up to `AGENT_BRIDGE_STALE_FAILURES` consecutive failed
polls *and* at most `AGENT_BRIDGE_STALE_MAX_MS` since the last success — whichever comes
first. Past either bound it flips to `reachable:false, sessions:[]`, the old
unconditional-drop behaviour, just delayed past a single blip. ⚠️ Phase tracking
(`trackRemotePhases`) is fed the **raw fresh** sessions, never a stale replay: a poll that
only *looks* reachable via hysteresis must not accrue run time for agents nobody re-observed.

**Reap grace.** A remote shadow that vanishes from one poll is not closed. It must stay
absent for `AGENT_REMOTE_REAP_GRACE_MS`, and it is then closed **at its last observation**,
not at `now` — the grace window is the box's uncertainty about the bridge, never the
agent's working time. Paired with `agent-timings.mjs`'s spawn-anchor window
(`AGENT_PHASE_ANCHOR_MAX_AGE_MS`) and run clamp (`AGENT_RUN_MAX_MS`), this is what stops a
recreate/reap cycle re-billing a session from its spawn on every poll.

**Capacity — one rule, three gates.** `agent-capacity.mjs` holds the arithmetic, and all
three callers import it rather than re-deriving it:

1. `agent-local.mjs` — the box-local spawn/revive paths (unchanged behaviour, no swap charge)
2. `agent-routes.mjs` — the remote spawn path, on what the bridge reports on `/health`
3. `agent-bridge/server.mjs` — the bridge refusing on its own box, before it creates anything

It reads `MemAvailable` (never `MemFree`: a busy box is full of reclaimable cache) and, on
a bridge, **charges swap-in-use against availability** — an idle agent's anonymous pages are
cold, but the moment it takes a turn they must fault back in. Every refusal carries the
numbers that produced it. `capacity.slots` is how many more agents that box will admit
right now, surfaced through `list_agents` so an orchestrator reads the limit *before* it
hits one. ⚠️ The remote gate **fails open** on a bridge that reports no capacity — bridge
code only reaches a machine when that machine is redeployed, so failing closed would be a
fleet-wide spawn outage — but never silently: the console says so and the audit line carries
`capacity: 'unreported'`.

**Redeploy.** `POST /api/agents/bridge-redeploy {label?}` proxies to that bridge's own
`POST /redeploy`, which runs `scripts/restart-agent-bridge.sh` — the same script an operator
runs by hand — inside a transient `systemd-run` unit. That escape is load-bearing: a plain
detached child stays in the bridge's own cgroup, and the script's `systemctl restart` would
SIGTERM it mid-flight. An unknown label is a 404 naming the configured labels and **never** a
silent fall back to the default — redeploying the wrong machine is the one dangerous failure
this surface has. `GET /api/agents/bridge-status?label=` reports reachability, running SHA,
commits behind, and the redeploy phase.

**Keep-alive.** The bridge holds an idle socket for `BRIDGE_KEEPALIVE_TIMEOUT_MS` (60 s, vs
Node's 5 s default), because the box's Atlas retrieval runs in-process for tens of seconds
*immediately before* it POSTs `/spawn` on a pooled socket. ⚠️ `headersTimeout` must stay
above `keepAliveTimeout` or the race comes straight back.

---

## 7. The agent↔agent message bus

`agent-msg <agent-id> "<text>"` is on every dev agent's PATH. It is **async mail, not RPC**:
the message is queued to the recipient and the sender continues; a reply is just another
message in the other direction.

- **Auth** is a per-session scoped token (`msgToken`), injected into the agent's launch env
  by its executor. Deliberately *not* `DASHBOARD_BEARER_TOKEN` — an agent holding that could
  spawn and kill the whole fleet. The token is only valid while the session is in the
  registry, so killing an agent revokes it.
- **Lineage** bounds who may write to whom: parent, child, or a sibling under the same
  parent (`messageAllowed()`, from the persisted `spawnParent` map). `SYSTEM_SENDER`
  (`system:fleet`) is exempt by identity, and that identity is unforgeable — a session id is
  a strict `[a-z0-9-]` slug that can never contain the `:`.
- **Budget**: a rolling per-ordered-pair cap (`AGENT_MESSAGE_PAIR_MAX` per window).
  Exhaustion is a 429 the *sending agent reads*, never a silent drop.
- **Delivery** reuses `queuePrompt`, so the message becomes a real user turn, tagged
  `kind:'agent-msg'` — a boundary kind (see §1a), so it lands at the recipient's next
  tool-call boundary rather than waiting out a long turn.
- **The log** (`agent-messages.jsonl`) is the JOIN the transcripts lack: a delivered message
  is indistinguishable from any other user turn once it is in the recipient's transcript,
  with no from/to on it. Rejections are logged too, with a reason — a bounced message is
  exactly the thing that must not vanish. `GET /api/agents/messages` reads it back.
  ⚠️ `delivered: true` means *handed off*, not *read*.

**The remote half.** The box's API is loopback-bound, so a container agent posts to its own
bridge instead. The bridge parks the attempt, the box drains `POST /outbox` on the remote
poll it already runs, decides it with the **same** `deliverAgentMessage()`, and posts the
verdict back — so the sending agent gets a real 403/429/200. The bridge decides nothing
except *who sent it*, resolved from the session token; the box independently re-checks that
the id is a live session **on that bridge**. A bridge with no `/outbox` 404s once and is then
backed off — its agents were spawned without a token anyway.

**Remote Atlas queries ride the same channel.** A box-local dev agent gets the seven vault
read tools as MCP tools; a container agent behind a bridge cannot, so it runs `atlas-query
<tool> '<json>'`, which is parked and drained identically. `atlas-query-relay.mjs` executes
it in-process through `buildServer({knowledgeOnly:true})` over an in-memory MCP transport —
so the reachable surface is the knowledge-only profile *by construction*, the zod schemas
validate the remote agent's arguments at the trust boundary, and no second dispatch table can
drift. Bounded three ways (tool allowlist, per-session query budget, hard result cap) and
logged to `atlas-queries.jsonl`: this is the one path by which vault content leaves the box.
No new listening socket — the box→bridge direction was never blocked.

---

## 8. Task prospects — propose, don't file

Agents notice follow-up work while doing something else. Left to file it themselves they
inflate the board with work nobody chose, so both the dev preamble and the knowledge
preamble tell them to **propose** instead: `POST /api/prospects/new` (bearer-gated), or the
`propose_task` MCP tool.

`atlas-prospects.mjs` stores proposals **outside the vault**, in a server-side `.state` file —
the same discipline as `atlas-type-flags.mjs`. That is what guarantees a rejected prospect
never touches the vault, not even transiently.

- `POST /api/prospects/approve {id, edits?}` writes the real task through `createTask()` —
  the *exact* `/api/tasks/new` path, so an approved prospect gets normal frontmatter, typed
  edges and `source:` provenance, and there is only ever one task-writing path. It is retired
  from the queue only after the commit actually lands.
- `POST /api/prospects/reject {id}` discards it.
- Both stamp a **sticky decision** keyed on the producer's `sourceKey`, so an agent that
  re-notices the same thing on a later run cannot re-propose something already dismissed.
- `GET /api/prospects` is the open read the review card polls.

`propose_task` is registered under its own `ATLAS_MCP_PROPOSE` flag rather than joining
`KNOWLEDGE_TOOLS`, because `knowledgeOnly` is the same flag the remote HTTP connector runs
under — and a connector has no business proposing work into the operator's inbox. The dev and
worker MCP configs set it; `mcp/http.mjs` passes `propose: false` outright.

---

## 9. Agent downloads — offering the operator a file

Any agent (dev or knowledge, box-local or on a bridge) can hand the operator a file: it
writes or copies it into a **per-session downloads directory**, and a chip appears on its
card. `DOWNLOADS_PREAMBLE` (`api/src/agent-routes.mjs`, overridable via
`AGENT_DOWNLOADS_PREAMBLE`) is appended to *every* agent's standing instructions and
carries a `{downloadsDir}` token that each **executor** substitutes at spawn — the same
per-location split as `{statsFile}` and `{appAddress}`:

| Executor | Directory | Pre-created at |
|---|---|---|
| box-local (`agent-local.mjs`) | `$AGENT_LOCAL_DIR/downloads/<id>` (default `~/.atlas-kit/downloads/<id>`) | `spawn()` / `spawnKnowledge()` |
| bridge (`agent-bridge/server.mjs`) | `/tmp/agent-downloads/<id>` inside the container | `spawn()` |

The listing is re-read fresh on every poll (there is no history to accumulate, unlike live
stats): files only, **dotfiles and subdirectories skipped**, newest first, capped at
`AGENT_DOWNLOADS_MAX_FILES` (20). It rides out on each session's `downloads` field and is
simply absent when empty. Overwriting a filename republishes it; a new filename adds a
chip. Cleanup removes the directory with the worktree and the stats file.

**`GET /api/agents/download?id=&name=`** serves one file. Two safety rules, both enforced
on each executor:

1. `name` must **equal its own basename** — that single check rejects `../` traversal,
   absolute paths and any embedded separator. It is *not* decoded again: Express's query
   parser (and the bridge's `URLSearchParams`) already decoded once, and a second decode
   would mangle a filename containing a literal `%`.
2. `name` must appear in the **current capped listing** — so a dotfile, which the listing
   skips, is never resolvable — and be under `AGENT_DOWNLOAD_MAX_BYTES` (100 MB, else 413).

A **bridge** session has no on-box file, so the route pipes raw bytes from the bridge's own
`GET /download`. That proxy is deliberately a bare `node:http` request, **not** `callBridge`
— `callBridge` JSON-parses every response and would corrupt any binary. For the same reason
the bridge streams the file with a direct `docker exec … cat` piped to the socket rather
than through `dockerExec`, whose `execFile` stdout is utf8-decoded.

### The chip must never strand the operator

The dashboard ships as a PWA with `"display": "standalone"`, so once it is installed to a
home screen it runs in a **chrome-less webview — no URL bar, no back button**. A plain
`<a href download>` pointing at a `Content-Disposition: attachment` response *navigates*
that single webview, and mobile WebKit then replaces the whole app with its
non-renderable-content shim. There is no way back except killing and relaunching the app,
and the operator never even sees the file.

⚠️ **`target="_blank"` is not the escape it looks like.** The first cut of this rescue kept
images in an in-app overlay and left every other type on `download` + `_blank`, betting
that `_blank` would open a dismissible browser overlay. On a real installed PWA it does
not: an `.html` and a `.txt` each navigated the app's one webview and stranded it. A new
browsing context *is* a top-level navigation there.

So the rule is now an invariant, not a split, and it lives in one pure function —
`downloadRoute(file, env)` in `web/src/lib/downloads.ts`:

- **An anchor is allowed only where it is PROVEN safe** — `downloadHonoured && !standalone`.
  Desktop keeps the real download it always had; everything else opens **in-app**, whatever
  the file type. No UA sniff, no `target`, no escape hatch. `api/test/agent-downloads.test.mjs`
  asserts the attribute cannot come back.
- **The overlay renders every type** (`previewKind`): a real `<img>` for images, a
  **sandboxed `srcdoc` iframe** for HTML (`allow-scripts` *without* `allow-same-origin` —
  an agent-authored report is untrusted; omitting `allow-top-navigation`/`allow-popups` is
  what makes the invariant structural), decoded text in a `<pre>`, and a name/size panel
  for anything else. All three are *subresource* renders, so the attachment disposition is
  ignored and no server change is needed. Over `INLINE_MAX_BYTES` (4 MB) text and HTML fall
  back to the panel; an image renders from its URL at any size.
- **Save** (`plan.save`): the plain `<a download>` wherever it is honoured — an anchor
  outranks the share sheet, since a share dialog on desktop would be a regression — else
  `navigator.share({files})`, else (an image) long-press, else a stated dead end. The blob
  is prefetched when the overlay **opens**, never in the Save handler: `share()` needs the
  tap's transient activation and an `await` inside the handler spends it.
- The overlay pushes a history entry so the system back gesture closes it instead of
  exiting the PWA, and it is dismissible four ways (back, Escape, ✕, backdrop).

⚠️ Do **not** add `-webkit-touch-callout: none` or `user-select: none` to `.dlprev__img` —
a real `<img>` keeps long-press → "Save Image", the one save route that needs neither
`download` nor the share sheet.

### Spawn attachments

The reverse direction: a spawn (dev **and** knowledge/Atlas) may carry base64 `images` —
any file type, not just images. They are validated once, above the kind branch, against
`AGENT_MAX_IMAGES`; the executor saves them under `uploads/<id>` **after** the session id is
resolved and **before** anything is registered or launched (so a bad attachment fails fast
leaving nothing behind), and folds their absolute paths into the opening prompt as a
single-line tail telling the agent to `Read` them first.

---

## 9a. The project-card NOW signal

A **box-local** dev agent can refresh its project card's "Now" line by ending a reply with
`ATLAS:NOW <one line>`. `CARD_PREAMBLE` (`api/src/agent-routes.mjs`, overridable via
`AGENT_CARD_PREAMBLE`) is the producer; `NOW_MARKER` / `scanNowMarker`
(`api/src/subagent-scan.mjs`) is the consumer — **assistant text only, own line only,
latest wins**, the same discipline as the ship markers ([§2](#2-the-ship-protocol)), and
both walks now share one `scanAssistantText` so they cannot drift. `agent-local.mjs`'s poll
fires `applyCardNow` *off* the poll path once per new value, and `project-card.mjs` resolves
the page by `agent_repo` and rewrites `now:` inside the serial commit queue
([§5](#5-the-serial-vault-commit-queue)).

**Box-local only**, twice over: `CARD_PREAMBLE` is absent from `remotePreamble`, and the
bridge imports `scanShipMarker` but not `scanNowMarker`. The box owns the vault; a
workstation agent's write would have nowhere to land.

**Only `now` is agent-writable.** `goal:` is operator-owned — it is also the card's
membership opt-in (`listProjects`), so an agent able to write it could invent cards.

**⚠️ The rewrite is IDEMPOTENT by construction.** The vault uses `*.md merge=union`, which
does not understand YAML: two sides each carrying a *different* `now:` line for the same
page (a paired-worker branch merged by `enqueueAtlasMerge`, a phone sync racing the queue's
rebase) leave **both** — and a page with two `now:` keys stops round-tripping through
js-yaml, so the card untypes and disappears off the dashboard. `rewriteNow` therefore
replaces the first `now:` in place and **drops every later one**, and never appends. Because
a doubled page is invisible to `listProjects` (it no longer parses), `findProjectPage` falls
back to a raw-frontmatter scan for exactly that case — otherwise the repair would be
unreachable precisely when it is needed. `api/test/project-card-now.test.mjs` is the pin.

This covers only the one key `rewriteNow` writes. The general fix — every key, every
writer, plus a reader that survives the window — is [§5a](#5a-union-merge-doubles-a-frontmatter-key--and-that-silently-deletes-a-card).

---

## 10. Optional addons — the seams core exposes

`api/src/addons.mjs` is the entire framework: an addon is a directory under
`addons/<name>/` whose `api/register.mjs` returns a manifest of hooks. Enablement is
`ATLAS_ADDONS` (comma list, **wins whenever DEFINED** — empty means none) or the
gitignored `addons.json`. Full model, hook contracts and how to write one:
**[ADDONS.md](ADDONS.md)**.

The invariant the code is arranged around: **with zero addons enabled, every response
is byte-identical to a kit that never had the framework.** It is what
`api/test/addons-framework.test.mjs` asserts first, before anything is loaded.

| seam | core side | what an addon gets |
| --- | --- | --- |
| boot | `server.mjs` `await loadAddons()` then `app.use(addonRouter())`, **last** | its routes mounted where they cannot shadow a core route; `GET /api/addons` |
| search | `read-routes.mjs` `searchAllLegs()` | a second retriever in `legs[]` — `items` (BM25F) untouched |
| MCP | `mcp/tools.mjs` — `addonMcpTools()`, and `capLegs()` bounds the answer | read-only tools, **excluded from the knowledge-only surface** by design |
| spawn evidence | `atlas-evidence-semantic.mjs` delegates; `atlas-candidates.mjs` does not change | `evidenceLeg` — at most one addon, since the block renders one labelled section |
| scorecard | `read-routes.mjs` `scorecardData()` joins at READ time | `scorecardStats()` — one writer per file, so an addon never writes `data/scorecard.json` |
| cron | `scripts/addon-cron.mjs --install` → `/etc/cron.d/atlas-kit-addons` | declared entries, regenerated (never hand-edited) from what is enabled |

🔴 **The legs are UNIONED, NEVER FUSED** — on `/api/search` exactly as in the evidence
block (§4). No router, no reciprocal-rank fusion, no blended ranking. Measured on the
semantic leg, RRF took MRR from 70.4% to 23.8%: averaging destroys provenance, and it
hides the honest abstention signal *"full-text 0 hits · semantic 24 hits, top similarity
0.31"*.

🔴 **A broken addon may never cost you the dashboard.** A missing directory, an import
that throws, a `register()` that throws, a hook that throws — each is recorded in
`GET /api/addons`'s `errors[]` and skipped. A search leg that throws degrades to
`available: false` with a reason while the full-text leg still answers.
