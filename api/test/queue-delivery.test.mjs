/* ------------------------------------------------------------------ *
 * Tests for the queued-prompt delivery gate (queue-delivery.mjs) — the pure
 * decision `flushQueued` runs per session per tick.
 *
 * Delivery used to be "wait for a full idle", a pane heuristic that stays true
 * for a whole turn: measured over 55 real flushes, min 0.16 s · median 6.8 s ·
 * max 2,634 s (43.9 min). Claude Code surfaces a mid-turn message at the next
 * TOOL-CALL BOUNDARY (measured in testing), so course-changing kinds no longer
 * wait — but observational ones still do, because a message that lands mid-turn
 * can derail reasoning in flight.
 *
 * What must not regress (each has a real incident behind it):
 *  - a MENU holds delivery regardless of kind (an earlier change: a keystroke into a menu
 *    is a selection, not text — a blind Esc once killed a worker);
 *  - the ship-train head holds (a parked prompt must never land mid git-merge);
 *  - an UNKNOWN kind holds — unknown fails safe to the old behaviour;
 *  - AGENT_BOUNDARY_DELIVERY=0 restores the old behaviour exactly;
 *  - mid-turn deliveries are paced, so a queue can't burst into one turn.
 *
 * Run: node --test api/test/queue-delivery.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideDelivery,
  classifyKind,
  BOUNDARY_KINDS,
  BOUNDARY_MIN_GAP_MS,
  deliveryBackoffMs,
  DELIVER_FAIL_GRACE,
  DELIVER_BACKOFF_MAX_MS,
} from '../src/queue-delivery.mjs'

// Defaults: busy agent, no menu, not shipping, boundary delivery on, never yet
// boundary-delivered. Each test overrides only what it is about.
const at = (o = {}) => decideDelivery({ kind: undefined, busy: true, menu: false, shipHead: false, boundaryEnabled: true, sinceBoundaryMs: null, ...o })

// Every kind that actually reaches a queue entry today, mapped explicitly.
const MAPPING = [
  ['steer', 'boundary'], // orchestrator / MCP queue_agent (POST /api/agents/queue with steeredBy)
  ['operator', 'boundary'], // the operator's own Queue from the dashboard compose box
  ['agent-msg', 'boundary'], // peer mail off the agent↔agent bus 
  // ⚠️ An OBSERVATION that is nonetheless boundary-eligible, and deliberately so:
  // trust class and delivery class are different axes. A receipt is solicited and
  // addressed to the one parent that messaged that child, so the reason fleet
  // notes wait ("don't derail a turn with an unsolicited broadcast") doesn't
  // apply — and idle-only would hand it back the 43.9-min tail it exists to
  // remove. This row is the guard against a refactor silently demoting it.
  ['reply-receipt', 'boundary'],
  // Its unsolicited sibling : a child you SPAWNED finished a turn and is
  // waiting at its prompt. Same narrow audience — one chat, its own child — so
  // the same class; still not the broadcast a fleet note is.
  ['turn-end', 'boundary'],
  ['fleet-note', 'idle'], // ⚙ automatic fleet updates — observation, not instruction
  ['atlas-brief', 'idle'], // 📚 background context (no longer queued at all since an earlier change)
  [undefined, 'idle'], // untagged: a scheduled prompt, whose contract is "never mid-turn"
]

test('every real kind maps to exactly one class', () => {
  for (const [kind, cls] of MAPPING) assert.equal(classifyKind(kind), cls, `kind ${String(kind)}`)
  assert.deepEqual([...BOUNDARY_KINDS].sort(), ['agent-msg', 'operator', 'reply-receipt', 'steer', 'turn-end'])
})

test('a busy agent takes the boundary-eligible kinds and holds the rest', () => {
  for (const [kind, cls] of MAPPING) {
    const d = at({ kind })
    if (cls === 'boundary') assert.deepEqual(d, { deliver: true, via: 'boundary' }, `kind ${String(kind)}`)
    else assert.deepEqual(d, { deliver: false, reason: 'idle-only' }, `kind ${String(kind)}`)
  }
})

test('an unknown kind holds — unknown fails safe to idle-only', () => {
  assert.deepEqual(at({ kind: 'something-invented-later' }), { deliver: false, reason: 'idle-only' })
  assert.equal(classifyKind('something-invented-later'), 'idle')
  // …and is delivered normally once the agent is genuinely idle.
  assert.deepEqual(at({ kind: 'something-invented-later', busy: false }), { deliver: true, via: 'idle' })
})

test('an idle agent takes every kind, and the delivery is marked idle', () => {
  for (const [kind] of MAPPING) assert.deepEqual(at({ kind, busy: false }), { deliver: true, via: 'idle' }, `kind ${String(kind)}`)
})

test('a MENU holds delivery regardless of kind, busy or idle', () => {
  for (const [kind] of MAPPING) {
    for (const busy of [true, false]) {
      assert.deepEqual(at({ kind, busy, menu: true }), { deliver: false, reason: 'menu' }, `kind ${String(kind)} busy=${busy}`)
    }
  }
})

test('the ship-train head holds delivery regardless of kind — a parked prompt never lands mid-merge', () => {
  for (const [kind] of MAPPING) {
    for (const busy of [true, false]) {
      assert.deepEqual(at({ kind, busy, shipHead: true }), { deliver: false, reason: 'ship-train' }, `kind ${String(kind)} busy=${busy}`)
    }
  }
})

test('AGENT_BOUNDARY_DELIVERY off restores the old behaviour exactly: idle or nothing', () => {
  for (const [kind] of MAPPING) {
    assert.deepEqual(at({ kind, boundaryEnabled: false }), { deliver: false, reason: 'busy' }, `kind ${String(kind)}`)
    assert.deepEqual(at({ kind, boundaryEnabled: false, busy: false }), { deliver: true, via: 'idle' }, `kind ${String(kind)}`)
    assert.deepEqual(at({ kind, boundaryEnabled: false, menu: true }), { deliver: false, reason: 'menu' }, `kind ${String(kind)}`)
    assert.deepEqual(at({ kind, boundaryEnabled: false, shipHead: true }), { deliver: false, reason: 'ship-train' }, `kind ${String(kind)}`)
  }
})

test('mid-turn deliveries are paced — the second one waits out the gap, it does not burst', () => {
  // Idle pacing came free: delivering made the agent busy, so the next queued
  // prompt got its own turn. Mid-turn the agent stays busy, so without this a
  // 3 s flush tick would empty the whole queue into one turn.
  assert.deepEqual(at({ kind: 'steer', sinceBoundaryMs: 0 }), { deliver: false, reason: 'paced' })
  assert.deepEqual(at({ kind: 'steer', sinceBoundaryMs: BOUNDARY_MIN_GAP_MS - 1 }), { deliver: false, reason: 'paced' })
  assert.deepEqual(at({ kind: 'steer', sinceBoundaryMs: BOUNDARY_MIN_GAP_MS }), { deliver: true, via: 'boundary' })
  // Pacing is about mid-turn only: an idle agent still takes the next one at once.
  assert.deepEqual(at({ kind: 'steer', busy: false, sinceBoundaryMs: 0 }), { deliver: true, via: 'idle' })
})

test('FIFO and one-per-tick are the caller\'s loop, and the decision cannot widen them', () => {
  // flushQueued asks about s.queued[0] only, and delivers at most that one per
  // session per tick — so the decision can change WHEN the head goes out, never
  // how many go out or in what order. Guard the shape that makes that true:
  // decideDelivery sees a single kind and answers deliver/hold for it alone.
  const d = at({ kind: 'steer' })
  assert.deepEqual(Object.keys(d).sort(), ['deliver', 'via'])
  assert.equal(decideDelivery.length, 1) // one options object; no queue, no batch
})

/* ── Backing off a head that keeps being refused (in testing) ───────────────
 * A refused delivery leaves the message at the queue head, so the next tick
 * retried it — 24 attempts in 75 s against one live Atlas chat, each typing
 * 678 more characters into its input box. The read-back refusal that caused
 * them says something about the PANE, which does not change in 3 s.
 */
test('two refusals are free — a genuinely transient miss costs nothing to repeat', () => {
  assert.equal(deliveryBackoffMs(0), 0)
  assert.equal(deliveryBackoffMs(1), 0)
  assert.equal(deliveryBackoffMs(DELIVER_FAIL_GRACE), 0)
})

test('after the grace it backs off exponentially and caps', () => {
  const first = deliveryBackoffMs(DELIVER_FAIL_GRACE + 1)
  assert.ok(first > 0)
  assert.equal(deliveryBackoffMs(DELIVER_FAIL_GRACE + 2), first * 2)
  assert.equal(deliveryBackoffMs(DELIVER_FAIL_GRACE + 3), first * 4)
  assert.equal(deliveryBackoffMs(99), DELIVER_BACKOFF_MAX_MS, 'never unbounded')
})

test('the incident run would have been held after 3 refusals, not 24', () => {
  // 3 s flush tick, refusals from the first attempt on.
  let attempts = 0, t = 0
  for (let tick = 0; tick < 25; tick++) {
    t += 3000
    if (t < (attempts > DELIVER_FAIL_GRACE ? deliveryBackoffMs(attempts) : 0)) continue
    attempts++
    t = 0
  }
  assert.ok(attempts <= 4, `hot-loop guard: ${attempts} attempts over 75 s (was 24)`)
})
