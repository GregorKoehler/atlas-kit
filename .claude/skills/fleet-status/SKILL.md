---
name: fleet-status
description: Scripted status pass over your agent fleet (dev + knowledge agents). Use when you ask "check on the agent(s)", "what's the status", "how's X going", "watch them", "any update?", or want a fleet overview with recommended next moves. Reads the live roster and real transcripts, verifies ship claims against git, reports one line per agent.
---

# Fleet status pass

Answer from the agents' ACTUAL state, never from their last claim. Steps, in order:

1. **Roster**: call `mcp__atlas-kit__list_agents` — sessions with id, kind, repo/vault, status,
   phase, task, context usage, queued counts, shipState.
2. **Transcripts**: for each agent you asked about (or every non-idle session on a general
   "check on the agents"), call `mcp__atlas-kit__agent_transcript` and read the tail before
   judging. Classify each agent as one of:
   - **WORKING** — mid-turn, making progress (say on what).
   - **IDLE-WAITING** — needs input; say exactly what it is waiting for.
   - **STUCK** — error loop, repeated failures, or no progress across turns.
   - **READY-TO-SHIP / SHIPPED** — claims its work is done or shipped.
   - **DEAD** — session gone or crashed.
3. **Verify ship claims**: READY-TO-SHIP ≠ merged. Before reporting anything as shipped or
   merged, confirm the merge commit in the target repo's git log (or the PR state via `gh`).
   `kill_agent` never merges anything.
4. **Report compactly**: one line per agent — name → true state → recommended next move.
   Lead with anything that needs you (a decision, a deploy, a ship button).
5. **Steering rules**:
   - Add context/instructions to a RUNNING agent with `queue_agent` (lands at next idle).
   - `prompt_agent` only for an agent that is already idle.
   - `interrupt_agent` only when an agent is clearly going wrong; announce in one line first.
6. **Cleanup gating (hard rule)**: `cleanup_agent` force-deletes the worktree AND the branch.
   Run it ONLY when the work is merged AND deployed/verified AND you explicitly said so AND
   the originating `Tasks/` note (if any) is flipped to `status: done` — all four. Check the
   task note itself; don't assume an earlier session already closed it. Anything less: use
   `kill_agent` (keeps worktree + branch, revivable) or leave the agent alone and say why —
   including "task not yet closed" as a named reason.
