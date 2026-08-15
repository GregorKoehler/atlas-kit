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
  OBSERVATIONAL_KINDS,
  isObservational,
  NOTE_AGE_DISCLOSE_MS,
  ageLine,
  humanAge,
  deliveryText,
  selectDelivery,
  noteStaleReason,
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
  // flushQueued delivers at most ONE selection per session per tick, and which
  // entry that is belongs to the scan (`selectDelivery`, below) — so THIS
  // decision can change WHEN an entry goes out, never how many go out or in what
  // order. Guard the shape that makes that true: decideDelivery sees a single
  // kind and answers deliver/hold for it alone.
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

/* ── Stale observations ──────────────────────────────────────────────────────
 * The incident behind this half: one Atlas orchestrator ran a single ~7 h turn
 * while it spawned, merged and cleaned up 8 dev agents. When that turn ended,
 * ~15 notes drained ONE PER TURN about children already merged and torn down,
 * none of them carrying the time it was observed. Four defects, one per section
 * below.
 */

const HDR = '⚙ **Automatic fleet update from the Atlas Kit dashboard** — an OBSERVATION'
const T0 = Date.parse('2027-01-15T09:00:00Z')
// One queue entry as the routes build it: `text` = header + blank line + note,
// with the pieces kept so a rebuilt delivery can put the header back first.
const note = (kind, childId, o = {}) => ({
  kind,
  at: new Date(T0).toISOString(),
  observedAt: T0,
  about: { childId, ...(o.state ? { state: o.state } : {}) },
  header: HDR,
  note: o.note || `${kind} about ${childId}`,
  text: `${HDR}\n\n${o.note || `${kind} about ${childId}`}`,
  ...o.extra,
})
const sel = (queue, o = {}) =>
  selectDelivery({ queue, busy: true, menu: false, shipHead: false, boundaryEnabled: true, sinceBoundaryMs: null, ...o })

/* --- 1. the note says WHEN it was observed ---------------------------- */

test('an observational kind is a THIRD axis — turn-end is boundary-eligible AND revalidatable', () => {
  assert.deepEqual([...OBSERVATIONAL_KINDS].sort(), ['fleet-note', 'turn-end'])
  // ⚠️ A receipt answers a message its recipient actually sent: it is delivered
  // however late, and only ever gets the age line.
  assert.equal(isObservational('reply-receipt'), false)
  assert.equal(classifyKind('turn-end'), 'boundary')
  assert.equal(isObservational('turn-end'), true)
})

test('under the threshold there is no age line at all — no clutter on the common case', () => {
  assert.equal(ageLine(T0, T0 + 1000), '')
  assert.equal(ageLine(T0, T0 + NOTE_AGE_DISCLOSE_MS), '')
  assert.equal(ageLine(undefined, T0 + 10 * 60_000), '', 'an un-stamped kind reads exactly as it always has')
})

test('over it the note opens by saying how old it is, in the reader\'s clock', () => {
  const line = ageLine(T0, T0 + 3 * 3600_000 + 12 * 60_000)
  assert.match(line, /^⏱ Observed at \d\d:\d\d, 3h 12m before this delivery/)
  assert.equal(humanAge(45_000), '45s')
  assert.equal(humanAge(20 * 60_000), '20m')
  assert.equal(humanAge(7 * 3600_000), '7h 0m', 'the incident wait')
})

test('a fresh single note is delivered BYTE-IDENTICALLY to before', () => {
  const n = note('fleet-note', 'child-1', { state: 'ready' })
  assert.equal(deliveryText([n], T0 + 5000), n.text)
})

test('an aged note keeps the attribution HEADER first — the age line goes in the body', () => {
  // ⚠️ web/src/lib/msgProvenance.ts anchors `⚙ **Automatic fleet update` at the
  // START of the message. Prefixing the age line ahead of it would repaint a
  // machine observation in the operator's own colour.
  const out = deliveryText([note('fleet-note', 'child-1', { state: 'ready' })], T0 + 2 * 3600_000)
  assert.ok(out.startsWith(HDR), 'header must stay first')
  assert.match(out, /\n\n⏱ Observed at .*\n\nfleet-note about child-1$/)
})

/* --- 2. revalidate before typing ------------------------------------- */

test('a note about a child that is GONE is dropped', () => {
  const n = note('fleet-note', 'child-1', { state: 'ready' })
  assert.match(noteStaleReason(n, { child: undefined }), /child-1 is gone/)
  // …and an entry that claims nothing about a child is never revalidated.
  assert.equal(noteStaleReason({ kind: 'fleet-note' }, { child: undefined }), null)
})

test('a fleet note the world has moved PAST is dropped; one still current is not', () => {
  const ready = note('fleet-note', 'child-1', { state: 'ready' })
  assert.match(noteStaleReason(ready, { child: { shipState: 'merged' } }), /now merged, past the ready/)
  assert.equal(noteStaleReason(ready, { child: { shipState: 'ready' } }), null)
  // Backwards never counts as superseded (a flap is not news).
  const merged = note('fleet-note', 'child-1', { state: 'merged' })
  assert.equal(noteStaleReason(merged, { child: { shipState: 'ready' } }), null)
})

test('a merge the RECIPIENT performed itself is dropped, even if the note was already queued', () => {
  const n = note('fleet-note', 'child-1', { state: 'merged' })
  assert.match(noteStaleReason(n, { child: { shipState: 'merged' }, mergedBySelf: true }), /merged by this chat itself/)
  assert.equal(noteStaleReason(n, { child: { shipState: 'merged' }, mergedBySelf: false }), null)
})

test('a turn-end line is dropped once the child has started another turn', () => {
  const n = note('turn-end', 'child-1')
  assert.match(noteStaleReason(n, { child: { phase: 'run' } }), /started another turn since/)
  assert.equal(noteStaleReason(n, { child: { phase: 'wait' } }), null)
})

test('a RECEIPT is never dropped — it answers a message the recipient sent', () => {
  const r = note('reply-receipt', 'child-1')
  // Both halves: the rule itself refuses to call it stale…
  assert.equal(noteStaleReason(r, { child: undefined }), null)
  // …and the selection never even revalidates it (it is not observational).
  const s = sel([r], { busy: false, revalidate: () => 'child-1 is gone' })
  assert.equal(s.drops.length, 0)
  assert.deepEqual(s.pick.entries, [r])
})

test('every drop is reported to the caller with its reason — nothing goes silently', () => {
  const gone = note('fleet-note', 'child-1', { state: 'ready' })
  const live = note('fleet-note', 'child-2', { state: 'ready' })
  const s = sel([gone, live], { busy: false, revalidate: (e) => (e.about.childId === 'child-1' ? 'child-1 is gone' : null) })
  assert.deepEqual(s.drops, [{ entry: gone, reason: 'child-1 is gone' }])
  assert.deepEqual(s.pick.entries, [live])
})

test('a LATER queued note about the same child supersedes the earlier one, with no state at all', () => {
  const ready = note('fleet-note', 'kid', { state: 'ready' })
  const merged = note('fleet-note', 'kid', { state: 'merged' })
  const other = note('turn-end', 'kid2')
  const s = sel([ready, other, merged], { busy: false })
  assert.deepEqual(s.drops.map((d) => d.entry), [ready])
  assert.match(s.drops[0].reason, /superseded by a later queued note about kid/)
  assert.deepEqual(s.pick.entries, [other, merged], 'the survivors, in queue order')
})

test('a dropped note supersedes nothing — the decision is made back-to-front', () => {
  const first = note('turn-end', 'kid')
  const second = note('turn-end', 'kid')
  // The LATER one is itself stale, so the earlier must not be killed by it…
  const s = sel([first, second], { busy: false, revalidate: (e) => (e === second ? 'kid is gone' : null) })
  assert.deepEqual(s.drops.map((d) => d.entry), [second])
  assert.deepEqual(s.pick.entries, [first])
})

/* --- 3. no head-of-line blocking ------------------------------------- */

test('an idle-only head no longer parks the boundary-eligible messages behind it', () => {
  // The incident's shape: turn-end lines landed at tool-call boundaries early in
  // the 7 h turn and stopped the moment a fleet-note reached the head.
  const head = { kind: 'fleet-note', text: 'a', about: { childId: 'k1' } }
  const steer = { kind: 'steer', text: 'b' }
  const s = sel([head, steer])
  assert.deepEqual(s.pick, { entries: [steer], via: 'boundary', digest: false })
  assert.equal(s.drops.length, 0, 'the skipped note stays queued — skipped is not dropped')
})

test('relative order WITHIN a class is never changed', () => {
  const n1 = { kind: 'fleet-note', text: 'n1' }
  const s1 = { kind: 'steer', text: 's1' }
  const s2 = { kind: 'steer', text: 's2' }
  assert.deepEqual(sel([n1, s1, s2]).pick.entries, [s1], 'the FIRST steer, not the last')
  assert.deepEqual(sel([n1, s2, s1]).pick.entries, [s2])
})

test('at full idle the order reverts to FIFO — the scan only ever skips what the gate refuses', () => {
  const s1 = { kind: 'steer', text: 's1' }
  const op = { kind: 'operator', text: 'op' }
  assert.deepEqual(sel([s1, op], { busy: false }).pick.entries, [s1])
})

test('nothing here relaxes the menu, the ship train or the pacing', () => {
  const q = [{ kind: 'fleet-note', text: 'a' }, { kind: 'steer', text: 'b' }]
  assert.equal(sel(q, { menu: true }).pick, null)
  assert.equal(sel(q, { menu: true }).hold, 'menu')
  assert.equal(sel(q, { shipHead: true }).pick, null)
  assert.equal(sel(q, { sinceBoundaryMs: 0 }).pick, null, 'the steer is paced, and no other entry may take its place')
  assert.equal(sel(q, { boundaryEnabled: false }).pick, null)
})

/* --- 4. one wake-up, not fifteen ------------------------------------- */

test('the idle drain of several observations is ONE digest, newest last, each with its clock', () => {
  const q = [
    note('fleet-note', 'k1', { state: 'ready', extra: { observedAt: T0 } }),
    note('turn-end', 'k2', { extra: { observedAt: T0 + 60_000 } }),
    note('fleet-note', 'k3', { state: 'merged', extra: { observedAt: T0 + 120_000 } }),
  ]
  const s = sel(q, { busy: false })
  assert.equal(s.pick.digest, true)
  assert.deepEqual(s.pick.entries, q)
  const out = deliveryText(s.pick.entries, T0 + 7 * 3600_000)
  assert.ok(out.startsWith(HDR))
  assert.match(out, /⚙ Fleet digest — 3 observations/)
  const lines = out.split('\n').filter((l) => l.startsWith('•'))
  assert.equal(lines.length, 3)
  for (const l of lines) assert.match(l, /^• \d\d:\d\d — /)
  assert.match(lines[2], /fleet-note about k3$/, 'newest last')
})

test('a single surviving observation is NOT digested', () => {
  const only = note('fleet-note', 'k1', { state: 'ready' })
  const s = sel([only], { busy: false })
  assert.equal(s.pick.digest, false)
  assert.equal(deliveryText(s.pick.entries, T0 + 1000), only.text)
})

test('the digest never batches boundary deliveries, and never crosses classes', () => {
  const n1 = note('fleet-note', 'k1', { state: 'ready' })
  const n2 = note('turn-end', 'k2')
  const steer = { kind: 'steer', text: 'course change' }
  // Mid-turn nothing batches: the first boundary-eligible entry goes ALONE —
  // here the turn-end line, which is observational in trust but boundary in
  // delivery — and the idle-only fleet note ahead of it does not block it.
  const busy = sel([n1, n2, steer])
  assert.deepEqual(busy.pick, { entries: [n2], via: 'boundary', digest: false })
  // At idle: the notes batch, the steer is left for its own turn.
  const idle = sel([n1, n2, steer], { busy: false })
  assert.deepEqual(idle.pick.entries, [n1, n2])
  assert.equal(idle.pick.digest, true)
  // …and a queue whose head is a steer still delivers the steer first.
  assert.deepEqual(sel([steer, n1, n2], { busy: false }).pick.entries, [steer])
})

test('the incident end-to-end: 15 notes about torn-down children become ONE line, or none', () => {
  // 8 children, each with a ready note and a turn-end line; all long since gone.
  const queue = []
  for (let i = 0; i < 8; i++) {
    queue.push(note('fleet-note', `kid-${i}`, { state: 'ready', extra: { observedAt: T0 + i * 60_000 } }))
    queue.push(note('turn-end', `kid-${i}`, { extra: { observedAt: T0 + i * 60_000 + 30_000 } }))
  }
  const s = sel(queue, { busy: false, revalidate: (e) => `${e.about.childId} is gone — the session was torn down` })
  assert.equal(s.drops.length, 16, 'every one is dropped, and every drop carries a reason')
  assert.equal(s.pick, null, 'nothing is typed at the orchestrator at all')
  // With the children still alive, the same queue is one digest instead of 16 turns.
  const alive = sel(queue, { busy: false })
  assert.equal(alive.drops.length, 8, 'the earlier note about each child is superseded by its later one')
  assert.equal(alive.pick.entries.length, 8)
  assert.equal(alive.pick.digest, true)
})
