/* ------------------------------------------------------------------ *
 * Box-local agent LIFECYCLE state machine (the pure core).
 *
 * One explicit, journaled state machine replaces the old in-memory phase dance
 * in agent-local.mjs (the `closePhase`/`shipState`/`closing` flags, the
 * `reapClosing` flush loop, the `shipTrain` queue, and the inline Atlas
 * merge+reap). A single driver (`driveSession` in agent-local.mjs) advances each
 * session ONE step per tick, so "crash recovery" IS "keep driving" — there is no
 * separate recovery path.
 *
 * The lifecycle `state` is a NEW axis, ORTHOGONAL to the momentary tmux-derived
 * `status` (running/idle/done/error/dormant). A session can be status:'idle' +
 * state:'shipping' (idle, waiting to be handed the ship prompt) or status:'running'
 * + state:'ingesting' (busy writing its close-recap).
 *
 *   spawned → working → ship_ready → shipping → shipped
 *                                                   ↓
 *                                  ingesting → ingested → reaping → reaped
 *
 *   needs_attention — the sink for anything that can't make progress (a ship
 *   that ended without confirming its PR merged / timed out, a session that
 *   vanished mid-ship). Surfaced on the card; no autonomous exit (the operator
 *   re-ships / closes / revives).
 *
 * Two design rules make this crash-robust:
 *   1. WRITE-AHEAD — the new state is journaled + persisted BEFORE the side
 *      effect runs (applyTransition mutates s.lc; the caller persists, THEN runs
 *      the named act). A crash after persist re-runs the act; a crash before it
 *      re-derives the same decision next tick.
 *   2. DURABLE FACTS — transitions are gated on truth re-derived from disk each
 *      tick (the ATLAS:SHIPPED marker in the on-disk transcript = the PR merged;
 *      a clean Atlas branch merge; a finished close-turn), NOT an in-memory flag a
 *      crash would lose. `decide()` below is PURE — the caller (agent-local.mjs)
 *      gathers those facts via IO (tmux/git/transcript) and passes them in, so the
 *      whole transition table is unit-testable with hand-built facts.
 *
 * This module holds the DECISION (pure); agent-local.mjs holds the IO (fact
 * gathering + the named acts). Acts are referenced by string key so this file
 * never imports fs/tmux/git.
 * ------------------------------------------------------------------ */

// The lifecycle states. `reaped` is terminal-by-deletion: the registry entry is
// removed, so it never actually persists — it's the name of "gone".
export const S = {
  SPAWNED: 'spawned',
  WORKING: 'working',
  SHIP_READY: 'ship_ready',
  SHIPPING: 'shipping',
  SHIPPED: 'shipped',
  INGESTING: 'ingesting',
  INGESTED: 'ingested',
  REAPING: 'reaping',
  REAPED: 'reaped',
  NEEDS_ATTENTION: 'needs_attention',
}

// Named side effects (keyed so the pure table never touches IO). agent-local.mjs
// maps each to a handler in its ACTS table.
export const ACT = {
  ENTER_SHIPPING: 'enterShipping', // snapshot the ship-marker baseline before prompting
  DELIVER_SHIP: 'deliverShip', // type the ship prompt into the (idle) session
  LEAVE_SHIP: 'leaveShip', // drop from the ship train + clear ship bookkeeping
  HAND_TO_WORKER: 'handToWorker', // capture the dev recap → deliver the ingest prompt to the paired worker
  MERGE_ATLAS: 'mergeAtlas', // merge the worker's atlas branch + reap the worker (keep branch on conflict)
  REAP: 'reap', // kill tmux, (optionally) remove artifacts, record lifetime, delete the entry
}

// Cap the per-session journal so state.json can't grow without bound on a
// long-lived session that ships/closes many times.
export const JOURNAL_MAX = Number(process.env.AGENT_LC_JOURNAL_MAX || 40)

// The three live, non-closing, non-actively-shipping states whose lifecycle is
// just a MIRROR of the agent's own ATLAS ship marker (the self-signal the card
// already reads as `shipState`). Re-derived from the durable marker each tick.
const QUIESCENT = new Set([S.WORKING, S.SHIP_READY, S.SHIPPED])

// shipState marker ('ready'|'shipped'|undefined) → the mirrored lifecycle state.
export function mirrorState(shipState) {
  if (shipState === 'ready') return S.SHIP_READY
  if (shipState === 'shipped') return S.SHIPPED
  return S.WORKING
}

// A fresh lifecycle record. `journal` is append-only (capped); the rest of the
// fields (ship*/close*) are set by acts as the session moves through ship/close.
export function initLifecycle(state = S.SPAWNED, extra = {}) {
  return { state, journal: [], ...extra }
}

// Ensure `s.lc` exists, deriving it from the LEGACY flags on first load so live
// sessions spawned under the old machine continue cleanly (no stranding). No-op
// once `s.lc` is set (idempotent — safe to call every drive). Returns whether it
// created the record.
//
// Legacy → state mapping:
//   s.closing + closePhase:'recap'  → ingesting (closePhase recap)   [paired dev mid-recap]
//   s.closing + closePhase:'ingest' → ingesting (closePhase ingest)  [paired dev mid-ingest]
//   s.closing (no closePhase)       → ingesting (knowledge wrap-up)
//   else                            → mirror(shipState) for a live session
export function migrateSession(s) {
  if (s.lc && typeof s.lc === 'object' && s.lc.state) return false
  let lc
  if (s.closing) {
    lc = initLifecycle(S.INGESTING, {
      closingAt: typeof s.closing === 'string' ? s.closing : new Date(s.closing).toISOString(),
    })
    if (s.closePhase === 'recap' || s.closePhase === 'ingest') lc.closePhase = s.closePhase
    if (s.closeIngestAt) lc.ingestAt = s.closeIngestAt
    if (s.closingSawBusy) lc.sawBusy = true
    if (s.cleanupOnClose) lc.cleanupOnClose = true
  } else if (s.status === 'error') {
    // An errored spawn never entered the lifecycle; park it as needs_attention so
    // the driver leaves it alone (the card still shows status:'error').
    lc = initLifecycle(S.NEEDS_ATTENTION, { reason: 'spawn error' })
  } else {
    lc = initLifecycle(mirrorState(s.shipState))
  }
  lc.journal.push({ at: s.startedAt || new Date().toISOString(), from: null, to: lc.state, fact: 'migrated' })
  s.lc = lc
  return true
}

const T = (to, fact, act) => ({ to, fact, ...(act ? { act } : {}) })

/* ----------------------------------------------------------------- *
 * decide(session, facts) — the PURE transition function.
 *
 * Returns the single transition to apply this tick ({ to, fact, act? }), or null
 * to stay put. At most one step per call (the driver walks multi-step flows over
 * successive ticks). First matching rule wins.
 *
 * `facts` is gathered by the caller; the fields each state reads:
 *   common  : shipState, shipRequested, isShipHead, now
 *   spawned : alive, hasTranscript
 *   shipping: alive, busy, menu, shipMarkerAdvanced, shipTimedOut, shipStartGraceElapsed
 *   ingesting: closeTurnDone, workerAlive   (closePhase lives on s.lc)
 * Booleans that need wall-clock (timeouts/grace) are precomputed by the caller so
 * this function stays free of time math and trivially testable.
 * ----------------------------------------------------------------- */
export function decide(s, facts) {
  const f = facts || {}
  const lc = s.lc || initLifecycle(S.WORKING)
  const st = lc.state

  switch (st) {
    case S.SPAWNED:
      // The launch landed (tmux up, or a transcript already exists) → working.
      if (f.alive || f.hasTranscript) return T(S.WORKING, 'launched')
      return null

    case S.WORKING:
    case S.SHIP_READY:
    case S.SHIPPED: {
      // Operator asked to ship and it's this member's turn at the front of the
      // train → begin shipping (snapshot the baseline before we prompt). Allowed
      // from any quiescent state, including SHIPPED (re-ship / ship a follow-up) —
      // matching the old train, which delivered the ship prompt regardless of marker.
      if (lc.shipRequested && f.isShipHead)
        return T(S.SHIPPING, 'ship_requested', ACT.ENTER_SHIPPING)
      // Otherwise mirror the agent's own durable ship marker (working/ready/shipped).
      const want = mirrorState(f.shipState)
      if (want !== st) return T(want, `ship_marker:${f.shipState || 'none'}`)
      return null
    }

    case S.SHIPPING: {
      // DURABLE SUCCESS: the PR merged — the ATLAS:SHIPPED marker advanced past
      // the baseline we snapshotted. Re-read from the on-disk transcript each tick.
      if (f.shipMarkerAdvanced) return T(S.SHIPPED, 'pr_merged', ACT.LEAVE_SHIP)
      // The session vanished out from under the ship (reboot / kill) → flag it.
      if (!f.alive) return T(S.NEEDS_ATTENTION, 'ship_session_gone', ACT.LEAVE_SHIP)
      // Prompt not delivered yet: deliver it once the session is free (idle, no menu).
      if (!lc.shipPromptedAt) {
        if (!f.busy && !f.menu) return T(S.SHIPPING, 'deliver_ship', ACT.DELIVER_SHIP)
        return null // wait for the session to free up
      }
      // Prompt delivered — watch for completion or give up.
      if (f.shipTimedOut) return T(S.NEEDS_ATTENTION, 'ship_timeout', ACT.LEAVE_SHIP)
      if (f.busy) return null // still working the ship turn
      // Idle after the ship turn without a fresh SHIPPED marker (a conflict /
      // failed checks / nothing to merge), or idle past the start grace having
      // never gone busy → couldn't confirm the merge. Flag, don't silently drop.
      if (lc.shipSawBusy || f.shipStartGraceElapsed) return T(S.NEEDS_ATTENTION, 'ship_no_marker', ACT.LEAVE_SHIP)
      return null // delivered, not busy yet, within the start grace — keep waiting
    }

    case S.INGESTING: {
      const phase = lc.closePhase // 'recap' | 'ingest' | undefined (knowledge / unpaired)
      if (!f.closeTurnDone) return null // the close turn (recap / ingest / wrap-up) is still running
      if (phase === 'recap') {
        // Dev recap captured. Hand it to the paired worker if it's alive; else
        // there's nothing to ingest → straight to teardown.
        if (f.workerAlive) return T(S.INGESTING, 'recap_done', ACT.HAND_TO_WORKER)
        return T(S.REAPING, 'recap_done_no_worker', ACT.REAP)
      }
      if (phase === 'ingest') {
        // Worker finished ingesting → merge its atlas branch. This is a SELF step:
        // the act runs the (slow, network) merge and only THEN advances to
        // `ingested`, so a crash mid-merge re-runs the merge rather than skipping
        // it (the persisted `ingesting/ingest` IS the write-ahead marker). The act
        // keeps the branch + reaps the worker on a conflict, exactly as before.
        return T(S.INGESTING, 'ingest_done', ACT.MERGE_ATLAS)
      }
      // Knowledge chat / unpaired dev: the wrap-up turn is over → reap.
      return T(S.REAPING, 'wrapup_done', ACT.REAP)
    }

    case S.INGESTED:
      // Atlas branch merged → tear down (one-step marker; REAPING does the work).
      return T(S.REAPING, 'atlas_merged')

    case S.REAPING:
      // Kill tmux, record the lifetime, delete the entry. Idempotent: re-running
      // kill/delete is a no-op, so a crash mid-reap just reaps again next tick.
      return T(S.REAPED, 'reaped', ACT.REAP)

    case S.NEEDS_ATTENTION:
    case S.REAPED:
      return null // sinks — only an operator action (re-ship / close / revive) moves these
  }
  return null
}

// Apply a decision WRITE-AHEAD: append the journal entry and set the new state on
// s.lc. The caller persists() immediately after (before running the act). Returns
// the act key to run (or undefined). A same-state act (deliverShip) is journaled
// too so the transition trail is complete.
export function applyTransition(s, decision, atIso) {
  if (!s.lc) s.lc = initLifecycle(S.WORKING)
  const from = s.lc.state
  s.lc.journal.push({ at: atIso, from, to: decision.to, fact: decision.fact })
  if (s.lc.journal.length > JOURNAL_MAX) s.lc.journal.splice(0, s.lc.journal.length - JOURNAL_MAX)
  s.lc.state = decision.to
  return decision.act
}

// Whether a session is anywhere in the close/teardown tail — drives the card's
// `closing` spinner projection and the "don't flag it lost / don't re-park it"
// guards (agent-local.mjs). Covers the whole tail (ingesting → ingested →
// reaping) so the spinner stays up until the session actually vanishes, matching
// the old behavior where close ran reap inline. NOTE: only `ingesting` is
// abortable (the merge/reap that follow can't be undone) — callers that abort
// check the state directly, not this.
export function isClosing(state) {
  return state === S.INGESTING || state === S.INGESTED || state === S.REAPING
}

// Whether the driver should leave this session entirely alone (terminal sinks).
export function isInert(state) {
  return state === S.NEEDS_ATTENTION || state === S.REAPED
}

export { QUIESCENT }
