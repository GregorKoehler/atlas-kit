---
name: ship-protocol
description: Deterministic ship-and-close checklist for a dev agent's finished work. Use when you say "ship it", "ship via the protocol", "is it merged?", "clean up the agent(s)", or a fleet update reports READY-TO-SHIP. Walks ship → merge-verify → deploy → Atlas bookkeeping → gated cleanup, in that order — cleanup is gated on the Atlas task actually being closed, not just attempted.
---

# Ship protocol

Run the steps IN ORDER; never skip ahead to cleanup.

1. **State**: `mcp__atlas-kit__list_agents` for the agent's shipState;
   `mcp__atlas-kit__agent_transcript` to see what it actually did last — not what it said it
   would do.
2. **Ship**: if the agent hasn't shipped yet, `queue_agent`/`prompt_agent` it to ship via its
   protocol (commit, push, open the PR). Watch for the ship marker in the transcript.
3. **Verify MERGED, not just shipped**: confirm the actual merge commit in the target repo's
   git log, or the PR's merged state via `gh`. "READY-TO-SHIP", "PR opened", and a green
   transcript are NOT merged. `kill_agent` does not merge anything.
4. **Deploy**: deploys and service restarts are your call (dashboard deploy button,
   `serve.sh restart`, remote redeploy). If the change needs one, say so explicitly and wait
   for confirmation — never assume a merge is live.
5. **Verify live**: after deploying, check the change is really live where feasible (API
   health endpoint, feature visible, container tag). If it isn't verifiable, say so.
6. **Atlas bookkeeping**: set the matching `Tasks/` note(s) to `status: done` + `done: <date>`,
   bump `updated`; append the batch to `Wiki/log.md`; fold non-obvious insights into the
   relevant project page (`## Log` entry). Commit the Atlas changes (pull --rebase first).
7. **Cleanup LAST, and gated**: only when merged AND deployed/verified AND you explicitly
   confirm AND step 6's Atlas bookkeeping is actually done (re-check the `Tasks/` note —
   don't trust having run step 6 earlier in the session) — then `cleanup_agent` (recap →
   Atlas log, then deletes worktree + branch). If any of the four is missing, `kill_agent`
   (keeps worktree + branch) or leave the session and report what's still open. A task left
   open after cleanup has no agent left to close it — closing it is cheaper before the
   teardown than after.
