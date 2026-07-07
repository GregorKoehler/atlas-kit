# Atlas Kit — runtime protocols

A concrete map of the conventions that govern how dev/knowledge agents are steered,
shipped, torn down, and coupled to the Atlas vault. Code references over prose —
read the cited source before relying on any of this, since line numbers drift.

---

## 1. Dev-agent steering semantics

The lifecycle is an explicit state machine, orthogonal to the momentary tmux-derived
`status` (running/idle/done/error): **`agent-lifecycle.mjs`** (`S`, lines 44–55) defines

```
spawned → working → ship_ready → shipping → shipped
                                                ↓
                               ingesting → ingested → reaping → reaped
```

plus a `needs_attention` sink for anything that can't make progress (a ship that never
confirmed its merge, a session that vanished mid-close). `decide()` (lines 140–222) is
the pure transition function; `agent-local.mjs`'s `driveSession`/`driveAll`
(~2227–2282) gather the facts (transcript markers, tmux busy/menu state) and run it
once per session per tick.

Five operations act on a live session, each with a different disruption profile:

| Action | Implementation | Behavior | Use when |
|---|---|---|---|
| **queue** | `queuePrompt()` — `agent-local.mjs:1789` | Appends to `s.queued` (a FIFO). `flushQueued()` (`agent-local.mjs:1978`), on a 3s timer (`QUEUE_FLUSH_MS`, line 146), delivers the FIFO head only once the session is alive, **idle** (no busy marker, no menu), and not the active ship-train head. | The agent is mid-turn; you want to add context without breaking its flow. The gentle default. |
| **prompt** | `prompt()` — `agent-local.mjs:1743` | Delivers immediately. Refuses with `409` if a choice menu (plan/permission) is pending, unless `force` is set — typing into a live menu would silently confirm the highlighted option. | The agent is already idle, waiting on you. |
| **interrupt** | `interrupt()` — `agent-local.mjs:1769` | Sends `Escape` (stops the in-flight turn, **keeps** the transcript), waits `INTERRUPT_SETTLE_MS` (400ms, line 145) for the TUI to settle, then delivers. Disruptive. | The agent is going wrong and must change course *now*. |
| **kill** | `kill()` — `agent-local.mjs:2454` | For a dev agent **without** a live paired Atlas worker (or on a second press), an immediate `tmux kill-session` — the worktree + `agent/<id>` branch are **kept** for review. For a dev agent **with** a paired worker (first press), closes gracefully: delivers `DEV_RECAP_PROMPT` (line 2309), moves the session to `ingesting/recap`, and lets the driver run recap → worker ingest → Atlas merge → reap. Never touches the git remote beyond killing tmux. | The agent's work is done or it was started in error, but you're not ready to delete its branch. |
| **cleanup** | `cleanup()` — `agent-local.mjs:2523` | Same graceful recap/ingest path as `kill`, but sets `s.lc.cleanupOnClose = true` so the final `REAP` act (`ACTS[ACT.REAP]`, ~2187) **also** calls `removeAgentArtifacts()` (line 2508) — `git worktree remove --force` + `git branch -D`. Irreversible from inside the runtime. | Only once the work is actually merged/abandoned — see [§3](#3-cleanup-gating). |

`abortClose()` (`agent-local.mjs:2570`) undoes a wrong kill/cleanup press — but **only**
while the session is still in `ingesting` (re-interrupts the recap/ingest turn and
restores the live lifecycle state). Once `ingested`/`reaping` have started (the Atlas
merge is running, or tmux is already dead) there's nothing left to call back.

---

## 2. The ship protocol

**Producer** — `RECONCILE_PREAMBLE` (`agent-routes.mjs:50–71`), appended to every
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
a ship is actively requested. Once enqueued (`enqueueShip()`, `agent-local.mjs:1869`)
and at the front of the serial ship train (`isShipHead()`, line 910), the `SHIPPING`
case (lines 166–185) delivers the ship prompt, then waits for the `ATLAS:SHIPPED`
marker to advance **past** a snapshotted baseline (the `ENTER_SHIPPING` act, ~2105) —
re-read from the on-disk transcript every tick, never an in-memory flag.

**`READY-TO-SHIP` means the agent opened/updated a PR and believes it's mergeable — it
does NOT mean anything merged.** Only a genuinely *new* `SHIPPED` marker (past the
ship's own baseline) is treated as evidence of a merge inside the lifecycle machine,
and even that is a self-report scanned from the agent's own text. `kill_agent`
(`kill()`, `agent-local.mjs:2454`) never merges, pushes, or opens anything — it only
kills tmux (and optionally asks for a recap) — so an agent being killed or cleaned up
is never evidence of a merge either. **The only real verification is external:**
`git log <branch>` or `gh pr view <n> --json state,mergedAt`.

---

## 3. Cleanup gating

`cleanup()` (`agent-local.mjs:2523`) force-deletes the worktree and branch
(`removeAgentArtifacts()`, line 2508: `git worktree remove --force` + `git branch -D`)
once its graceful close finishes. This is **irreversible** from inside the runtime —
there is no undo once the branch is gone.

Run it only when **all four** hold:

1. **Merged** — verified in `git log` / `gh pr view`, not assumed from the
   `ATLAS:SHIPPED` marker alone ([§2](#2-the-ship-protocol)).
2. **Deployed/verified**, if the change needed a deploy.
3. **The operator/orchestrator explicitly confirms.** `ATLAS_CONTROL_PREAMBLE`
   (`agent-routes.mjs:189–198`) tells the Atlas orchestrator exactly this: check
   `shipState` in `list_agents` first, and ask before tearing down anything not
   shipped.
4. **The originating `Tasks/` note (if any) is re-checked as `status: done` at cleanup
   time — not assumed from an earlier step.** The runtime code does **not** enforce
   this fourth gate; `cleanup()`/`cleanup_agent` has no awareness of `Tasks/` at all —
   it's an operator/orchestrator discipline, not a code-level check. It matters because
   the session running cleanup is the *last* agent that could plausibly close that task
   from inside the runtime: once its worktree is torn down, nothing else flips the
   task's status, and it silently sits at whatever it was (`doing`/`waiting`) on the
   Kanban forever — indistinguishable from an abandoned task.

Anything short of all four: use `kill_agent` (`kill()`, `agent-local.mjs:2454`)
instead — it keeps the worktree + branch, so the work stays revivable.

---

## 4. The Atlas workflow — BRIEF → work → INGEST

**Pairing at spawn** — `performSpawn()` (`agent-routes.mjs`, box-local branch
~617–644) spawns an Atlas **worker** alongside every box-local dev agent
(`spawnAtlasWorker()`, `agent-local.mjs:1541`), running `ATLAS_WORKER_PREAMBLE`
(`agent-routes.mjs:206–220`).

**BRIEF** — `briefAndQueue()` (`agent-local.mjs:1829`), fired in the background right
after spawn, waits for the paired worker's first (read-only) turn: the worker
traverses `Wiki/` per its BRIEF instructions (`ATLAS_WORKER_PREAMBLE` point 1,
`agent-routes.mjs:212`) and produces a short, cautions-first briefing. It then
**queues** that briefing to the dev agent (`queuePrompt()`, §1) so it lands at the dev
agent's first idle moment — never mid-turn. The dev agent is warned to expect this via
the "Atlas briefing incoming" heads-up injected at spawn (`agent-routes.mjs:628–630`).

**work** — the dev agent works normally; see [§1](#1-dev-agent-steering-semantics) for
how it's steered mid-flight.

**INGEST at close** — `kill()`/`cleanup()` (`agent-local.mjs:2454`/`2523`) deliver
`DEV_RECAP_PROMPT` (line 2309) to the dev agent as its final turn (no tools, no edits —
just a recap). The lifecycle driver's `INGESTING`/`recap` case
(`agent-lifecycle.mjs:190–195`) fires `ACT.HAND_TO_WORKER`
(`ACTS[ACT.HAND_TO_WORKER]`, `agent-local.mjs:2140`), which captures that recap and
delivers `atlasIngestPrompt()` (line 2314) to the paired worker — its INGEST
instructions (`ATLAS_WORKER_PREAMBLE` point 2, `agent-routes.mjs:214–216`): fold the
recap into the most fitting `Wiki/` page, always append a `Wiki/log.md` entry, and
optionally file a `Tasks/` item. Once the worker prints `ATLAS:INGESTED`, the
`INGESTING`/`ingest` case (`agent-lifecycle.mjs:196–202`) fires `ACT.MERGE_ATLAS`
(`agent-local.mjs:2166`), which merges the worker's branch into the live Atlas via
`enqueueAtlasMerge()` ([§5](#5-the-serial-vault-commit-queue)) before reaping.

Workstation (remote-bridge) dev agents get the same BRIEF/INGEST contract, structured
differently since the box can't queue/poll a container's tmux directly — see the block
comment at `agent-routes.mjs:460–469` (BRIEF folded into the launch prompt; an
ephemeral ingest worker at close via `ingestToAtlas()`, `agent-local.mjs:2334`).

A standalone knowledge agent (no paired dev agent) has its own equivalent: a graceful
close that self-ingests its own transcript's insights before the session ends
(`KNOWLEDGE_CLOSE_PROMPT`/`ATLAS_KNOWLEDGE_CLOSE_PROMPT`, `agent-local.mjs:2289–2297`).

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
