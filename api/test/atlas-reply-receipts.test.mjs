/* ------------------------------------------------------------------ *
 * Tests for the reply-receipt / turn-end core (atlas-reply-receipts.mjs) — the
 * pure arm / observe-delivery / fire-on-edge / spend decision, driven without
 * tmux.
 *
 * The feature exists because a parent chat could message a child it spawned and
 * never learn it had answered (fleet notes carry ship state only, and those
 * states are terminal-latched). The RISK it carries is the mirror image: "idle"
 * is true on every tick, so anything state-keyed here re-fires forever — the
 * in testing fleet-note flood. Hence the acceptance criteria below, straight off
 * the task page:
 *
 *  - a child nobody spawned pings NEVER;
 *  - one message + ten idle observations = exactly ONE ping;
 *  - three messages before one idle = ONE ping (they collapse);
 *  - after spending, the next message arms again;
 *  - and the ship-note path is untouched by all of it.
 *
 * an earlier change adds the two the live in testing failure demanded:
 *  - a BLIP at delivery (the pane's busy marker vanishing for a beat while the
 *    turn runs on) must fire NOTHING — we read the DEBOUNCED phase, not status;
 *  - a turn end with no message outstanding must still reach the spawning chat
 *    exactly once, on both executors.
 *
 * Run: node --test api/test/atlas-reply-receipts.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createReceiptState,
  armReceipt,
  diffReceipts,
  receiptText,
  turnEndText,
  receiptParent,
  MAX_TURN_NOTES_PER_CHILD,
} from '../src/atlas-reply-receipts.mjs'
import { diffShipNotes } from '../src/atlas-ship-notify.mjs'
import { BOUNDARY_KINDS, classifyKind } from '../src/queue-delivery.mjs'

// A roster row as both executors publish it: box-local publicView stamps `phase`
// from agent-timings' trackPhase, and agent-routes mirrors the same field onto a
// remote bridge session from its shadow (PHASE_FIELDS). `status` is deliberately
// NOT set by these helpers — nothing in this module may read it again.
const child = (phase, o = {}) => ({ id: 'c1', kind: 'dev', repo: 'demo-app', task: 'fix the thing', phase, ...o })
// The same child while a message sits parked in its queue (undelivered).
const parked = (phase, o = {}) => child(phase, { queued: [{ text: 'spec', at: '2027-01-15T09:00:00.000Z' }], ...o })
const T0 = 1_800_000_000_000

// Feed a roster snapshot through the state, adopting the result the way the
// route's applyReplyReceipts does. Returns the lines that fired this tick.
function tick(state, sessions, now = T0, parentOf = () => undefined) {
  const { due, pending, seen, turns } = diffReceipts(state, sessions, parentOf, now)
  state.pending = pending
  state.seen = seen
  state.turns = turns
  return due
}
function arm(state, childId = 'c1', parentId = 'orch', at = T0, by = 'parent') {
  state.pending = armReceipt(state, { childId, parentId, at, by })
}
// The lineage the routes look up: c1 was spawned by the chat 'orch', c-orphan by
// nobody (the operator started it straight from the dashboard).
const parentOf = (id) => ({ c1: 'orch' })[id]
// A child with no spawn parent at all — the unsolicited path must stay silent.
const noParent = () => undefined

test('a child nobody spawned pings never — however often it idles', () => {
  const s = createReceiptState()
  assert.deepEqual(tick(s, [child('run')], T0, noParent), [])
  for (let i = 0; i < 10; i++) assert.deepEqual(tick(s, [child('wait')], T0, noParent), [])
})

test('one message + ten idle observations = exactly one receipt', () => {
  const s = createReceiptState()
  arm(s)
  assert.deepEqual(tick(s, [child('run')]), []) // still working, message delivered
  const fired = tick(s, [child('wait')], T0 + 90_000)
  assert.equal(fired.length, 1)
  assert.equal(fired[0].kind, 'reply-receipt')
  assert.equal(fired[0].parentId, 'orch')
  assert.equal(fired[0].childId, 'c1')
  // …and wait is true on every tick after it, which is precisely what a
  // state-keyed latch would have re-fired on, forever.
  for (let i = 0; i < 10; i++) assert.deepEqual(tick(s, [child('wait')]), [])
})

test('both lines are stamped with the OBSERVATION time, from the injected clock', () => {
  // A line can sit in a busy chat's queue for hours (measured: ~7 h), so the
  // delivery has to be able to say how old it is — which needs the moment the
  // edge was seen, taken here rather than estimated at the far end.
  const s = createReceiptState()
  arm(s)
  tick(s, [child('run')])
  assert.equal(tick(s, [child('wait')], T0 + 90_000)[0].observedAt, T0 + 90_000)
  const t = createReceiptState()
  tick(t, [child('run')], T0, parentOf)
  assert.equal(tick(t, [child('wait')], T0 + 5000, parentOf)[0].observedAt, T0 + 5000)
})

test('three messages before one idle collapse into one receipt, timed from the first', () => {
  const s = createReceiptState()
  arm(s, 'c1', 'orch', T0)
  tick(s, [child('run')])
  arm(s, 'c1', 'orch', T0 + 10_000) // the parent writes again mid-turn…
  arm(s, 'c1', 'orch', T0 + 20_000) // …and again
  const fired = tick(s, [child('wait')], T0 + 120_000)
  assert.equal(fired.length, 1)
  // Timed from the FIRST message: that is the wait the parent actually sat through.
  assert.equal(fired[0].waitedMs, 120_000)
})

test('spending is immediate — the next message arms again', () => {
  const s = createReceiptState()
  arm(s)
  tick(s, [child('run')])
  assert.equal(tick(s, [child('wait')])[0].kind, 'reply-receipt')
  arm(s, 'c1', 'orch', T0 + 500_000)
  tick(s, [child('run')])
  const fired = tick(s, [child('wait')], T0 + 530_000)
  assert.equal(fired.length, 1)
  assert.equal(fired[0].kind, 'reply-receipt')
  assert.equal(fired[0].waitedMs, 30_000)
})

test('it fires on the run→wait EDGE, never on the wait STATE', () => {
  const s = createReceiptState()
  // Armed while the child sits idle (the parent prompted a resting agent): the
  // message has not been answered yet, so nothing fires until it has worked.
  tick(s, [child('wait')], T0, noParent)
  arm(s)
  assert.deepEqual(tick(s, [child('wait')]), [])
  assert.deepEqual(tick(s, [child('wait')]), [])
  assert.deepEqual(tick(s, [child('run')]), [])
  assert.equal(tick(s, [child('wait')])[0].kind, 'reply-receipt')
})

test('a child first seen already idle cannot fire retroactively', () => {
  // No previous observation = no edge. (The child may have idled before the
  // parent ever wrote to it, or before this process booted.)
  const s = createReceiptState()
  arm(s)
  assert.deepEqual(tick(s, [child('wait')]), [])
  assert.deepEqual(tick(s, [child('wait')]), [])
})

test('a session missing for a tick (a bridge blip) delays a line, never loses or duplicates it', () => {
  const s = createReceiptState()
  arm(s)
  tick(s, [child('run')])
  assert.deepEqual(tick(s, []), []) // bridge unreachable this tick
  const fired = tick(s, [child('wait')])
  assert.equal(fired.length, 1)
  assert.deepEqual(tick(s, [child('wait')]), [])
})

test('receipts are per (parent, child) — one child idling never pings another parent', () => {
  const s = createReceiptState()
  arm(s, 'c1', 'orch-a')
  const roster = (ph) => [child(ph), { id: 'c2', kind: 'dev', repo: 'demo-app', task: 'other', phase: ph }]
  tick(s, roster('run'), T0, noParent)
  const fired = tick(s, roster('wait'), T0, noParent)
  assert.equal(fired.length, 1)
  assert.equal(fired[0].childId, 'c1')
  assert.equal(fired[0].parentId, 'orch-a')
})

test('terminal states are irrelevant here — a merged child still reports it answered', () => {
  // The exact gap this exists for: ship notes latch 'merged' and go silent
  // forever, so an ordinary turn afterwards was invisible by construction.
  const s = createReceiptState()
  arm(s)
  tick(s, [child('run', { shipState: 'merged' })])
  assert.equal(tick(s, [child('wait', { shipState: 'merged' })]).length, 1)
})

test('a finished (phase done) child does not count as an answer', () => {
  const s = createReceiptState()
  arm(s)
  tick(s, [child('run')])
  assert.deepEqual(tick(s, [child('done')]), [])
  // …and the terminal phase overwrites the run, so a later stray wait finds no edge.
  assert.deepEqual(tick(s, [child('wait')]), [])
})

/* --- 🔴 the in testing defect: a blip at delivery ---------------------
 * Three timestamped reproductions on two hosts. `isBusy(pane)` reads the busy
 * marker out of Claude Code's bottom footer line, which is ellipsized at the
 * pane width — delivering a message adds a footer segment and truncates the
 * marker away, so the RAW status went idle ~4.4 s after each delivery while the
 * turn ran on for another 35 minutes. The debounced phase never moved, which is
 * exactly why this module now reads it. */

test('a BLIP at delivery fires nothing — the phase never leaves run', () => {
  const s = createReceiptState()
  tick(s, [child('run')], T0, noParent)
  arm(s, 'c1', 'orch', T0)
  // The pane misreads for a few ticks (status would say 'idle'); agent-timings'
  // debounce holds the phase at 'run', so the roster this module sees never
  // shows the edge.
  for (let i = 1; i <= 4; i++) {
    assert.deepEqual(tick(s, [child('run', { status: 'idle' })], T0 + i * 6_000), [])
  }
  // …and the receipt is still armed for the turn that really consumed it.
  const fired = tick(s, [child('wait')], T0 + 2_129_000) // the real end, 35m29s later
  assert.equal(fired.length, 1)
  assert.equal(fired[0].kind, 'reply-receipt')
  assert.equal(fired[0].waitedMs, 2_129_000)
  assert.match(fired[0].text, /35m/)
})

test('a receipt may not fire for a turn that ended while its message was still parked', () => {
  const s = createReceiptState()
  // Armed mid-turn; the message is still in the child's queue (paced/idle-only).
  tick(s, [parked('run')], T0, parentOf)
  arm(s, 'c1', 'orch', T0)
  // That in-flight turn ends. It cannot be the turn that consumed the message.
  const first = tick(s, [parked('wait')], T0 + 30_000, parentOf)
  assert.equal(first.length, 1)
  assert.equal(first[0].kind, 'turn-end') // honest: it stopped, but nobody was answered
  // The queue drains, the child works, and THAT turn end is the receipt.
  tick(s, [child('wait')], T0 + 36_000, parentOf) // delivery observed (queue empty)
  tick(s, [child('run')], T0 + 42_000, parentOf)
  const second = tick(s, [child('wait')], T0 + 90_000, parentOf)
  assert.equal(second.length, 1)
  assert.equal(second[0].kind, 'reply-receipt')
  assert.equal(second[0].waitedMs, 90_000)
})

test('delivery observed in the SAME tick as the edge does not claim that turn', () => {
  // Ordering guard: the delivered flag is read from the incoming state and only
  // then written, so a message flushing AT the idle it was waiting for cannot
  // retro-claim the turn that preceded it.
  const s = createReceiptState()
  tick(s, [parked('run')], T0, parentOf)
  arm(s, 'c1', 'orch', T0)
  const fired = tick(s, [child('wait')], T0 + 20_000, parentOf) // queue empty AND the edge
  assert.equal(fired.length, 1)
  assert.equal(fired[0].kind, 'turn-end')
  assert.equal(s.pending.get('c1').delivered, true) // armed still, now delivered
})

/* --- turn-end observations: the half a spent receipt left open -------- */

test('a spawned child that nobody messaged still reports every turn end, once', () => {
  const s = createReceiptState()
  tick(s, [child('run')], T0, parentOf)
  const fired = tick(s, [child('wait', { lastRunMs: 2_129_000 })], T0 + 2_129_000, parentOf)
  assert.equal(fired.length, 1)
  assert.equal(fired[0].kind, 'turn-end')
  assert.equal(fired[0].parentId, 'orch')
  assert.equal(fired[0].runMs, 2_129_000)
  assert.match(fired[0].text, /Turn ended/)
  assert.match(fired[0].text, /35m/)
  // Idle is true on every tick after it — and it stays silent, like the receipt.
  for (let i = 0; i < 10; i++) assert.deepEqual(tick(s, [child('wait')], T0, parentOf), [])
})

test('the second turn end after a spent receipt is reported — one line, not N', () => {
  // The live in testing case: turn 1 consumed the spec (receipt), turn 2 ended in
  // a second escalation that reached nobody at all.
  const s = createReceiptState()
  arm(s)
  tick(s, [child('run')], T0, parentOf)
  assert.equal(tick(s, [child('wait')], T0 + 2_129_000, parentOf)[0].kind, 'reply-receipt')
  tick(s, [child('run')], T0 + 2_400_000, parentOf)
  const second = tick(s, [child('wait', { lastRunMs: 342_452 })], T0 + 2_742_000, parentOf)
  assert.equal(second.length, 1)
  assert.equal(second[0].kind, 'turn-end')
  for (let i = 0; i < 5; i++) assert.deepEqual(tick(s, [child('wait')], T0, parentOf), [])
})

test('remote and box-local children are decided identically — the roster shape is the contract', () => {
  // A bridge session reaches this module through lastRemoteSessions with `phase`
  // mirrored from its shadow; nothing else about it differs, so nothing here may
  // branch on it. Same script, same verdicts.
  const remote = (ph, o = {}) => ({ id: 'r1', kind: 'dev', repo: 'remote-app', task: 'fix the flaky test', phase: ph, ...o })
  const lineage = (id) => ({ c1: 'orch', r1: 'orch' })[id]
  const run = (mk) => {
    const s = createReceiptState()
    s.pending = armReceipt(s, { childId: mk('run').id, parentId: 'orch', at: T0 })
    tick(s, [mk('run')], T0, lineage)
    const a = tick(s, [mk('wait')], T0 + 60_000, lineage)
    tick(s, [mk('run')], T0 + 70_000, lineage)
    const b = tick(s, [mk('wait')], T0 + 90_000, lineage)
    return [...a, ...b].map((n) => n.kind)
  }
  assert.deepEqual(run(child), ['reply-receipt', 'turn-end'])
  assert.deepEqual(run(remote), ['reply-receipt', 'turn-end'])
})

test('an open choice menu is named as the hint — a prose stop is not guessed at', () => {
  const s = createReceiptState()
  tick(s, [child('run')], T0, parentOf)
  const fired = tick(s, [child('wait', { menuKind: 'choice', menuQuestion: 'Which resolution?' })], T0, parentOf)
  assert.match(fired[0].text, /holding a menu open: "Which resolution\?"/)
  // No menu → no invented hint (lastOutput is footer chrome, not the agent's text).
  assert.doesNotMatch(turnEndText(child('wait', { lastOutput: '  ⏵⏵ bypass permissions on · ← for agents' }), 1000), /menu/)
})

test('turn-end lines are capped per child, and the trip is reported exactly once', () => {
  const adopt = (state, sessions, now) => {
    const r = diffReceipts(state, sessions, parentOf, now)
    state.pending = r.pending
    state.seen = r.seen
    state.turns = r.turns
    return r
  }
  const s = createReceiptState()
  let trips = 0
  for (let i = 0; i < MAX_TURN_NOTES_PER_CHILD + 3; i++) {
    const t = T0 + i * 100_000
    adopt(s, [child('run')], t)
    const { due, capped } = adopt(s, [child('wait')], t)
    trips += capped.length
    if (i < MAX_TURN_NOTES_PER_CHILD) assert.equal(due.length, 1, `turn ${i} should fire`)
    else assert.equal(due.length, 0, `turn ${i} should be capped`)
  }
  assert.equal(trips, 1)
})

test('both lines are boundary-eligible — a busy parent is not the point of failure', () => {
  assert.equal(classifyKind('reply-receipt'), 'boundary')
  assert.equal(classifyKind('turn-end'), 'boundary')
  assert.ok(BOUNDARY_KINDS.has('turn-end'))
  // …and the observational broadcast stays idle-only, unchanged.
  assert.equal(classifyKind('fleet-note'), 'idle')
})

test('the note names the child and how long the parent waited, and claims nothing about content', () => {
  const t = receiptText(child('wait'), 135_000)
  assert.match(t, /c1/)
  assert.match(t, /demo-app/)
  assert.match(t, /fix the thing/)
  assert.match(t, /2m/)
  assert.match(t, /Reply receipt/)
  assert.match(receiptText(child('wait'), 9_000), /9s/)
  assert.match(receiptText(child('wait'), 200), /1s/) // never "0s"
  // A chat can spawn a knowledge agent too — don't announce one as a dev agent.
  assert.match(receiptText({ id: 'k1', kind: 'knowledge', repo: 'vault', task: 'read up' }, 1000), /knowledge agent/)
  // The turn-end line must not read as a reply to something the parent sent.
  const u = turnEndText(child('wait'), 342_452)
  assert.match(u, /answers no message of yours/)
  assert.match(u, /6m/)
  assert.doesNotMatch(u, /you sent it/)
})

test('arming needs both ends, and never overwrites a pending receipt', () => {
  const s = createReceiptState()
  const before = s.pending
  s.pending = armReceipt(s, { childId: 'c1', parentId: '', at: T0 })
  assert.equal(s.pending, before) // same map — nothing armed
  s.pending = armReceipt(s, { childId: '', parentId: 'orch', at: T0 })
  assert.equal(s.pending, before)
  arm(s, 'c1', 'orch-a', T0)
  arm(s, 'c1', 'orch-b', T0 + 1000) // a second sender can't steal the pending slot
  assert.deepEqual(s.pending.get('c1'), { parentId: 'orch-a', at: T0, by: 'parent', delivered: false })
})

/* --- who gets told, and about whose message --------------------------
 * The operator's decision (in testing), overriding this PR's first answer: the
 * parent chat is told whoever sent the message, because he wants to read his
 * Atlas chats instead of walking the dev agents himself. Still message-keyed —
 * "always notified" is about the SENDER, never about every idle. */

test('an OPERATOR prompt (no steeredBy) arms a receipt to the child\'s parent chat', () => {
  assert.deepEqual(receiptParent('c1', undefined, parentOf), { parentId: 'orch', by: 'operator' })
  const s = createReceiptState()
  const r = receiptParent('c1', undefined, parentOf)
  arm(s, 'c1', r.parentId, T0, r.by)
  tick(s, [child('run')])
  const fired = tick(s, [child('wait')], T0 + 45_000)
  assert.equal(fired.length, 1)
  assert.equal(fired[0].parentId, 'orch')
  assert.equal(fired[0].by, 'operator')
  // …and exactly one, on the edge — the operator path is not a per-idle trigger.
  for (let i = 0; i < 5; i++) assert.deepEqual(tick(s, [child('wait')]), [])
})

test("the operator-initiated note doesn't claim the chat sent the message", () => {
  const mine = receiptText(child('wait'), 60_000, 'parent')
  const theirs = receiptText(child('wait'), 60_000, 'operator')
  assert.match(mine, /message you sent it/)
  assert.doesNotMatch(mine, /OPERATOR/)
  assert.match(theirs, /OPERATOR messaged it directly \(not you\)/)
  assert.doesNotMatch(theirs, /you sent/)
})

test('a child with no parent chat arms nothing — there is nobody to tell', () => {
  assert.equal(receiptParent('c-orphan', undefined, parentOf), null) // operator's own agent
  assert.equal(receiptParent('c-orphan', 'orch', parentOf), null) // …even if a chat steers it
  // And the arm is a no-op rather than a crash: nothing pends, nothing fires —
  // and the unsolicited path stays silent too, since the lineage has no parent.
  const s = createReceiptState()
  s.pending = armReceipt(s, { childId: 'c-orphan', parentId: null, at: T0, by: 'operator' })
  assert.equal(s.pending.size, 0)
  const orphan = (ph) => ({ id: 'c-orphan', kind: 'dev', repo: 'demo-app', phase: ph })
  tick(s, [orphan('run')], T0, parentOf)
  assert.deepEqual(tick(s, [orphan('wait')], T0, parentOf), [])
})

test('a steer from a chat that did NOT spawn the child tells nobody', () => {
  // The owning chat never sent that message, and the sending chat isn't the
  // parent — the operator asked to hear about his own agents, not about another
  // orchestrator's traffic.
  assert.equal(receiptParent('c1', 'some-other-chat', parentOf), null)
  assert.deepEqual(receiptParent('c1', 'orch', parentOf), { parentId: 'orch', by: 'parent' })
})

test('the ship-note path is untouched: the two share no state and no verdict', () => {
  const orch = { id: 'orch', kind: 'knowledge', vault: 'atlas' }
  const shipState = new Map([['c1', []]])
  const s = createReceiptState()
  arm(s)
  tick(s, [child('run')])
  const fired = tick(s, [child('wait')])
  assert.equal(fired.length, 1)
  // A receipt firing changes nothing about what the ship diff decides, and a
  // plain idle turn is not a ship transition.
  const { notes, next } = diffShipNotes(shipState, [orch, { ...child('wait'), status: 'idle' }], (id) => (id === 'c1' ? 'orch' : undefined))
  assert.deepEqual(notes, [])
  assert.deepEqual([...next.get('c1')], [])
})
