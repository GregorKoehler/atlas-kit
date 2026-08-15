/* ------------------------------------------------------------------ *
 * Tests for the PURE box-local agent lifecycle state machine
 * (api/src/agent-lifecycle.mjs).
 *
 * The transition table is pure — `decide(session, facts)` takes hand-built facts
 * (no tmux/git/transcript), so the whole machine is exercised here with no live
 * session. Coverage the task calls for:
 *   - idempotency: re-applying a transition (re-deciding from the state it lands
 *     in, with the same facts) is a no-op / re-derives the same step.
 *   - durable-fact gating: a transition fires ONLY when its durable fact holds
 *     (ship advances on the merged marker, not on a request alone).
 *   - crash recovery: the driver resumes correctly from ANY persisted state — for
 *     every state, decide() returns the right next step given facts.
 *   - the needs_attention sink: stuck flows route there and stay there.
 *   - legacy migration: old closing/closePhase/shipState map onto the new states.
 *
 * Run: node --test api/test/agent-lifecycle.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  S, ACT, decide, applyTransition, migrateSession, mirrorState, initLifecycle, isClosing, isInert, JOURNAL_MAX,
} from '../src/agent-lifecycle.mjs'

// A session fixture in a given lifecycle state with optional lc extras.
const sess = (state, lcExtra = {}, rest = {}) => ({
  id: 'x', kind: 'dev', repo: 'demo', shipState: undefined,
  lc: initLifecycle(state, lcExtra), ...rest,
})

// ── mirrorState ────────────────────────────────────────────────────
test('mirrorState maps the ship marker to the quiescent state', () => {
  assert.equal(mirrorState('ready'), S.SHIP_READY)
  assert.equal(mirrorState('shipped'), S.SHIPPED)
  assert.equal(mirrorState(undefined), S.WORKING)
  assert.equal(mirrorState('anything-else'), S.WORKING)
})

// ── spawned → working ──────────────────────────────────────────────
test('spawned advances to working once the launch lands (alive or transcript)', () => {
  assert.equal(decide(sess(S.SPAWNED), { alive: true })?.to, S.WORKING)
  assert.equal(decide(sess(S.SPAWNED), { alive: false, hasTranscript: true })?.to, S.WORKING)
})
test('spawned with no sign of life stays put (no spurious transition)', () => {
  assert.equal(decide(sess(S.SPAWNED), { alive: false, hasTranscript: false }), null)
})

// ── working ⇄ ship_ready ⇄ shipped (the mirror axis) ───────────────
test('working mirrors the durable ship marker', () => {
  assert.equal(decide(sess(S.WORKING), { shipState: 'ready' })?.to, S.SHIP_READY)
  assert.equal(decide(sess(S.WORKING), { shipState: 'shipped' })?.to, S.SHIPPED)
  // already mirrored → no-op (idempotent)
  assert.equal(decide(sess(S.WORKING), { shipState: undefined }), null)
  assert.equal(decide(sess(S.SHIP_READY), { shipState: 'ready' }), null)
  assert.equal(decide(sess(S.SHIPPED), { shipState: 'shipped' }), null)
})
test('ship_ready falls back to working when the agent un-signals ready', () => {
  assert.equal(decide(sess(S.SHIP_READY), { shipState: undefined })?.to, S.WORKING)
})
test('shipped re-signals ready for a follow-up task', () => {
  assert.equal(decide(sess(S.SHIPPED), { shipState: 'ready' })?.to, S.SHIP_READY)
})

// ── enter shipping (operator intent + train head) ──────────────────
test('a ship request only begins shipping when this member is the train head', () => {
  const reqHead = sess(S.SHIP_READY, { shipRequested: true })
  const d = decide(reqHead, { isShipHead: true, shipState: 'ready' })
  assert.equal(d?.to, S.SHIPPING)
  assert.equal(d.act, ACT.ENTER_SHIPPING)
  // not the head yet → wait (stays mirrored, no transition)
  assert.equal(decide(sess(S.SHIP_READY, { shipRequested: true }), { isShipHead: false, shipState: 'ready' }), null)
})
test('a ship request from plain working (no ready marker) still ships', () => {
  const d = decide(sess(S.WORKING, { shipRequested: true }), { isShipHead: true, shipState: undefined })
  assert.equal(d?.to, S.SHIPPING)
})
test('a ship request can re-ship an already-shipped session (parity with the old train)', () => {
  const d = decide(sess(S.SHIPPED, { shipRequested: true }), { isShipHead: true, shipState: 'shipped' })
  assert.equal(d?.to, S.SHIPPING)
  assert.equal(d.act, ACT.ENTER_SHIPPING)
})

// ── shipping: deliver, then gate the advance on the DURABLE merged fact ──
test('shipping delivers the ship prompt once, only when the session is free', () => {
  // busy / menu → hold off
  assert.equal(decide(sess(S.SHIPPING), { alive: true, busy: true, menu: false }), null)
  assert.equal(decide(sess(S.SHIPPING), { alive: true, busy: false, menu: true }), null)
  // idle + no menu → deliver (self-transition)
  const d = decide(sess(S.SHIPPING), { alive: true, busy: false, menu: false })
  assert.equal(d?.to, S.SHIPPING)
  assert.equal(d.act, ACT.DELIVER_SHIP)
})
test('durable-fact gating: shipping does NOT reach shipped without the merged marker', () => {
  // delivered, busy, marker has not advanced → stay (no premature "shipped")
  const s = sess(S.SHIPPING, { shipPromptedAt: '2026-06-30T00:00:00.000Z', shipSawBusy: true })
  assert.equal(decide(s, { alive: true, busy: true, shipMarkerAdvanced: false }), null)
})
test('shipping → shipped fires on the durable merged marker (PR merged)', () => {
  const s = sess(S.SHIPPING, { shipPromptedAt: '2026-06-30T00:00:00.000Z', shipSawBusy: true })
  const d = decide(s, { alive: true, busy: true, shipMarkerAdvanced: true })
  assert.equal(d?.to, S.SHIPPED)
  assert.equal(d.act, ACT.LEAVE_SHIP)
})
test('the merged marker wins even over a session that just died', () => {
  // shipMarkerAdvanced is checked before !alive — a confirmed merge is success.
  const s = sess(S.SHIPPING, { shipPromptedAt: '2026-06-30T00:00:00.000Z' })
  assert.equal(decide(s, { alive: false, shipMarkerAdvanced: true })?.to, S.SHIPPED)
})

// ── shipping → needs_attention (the sink) ──────────────────────────
test('shipping routes to needs_attention when it cannot confirm a merge', () => {
  const base = { shipPromptedAt: '2026-06-30T00:00:00.000Z' }
  // vanished mid-ship
  assert.equal(decide(sess(S.SHIPPING, base), { alive: false, shipMarkerAdvanced: false })?.to, S.NEEDS_ATTENTION)
  // backstop timeout
  assert.equal(decide(sess(S.SHIPPING, base), { alive: true, busy: true, shipTimedOut: true })?.to, S.NEEDS_ATTENTION)
  // idle after working the ship turn, no SHIPPED marker
  assert.equal(
    decide(sess(S.SHIPPING, { ...base, shipSawBusy: true }), { alive: true, busy: false, shipMarkerAdvanced: false })?.to,
    S.NEEDS_ATTENTION,
  )
  // idle past the start grace having never gone busy (a no-op ship)
  assert.equal(
    decide(sess(S.SHIPPING, base), { alive: true, busy: false, shipStartGraceElapsed: true })?.to,
    S.NEEDS_ATTENTION,
  )
})
test('shipping waits (no transition) while delivered-but-not-yet-busy within the grace', () => {
  const s = sess(S.SHIPPING, { shipPromptedAt: '2026-06-30T00:00:00.000Z' })
  assert.equal(decide(s, { alive: true, busy: false, shipMarkerAdvanced: false, shipStartGraceElapsed: false }), null)
})

// ── close flow: ingesting (recap → ingest → merge) ─────────────────
test('ingesting/recap waits while the recap turn is still running', () => {
  const s = sess(S.INGESTING, { closePhase: 'recap' })
  assert.equal(decide(s, { closeTurnDone: false, workerAlive: true }), null)
})
test('ingesting/recap hands the captured recap to a live worker', () => {
  const s = sess(S.INGESTING, { closePhase: 'recap' })
  const d = decide(s, { closeTurnDone: true, workerAlive: true })
  assert.equal(d?.to, S.INGESTING)
  assert.equal(d.act, ACT.HAND_TO_WORKER)
})
test('ingesting/recap with no live worker goes straight to reaping', () => {
  const s = sess(S.INGESTING, { closePhase: 'recap' })
  const d = decide(s, { closeTurnDone: true, workerAlive: false })
  assert.equal(d?.to, S.REAPING)
  assert.equal(d.act, ACT.REAP)
})
test('ingesting/ingest runs the merge as a self-step (act advances to ingested only on completion)', () => {
  const s = sess(S.INGESTING, { closePhase: 'ingest' })
  assert.equal(decide(s, { closeTurnDone: false }), null) // worker still ingesting
  const d = decide(s, { closeTurnDone: true })
  assert.equal(d?.to, S.INGESTING) // SELF — the act runs the slow merge then advances
  assert.equal(d.act, ACT.MERGE_ATLAS)
})
test('ingesting (knowledge / unpaired, no closePhase) reaps after the wrap-up turn', () => {
  const s = sess(S.INGESTING, {}, { kind: 'knowledge' })
  assert.equal(decide(s, { closeTurnDone: false }), null)
  const d = decide(s, { closeTurnDone: true })
  assert.equal(d?.to, S.REAPING)
  assert.equal(d.act, ACT.REAP)
})

// ── ingested → reaping → reaped ────────────────────────────────────
test('ingested marches to reaping then reaped (idempotent reap)', () => {
  assert.equal(decide(sess(S.INGESTED), {})?.to, S.REAPING)
  const reaping = decide(sess(S.REAPING), {})
  assert.equal(reaping?.to, S.REAPED)
  assert.equal(reaping.act, ACT.REAP)
  // Re-deciding from REAPING (a crash mid-reap) returns the same reap again.
  assert.equal(decide(sess(S.REAPING), {})?.act, ACT.REAP)
})

// ── the sinks don't move on their own ──────────────────────────────
test('needs_attention and reaped are inert (no autonomous transition)', () => {
  assert.equal(decide(sess(S.NEEDS_ATTENTION), { alive: true, shipState: 'ready', shipMarkerAdvanced: true }), null)
  assert.equal(decide(sess(S.REAPED), { alive: true }), null)
  assert.ok(isInert(S.NEEDS_ATTENTION) && isInert(S.REAPED))
  assert.ok(!isInert(S.WORKING))
})

// ── crash recovery: the driver resumes from EVERY persisted state ──
test('crash recovery: decide() yields a sensible step from every state', () => {
  // For each state, a plausible "mid-flow after a restart" fact set; assert the
  // driver picks the forward step rather than stalling.
  const cases = [
    [S.SPAWNED, { alive: true }, S.WORKING],
    [S.WORKING, { shipState: 'ready' }, S.SHIP_READY],
    [S.SHIP_READY, { shipState: 'shipped' }, S.SHIPPED],
    [S.SHIPPING, { alive: true, busy: false, menu: false }, S.SHIPPING], // re-deliver
    [S.INGESTED, {}, S.REAPING],
    [S.REAPING, {}, S.REAPED],
  ]
  for (const [from, facts, to] of cases) {
    const d = decide(sess(from), facts)
    assert.ok(d, `state ${from} should advance after a restart`)
    assert.equal(d.to, to, `state ${from} → ${to}`)
  }
})

// ── applyTransition: write-ahead journaling ────────────────────────
test('applyTransition sets the new state and appends a journal entry, returning the act', () => {
  const s = sess(S.SHIP_READY, { shipRequested: true })
  const d = decide(s, { isShipHead: true, shipState: 'ready' })
  const act = applyTransition(s, d, '2026-06-30T12:00:00.000Z')
  assert.equal(act, ACT.ENTER_SHIPPING)
  assert.equal(s.lc.state, S.SHIPPING)
  const last = s.lc.journal[s.lc.journal.length - 1]
  assert.deepEqual(last, { at: '2026-06-30T12:00:00.000Z', from: S.SHIP_READY, to: S.SHIPPING, fact: 'ship_requested' })
})
test('applyTransition caps the journal at JOURNAL_MAX', () => {
  const s = sess(S.WORKING)
  for (let i = 0; i < JOURNAL_MAX + 25; i++) {
    applyTransition(s, { to: i % 2 ? S.SHIP_READY : S.WORKING, fact: `f${i}` }, `t${i}`)
  }
  assert.equal(s.lc.journal.length, JOURNAL_MAX)
  // The OLDEST entries were dropped (the tail is the most recent).
  assert.equal(s.lc.journal[s.lc.journal.length - 1].fact, `f${JOURNAL_MAX + 24}`)
})

// ── legacy migration ───────────────────────────────────────────────
test('migrateSession: a live (un-closing) session mirrors its ship marker', () => {
  const a = { id: 'a', startedAt: 't', shipState: undefined }
  assert.ok(migrateSession(a))
  assert.equal(a.lc.state, S.WORKING)
  const b = { id: 'b', startedAt: 't', shipState: 'shipped' }
  migrateSession(b)
  assert.equal(b.lc.state, S.SHIPPED)
})
test('migrateSession: a paired dev mid-recap → ingesting/recap', () => {
  const s = { id: 's', startedAt: 't', closing: '2026-06-29T00:00:00.000Z', closePhase: 'recap', closingSawBusy: true }
  migrateSession(s)
  assert.equal(s.lc.state, S.INGESTING)
  assert.equal(s.lc.closePhase, 'recap')
  assert.equal(s.lc.closingAt, '2026-06-29T00:00:00.000Z')
  assert.equal(s.lc.sawBusy, true)
})
test('migrateSession: a paired dev mid-ingest → ingesting/ingest (carries ingestAt + cleanupOnClose)', () => {
  const s = {
    id: 's', startedAt: 't', closing: '2026-06-29T00:00:00.000Z', closePhase: 'ingest',
    closeIngestAt: '2026-06-29T00:05:00.000Z', cleanupOnClose: true,
  }
  migrateSession(s)
  assert.equal(s.lc.state, S.INGESTING)
  assert.equal(s.lc.closePhase, 'ingest')
  assert.equal(s.lc.ingestAt, '2026-06-29T00:05:00.000Z')
  assert.equal(s.lc.cleanupOnClose, true)
})
test('migrateSession: a closing knowledge chat → ingesting with no closePhase', () => {
  const s = { id: 's', kind: 'knowledge', startedAt: 't', closing: '2026-06-29T00:00:00.000Z' }
  migrateSession(s)
  assert.equal(s.lc.state, S.INGESTING)
  assert.equal(s.lc.closePhase, undefined)
  assert.ok(isClosing(s.lc.state))
})
test('migrateSession: an errored spawn parks at needs_attention', () => {
  const s = { id: 's', startedAt: 't', status: 'error', error: 'boom' }
  migrateSession(s)
  assert.equal(s.lc.state, S.NEEDS_ATTENTION)
})
test('migrateSession is idempotent (a second call is a no-op)', () => {
  const s = { id: 's', startedAt: 't', shipState: undefined }
  assert.ok(migrateSession(s))
  s.lc.state = S.SHIPPING // pretend the driver moved it on
  assert.equal(migrateSession(s), false)
  assert.equal(s.lc.state, S.SHIPPING) // untouched
})
