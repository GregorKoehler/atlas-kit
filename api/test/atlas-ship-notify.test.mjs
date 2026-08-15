/* ------------------------------------------------------------------ *
 * Tests for the Atlas fleet ship-notification core (atlas-ship-notify.mjs).
 *
 * Focus: a child is baselined silently on first sighting (no re-announce on
 * restart), then only a transition INTO 'ready'/'shipped'/'merged' fires; only
 * DEV agents whose parent is a present Atlas orchestrator are considered.
 *
 * Plus the ONCE-ONLY guarantees added after the in testing fleet-note flood (a
 * flapping remote shipState re-fired the same notes every 6s tick, forever):
 * announce each (child, state) at most once, latch terminal states, survive a
 * restart via the persisted set, and cap per child.
 *
 * Run: node --test api/test/atlas-ship-notify.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isOrchestrator,
  noteText,
  diffShipNotes,
  deliverShipNotes,
  parseShipNotes,
  dumpShipNotes,
  MAX_NOTES_PER_CHILD,
  SHIP_NOTE_MAX_TRIES,
} from '../src/atlas-ship-notify.mjs'

const ORCH = { id: 'orch', kind: 'knowledge', vault: 'atlas', startedAt: '2026-06-25T10:00:00Z' }
const parentOf = (map) => (id) => map[id]

test('isOrchestrator: only an atlas-vault knowledge chat', () => {
  assert.equal(isOrchestrator(ORCH), true)
  assert.equal(isOrchestrator({ kind: 'knowledge', vault: 'work' }), false)
  assert.equal(isOrchestrator({ kind: 'dev', repo: 'demo' }), false)
  assert.equal(isOrchestrator(null), false)
})

test('first sighting is a silent baseline — no note even when already ready', () => {
  const sessions = [ORCH, { id: 'c1', kind: 'dev', repo: 'demo', task: 'fix bug', shipState: 'ready' }]
  const { notes, next } = diffShipNotes(new Map(), sessions, parentOf({ c1: 'orch' }))
  assert.equal(notes.length, 0)
  assert.deepEqual(next.get('c1'), ['ready']) // recorded as ALREADY announced
})

test('transition into ready fires one note for the parent', () => {
  const sessions = [ORCH, { id: 'c1', kind: 'dev', repo: 'demo', task: 'fix bug', shipState: 'ready' }]
  const prev = new Map([['c1', []]])
  const { notes } = diffShipNotes(prev, sessions, parentOf({ c1: 'orch' }))
  assert.equal(notes.length, 1)
  assert.equal(notes[0].parentId, 'orch')
  assert.equal(notes[0].childId, 'c1')
  assert.equal(notes[0].state, 'ready')
  assert.match(notes[0].text, /READY TO SHIP/)
})

test('ready → shipped fires the shipped note (with shipInfo)', () => {
  const sessions = [ORCH, { id: 'c1', kind: 'dev', repo: 'demo', task: 't', shipState: 'shipped', shipInfo: 'an earlier change abc123' }]
  const prev = new Map([['c1', ['ready']]])
  const { notes } = diffShipNotes(prev, sessions, parentOf({ c1: 'orch' }))
  assert.equal(notes.length, 1)
  assert.equal(notes[0].state, 'shipped')
  assert.match(notes[0].text, /SHIPPED/)
  assert.match(notes[0].text, /an earlier change abc123/)
})

test('no transition → no note', () => {
  const sessions = [ORCH, { id: 'c1', kind: 'dev', repo: 'demo', task: 't', shipState: 'ready' }]
  const prev = new Map([['c1', ['ready']]])
  const { notes } = diffShipNotes(prev, sessions, parentOf({ c1: 'orch' }))
  assert.equal(notes.length, 0)
})

test('going back to null (new task after ship) is silent', () => {
  const sessions = [ORCH, { id: 'c1', kind: 'dev', repo: 'demo', task: 't' }] // shipState cleared
  const prev = new Map([['c1', ['shipped']]])
  const { notes, next } = diffShipNotes(prev, sessions, parentOf({ c1: 'orch' }))
  assert.equal(notes.length, 0)
  assert.deepEqual(next.get('c1'), ['shipped']) // record KEPT, not reset
})

test('a dev agent whose parent is NOT an orchestrator is ignored', () => {
  const sessions = [
    { id: 'devparent', kind: 'dev', repo: 'demo' },
    { id: 'c1', kind: 'dev', repo: 'demo', shipState: 'ready' },
  ]
  const prev = new Map([['c1', []]])
  const { notes } = diffShipNotes(prev, sessions, parentOf({ c1: 'devparent' }))
  assert.equal(notes.length, 0)
})

test('knowledge / atlas-pass children are never notified', () => {
  const sessions = [
    ORCH,
    { id: 'k1', kind: 'knowledge', vault: 'work', shipState: 'ready' },
    { id: 'p1', kind: 'atlas-pass', shipState: 'ready' },
  ]
  const prev = new Map([['k1', []], ['p1', []]])
  const { notes } = diffShipNotes(prev, sessions, parentOf({ k1: 'orch', p1: 'orch' }))
  assert.equal(notes.length, 0)
})

test('an orphaned child (parent gone) is ignored even if mapped', () => {
  const sessions = [{ id: 'c1', kind: 'dev', repo: 'demo', shipState: 'ready' }] // no orch in roster
  const prev = new Map([['c1', []]])
  const { notes } = diffShipNotes(prev, sessions, parentOf({ c1: 'orch' }))
  assert.equal(notes.length, 0)
})

test('a WORKSTATION child (no kind field, from the bridge) is notified like a dev agent', () => {
  // Remote sessions from the bridge carry no `kind` — isDevChild treats absent as
  // 'dev', so a workstation agent an Atlas chat spawned pings the orchestrator too.
  const sessions = [ORCH, { id: 'w1', repo: 'site', task: 'fix checkout', shipState: 'ready' }]
  const prev = new Map([['w1', []]])
  const { notes } = diffShipNotes(prev, sessions, parentOf({ w1: 'orch' }))
  assert.equal(notes.length, 1)
  assert.equal(notes[0].childId, 'w1')
  assert.match(notes[0].text, /site/)
})

test('noteText shapes both states', () => {
  assert.match(noteText({ id: 'c1', repo: 'demo', task: 'do x' }, 'ready'), /🚀 Fleet update/)
  assert.match(noteText({ id: 'c1', repo: 'demo', task: 'do x', shipInfo: 'an earlier change sha' }, 'shipped'), /✅ Fleet update/)
})

/* --- the in testing flood: once-only, latched, persisted ----------- */

// Drive a sequence of shipStates for one child through the diff exactly the way
// the poller does (diff, then MERGE the result back into the live state map).
function replay(states, prev = new Map()) {
  const state = new Map(prev)
  const notes = []
  for (const shipState of states) {
    const sessions = [ORCH, { id: 'c1', kind: 'dev', repo: 'demo', task: 'fix search', shipState }]
    const r = diffShipNotes(state, sessions, parentOf({ c1: 'orch' }))
    for (const [k, v] of r.next) state.set(k, v)
    notes.push(...r.notes)
  }
  return { notes, state }
}

test('a flapping ship state announces ONCE — ready ⇄ merged oscillation', () => {
  // The flood itself: the notifier saw the remote child's state alternate between
  // the marker-derived 'ready' and the repo-derived 'merged' on every 6s tick.
  const { notes } = replay(['ready', 'merged', 'ready', 'merged', 'ready', 'merged', 'ready'])
  assert.equal(notes.length, 1) // first sighting baselines 'ready'; only 'merged' is news
  assert.equal(notes[0].state, 'merged')
})

test('a genuine ready then a genuine merged still each fire exactly once', () => {
  const { notes, state } = replay(['ready', 'merged'], new Map([['c1', []]]))
  assert.deepEqual(notes.map((n) => n.state), ['ready', 'merged'])
  assert.deepEqual(state.get('c1'), ['ready', 'merged'])
})

test('terminal states latch — nothing fires after merged/shipped, ever', () => {
  for (const terminal of ['merged', 'shipped']) {
    const { notes } = replay([terminal, 'ready', null, 'ready', terminal], new Map([['c1', ['ready']]]))
    assert.equal(notes.length, 1, terminal)
    assert.equal(notes[0].state, terminal)
  }
})

test('restart: the persisted announced set means an already-merged child is silent', () => {
  const persisted = JSON.parse(JSON.stringify(dumpShipNotes(new Map([['c1', ['ready', 'merged']]]))))
  const { notes } = replay(['merged', 'ready', 'merged'], parseShipNotes(persisted))
  assert.equal(notes.length, 0)
})

test('overlapping poll passes do not double-emit', () => {
  // Two passes in flight at once (listSessions can outlast the 6s tick). Both read
  // the SAME live state map, and each merges its result back synchronously — so
  // the second pass sees the first pass's record and stays silent. The poller's
  // re-entrancy guard is the belt to this braces.
  const state = new Map([['c1', []]])
  const sessions = [ORCH, { id: 'c1', kind: 'dev', repo: 'demo', task: 't', shipState: 'ready' }]
  const passes = []
  for (let i = 0; i < 2; i++) {
    const r = diffShipNotes(state, sessions, parentOf({ c1: 'orch' }))
    for (const [k, v] of r.next) state.set(k, v)
    passes.push(...r.notes)
  }
  assert.equal(passes.length, 1)
})

test('a child missing from one tick keeps its record (no clear-and-repopulate)', () => {
  const state = new Map([['c1', ['ready']]])
  const { next } = diffShipNotes(state, [ORCH], parentOf({ c1: 'orch' })) // c1 absent this tick
  assert.deepEqual(next.get('c1'), ['ready'])
})

test('circuit breaker: a child can never exceed MAX_NOTES_PER_CHILD notes', () => {
  // Unreachable through the real state machine (once-only + latch bound it at 2),
  // so force it: a child whose record is full and holds no terminal state.
  const full = Array.from({ length: MAX_NOTES_PER_CHILD }, (_, i) => `x${i}`)
  const sessions = [ORCH, { id: 'c1', kind: 'dev', repo: 'demo', task: 't', shipState: 'ready' }]
  const { notes, capped } = diffShipNotes(new Map([['c1', full]]), sessions, parentOf({ c1: 'orch' }))
  assert.equal(notes.length, 0)
  assert.deepEqual(capped, ['c1'])
})

/* --- delivery: the latch may only advance once a note LANDS -------- *
 * Before this, the poller merged the latch (and persisted it) and only THEN
 * tried to deliver — with the result thrown away by `.catch(() => {})`. Any
 * failed hand-off was therefore lost permanently and silently. These tests pin
 * the four properties of the fix.
 * ------------------------------------------------------------------ */

const child = (shipState) => ({ id: 'c1', kind: 'dev', repo: 'demo', task: 'fix search', shipState })

// One poll pass, exactly as pollAtlasShipNotes runs it: diff, then hand off with
// the latch advancing only per landed note.
function poller(deliver, { maxTries = SHIP_NOTE_MAX_TRIES, state = new Map(), fails = new Map() } = {}) {
  let persists = 0
  return {
    state,
    fails,
    get persists() {
      return persists
    },
    tick: (sessions) => {
      const { notes, next, capped } = diffShipNotes(state, sessions, parentOf({ c1: 'orch' }))
      return deliverShipNotes({ state, notes, next, fails, deliver, maxTries, persist: () => persists++ }).then((r) => ({ ...r, capped }))
    },
  }
}

test('a failed hand-off does NOT advance the latch — and lands on a later tick', async () => {
  let ok = false
  const sent = []
  const p = poller(
    async (n) => {
      if (!ok) return { status: 409, ok: false, error: 'queue full (max 20)' }
      sent.push(n.state)
      return { ok: true }
    },
    { state: new Map([['c1', []]]) },
  )

  const first = await p.tick([ORCH, child('ready')])
  assert.equal(first.results[0].delivered, false)
  assert.deepEqual(p.state.get('c1'), [], 'still UNannounced — the old code latched here and lost the note')

  ok = true
  const second = await p.tick([ORCH, child('ready')])
  assert.equal(second.results[0].delivered, true)
  assert.deepEqual(sent, ['ready'], 'the retry delivered it exactly once')
  assert.deepEqual(p.state.get('c1'), ['ready'])

  // …and now it is latched: no duplicate on any later tick.
  const third = await p.tick([ORCH, child('ready')])
  assert.equal(third.results.length, 0)
  assert.deepEqual(sent, ['ready'])
})

test('retries are bounded: a gone recipient converges, loudly, and stops', async () => {
  let attempts = 0
  const p = poller(
    async () => {
      attempts++
      return { status: 404, ok: false, error: 'no such session' }
    },
    { maxTries: 3, state: new Map([['c1', []]]) },
  )
  const gaveUp = []
  for (let i = 0; i < 10; i++) {
    const { results } = await p.tick([ORCH, child('ready')])
    for (const r of results) if (r.gaveUp) gaveUp.push(r)
  }
  assert.equal(attempts, 3, 'exactly maxTries hand-offs, then it stops trying forever')
  assert.equal(gaveUp.length, 1, 'giving up is reported ONCE, so the caller can log it + record the rejection')
  assert.equal(gaveUp[0].error, 'no such session')
  assert.deepEqual(p.state.get('c1'), ['ready'], 'latched on give-up → converged, never retried again')
  assert.equal(p.fails.size, 0, 'the attempt counter is cleaned up')
})

test('a THROWING hand-off is a failure, not a lost pass', async () => {
  // The old `catch {}` around the whole body meant a mid-loop throw dropped the
  // remaining notes while leaving them latched — a silent loss of the rest.
  const p = poller(
    async () => {
      throw new Error('tmux gone')
    },
    { state: new Map([['c1', []]]) },
  )
  const { results } = await p.tick([ORCH, child('ready')])
  assert.equal(results[0].delivered, false)
  assert.equal(results[0].error, 'tmux gone')
  assert.deepEqual(p.state.get('c1'), [], 'unlatched → retried next tick')
})

test('a baseline (nothing to deliver) still lands immediately and is persisted', async () => {
  const p = poller(async () => ({ ok: true }))
  await p.tick([ORCH, child('ready')]) // first sighting of c1
  assert.deepEqual(p.state.get('c1'), ['ready'], 'baselined without any hand-off')
  assert.equal(p.persists, 1)
})

test('the flood latch is unchanged when the notes actually go out', async () => {
  // The in testing oscillation, replayed through the delivery path this time.
  const sent = []
  const p = poller(
    async (n) => {
      sent.push(n.state)
      return { ok: true }
    },
    { state: new Map([['c1', []]]) },
  )
  for (const s of ['ready', 'merged', 'ready', 'merged', 'ready']) await p.tick([ORCH, child(s)])
  assert.deepEqual(sent, ['ready', 'merged'], 'once per (child, state), and terminal still latches')
})

/* --- the empty baseline: "seen, nothing announced" must PERSIST --- *
 * The READY-TO-SHIP note had never once fired (in testing on the box: 10 fleet
 * notes delivered, every one 'merged'). The latch-merge skipped any entry whose
 * value looked unchanged, and an empty baseline `[]` joins identically to a
 * MISSING entry — so it was never written. The child stayed permanently unseen,
 * and the poll where it first turned 'ready' was taken for its first sighting and
 * baselined silently. `merged` fired only because an entry existed by then.
 * These three pin the fix without weakening the anti-retroactive rule.
 * ------------------------------------------------------------------ */

test('a child watched from spawn announces its READY — the note that never once fired', async () => {
  const sent = []
  const p = poller(async (n) => {
    sent.push(n.state)
    return { ok: true }
  })
  await p.tick([ORCH, child(null)]) // spawned, working, no ship state yet
  assert.deepEqual(p.state.get('c1'), [], 'the EMPTY baseline must land in the latch, not be skipped as "unchanged"')
  await p.tick([ORCH, child(null)]) // …still working; nothing to say
  assert.equal(p.persists, 1, 'and it settles — an unchanged baseline does not re-persist every tick')

  const r = await p.tick([ORCH, child('ready')]) // ATLAS:READY-TO-SHIP
  assert.deepEqual(sent, ['ready'], 'exactly one ready note — this was ZERO for every child, always')
  assert.equal(r.results[0].delivered, true)
  assert.match(r.results[0].text, /READY TO SHIP/)

  await p.tick([ORCH, child('merged')])
  assert.deepEqual(sent, ['ready', 'merged'], 'and merged still follows, once')
  assert.deepEqual(p.state.get('c1'), ['ready', 'merged'])
})

test('the empty baseline survives a persist/reload round trip', async () => {
  const state = new Map()
  let disk = null
  await deliverShipNotes({
    state,
    notes: [],
    next: new Map([['c1', []]]),
    fails: new Map(),
    deliver: async () => ({ ok: true }),
    persist: () => (disk = JSON.parse(JSON.stringify(dumpShipNotes(state)))),
  })
  assert.deepEqual(disk, { c1: [] }, 'written out as an explicit empty record — ship-notes.json held no `[]` at all before')
  const reloaded = parseShipNotes(disk)
  assert.equal(reloaded.has('c1'), true, 'and reloads as SEEN, distinct from never-seen')
  const { notes } = diffShipNotes(reloaded, [ORCH, child('ready')], parentOf({ c1: 'orch' }))
  assert.deepEqual(notes.map((n) => n.state), ['ready'], 'so a restart mid-flight does not re-swallow the ready note')
})

test('a child first seen ALREADY past the line stays silent — no retroactive burst', async () => {
  const sent = []
  const deliver = async (n) => {
    sent.push(n.state)
    return { ok: true }
  }
  const fresh = poller(deliver) // never seen, and already 'ready' (a redeploy)
  await fresh.tick([ORCH, child('ready')])
  await fresh.tick([ORCH, child('ready')])
  assert.deepEqual(sent, [], 'baselined silently — announcing on first sighting is the flood, not the fix')
  assert.deepEqual(fresh.state.get('c1'), ['ready'])

  // Rollout: the ~20 children on the box already latched at ['ready'].
  const latched = poller(deliver, { state: new Map([['c1', ['ready']]]) })
  await latched.tick([ORCH, child('ready')])
  await latched.tick([ORCH, child('merged')])
  assert.deepEqual(sent, ['merged'], 'existing entries keep their meaning — only the un-announced merged is news')
})

test('parseShipNotes round-trips and rejects junk', () => {
  const map = new Map([['c1', ['ready', 'merged']], ['c2', []]])
  assert.deepEqual([...parseShipNotes(JSON.parse(JSON.stringify(dumpShipNotes(map))))], [...map])
  assert.equal(parseShipNotes(null).size, 0)
  assert.equal(parseShipNotes({ c1: 'ready' }).size, 0) // not an array → dropped
  assert.deepEqual(parseShipNotes({ c1: ['ready', 7] }).get('c1'), ['ready'])
})

/* --- self-caused merges: don't tell a chat what it just did -------- *
 * The orchestrator merges a child's PR itself (its `merge_pr` tool → a recorded
 * claim), and the repo-derived `merged` verdict then reported that action back
 * to it minutes later — measured in testing: every merged note that day was for
 * a merge the recipient had just performed. Suppression is scoped to the
 * CLAIMING chat and to 'merged' alone; everything else notifies as before.
 * ------------------------------------------------------------------ */

const ORCH_B = { id: 'orchB', kind: 'knowledge', vault: 'atlas' }
const mergedByOf = (map) => (id) => map[id]
const merged = { id: 'c1', kind: 'dev', repo: 'demo', task: 'fix search', shipState: 'merged', shipInfo: 'an earlier change merged as abc1234' }

test('a merge the parent performed itself is NOT announced to it — but still latches', () => {
  const { notes, next, suppressed, changed } = diffShipNotes(
    new Map([['c1', ['ready']]]),
    [ORCH, merged],
    parentOf({ c1: 'orch' }),
    mergedByOf({ c1: 'orch' }),
  )
  assert.equal(notes.length, 0)
  assert.deepEqual(suppressed, [{ parentId: 'orch', childId: 'c1', state: 'merged' }])
  assert.deepEqual(next.get('c1'), ['ready', 'merged'], 'settled — it can never resurface later')
  assert.equal(changed, true)
})

test('suppression is per-chat: a merge by ANOTHER Atlas chat still notifies this parent', () => {
  // Several orchestrators run concurrently; chat B merging must not silence chat A.
  const { notes, suppressed } = diffShipNotes(
    new Map([['c1', ['ready']]]),
    [ORCH, ORCH_B, merged],
    parentOf({ c1: 'orch' }),
    mergedByOf({ c1: 'orchB' }),
  )
  assert.equal(notes.length, 1)
  assert.equal(notes[0].parentId, 'orch')
  assert.equal(notes[0].state, 'merged')
  assert.equal(suppressed.length, 0)
})

test('an UNCLAIMED merge (operator on github.com, raw gh pr merge) notifies as today', () => {
  const prev = () => new Map([['c1', ['ready']]])
  for (const mergedBy of [mergedByOf({}), undefined]) {
    const args = [prev(), [ORCH, merged], parentOf({ c1: 'orch' })]
    const { notes, suppressed } = mergedBy ? diffShipNotes(...args, mergedBy) : diffShipNotes(...args)
    assert.equal(notes.length, 1, 'failing to claim degrades to the old behaviour, never to silence')
    assert.equal(notes[0].state, 'merged')
    assert.deepEqual(suppressed, [])
  }
})

test('ready is NEVER suppressed — even for a child this parent later merges', () => {
  const ready = { ...merged, shipState: 'ready', shipInfo: undefined }
  const { notes, suppressed } = diffShipNotes(new Map([['c1', []]]), [ORCH, ready], parentOf({ c1: 'orch' }), mergedByOf({ c1: 'orch' }))
  assert.equal(notes.length, 1)
  assert.equal(notes[0].state, 'ready')
  assert.deepEqual(suppressed, [])
})

test('shipped is NEVER suppressed — the dev agent merged its own PR', () => {
  const shipped = { ...merged, shipState: 'shipped' }
  const { notes, suppressed } = diffShipNotes(new Map([['c1', ['ready']]]), [ORCH, shipped], parentOf({ c1: 'orch' }), mergedByOf({ c1: 'orch' }))
  assert.equal(notes.length, 1)
  assert.equal(notes[0].state, 'shipped')
  assert.deepEqual(suppressed, [])
})

test('a claimed merge does not disturb the flood guards', () => {
  // Suppression sits ON TOP of an earlier change's latch/cap: the claimed 'merged' latches
  // terminally, so a later flap stays silent whether or not it was suppressed.
  const state = new Map([['c1', ['ready']]])
  const seen = []
  for (const shipState of ['merged', 'ready', 'merged']) {
    const r = diffShipNotes(state, [ORCH, { ...merged, shipState }], parentOf({ c1: 'orch' }), mergedByOf({ c1: 'orch' }))
    for (const [k, v] of r.next) state.set(k, v)
    seen.push(...r.notes, ...r.suppressed)
  }
  assert.equal(seen.length, 1, 'exactly one decision for (c1, merged) — and it was to stay quiet')
  assert.deepEqual(state.get('c1'), ['ready', 'merged'])
})

test('the merged note is one line — agent, state, PR + SHA, no cleanup advice', () => {
  const t = noteText(merged, 'merged')
  assert.match(t, /is MERGED/)
  assert.match(t, /an earlier change merged as abc1234/)
  assert.doesNotMatch(t, /cleanup_agent/, 'advice, not news — and wrong for an operator who also gates on deployed + task closed')
  assert.equal(t.includes('\n'), false)
  assert.ok(t.length < 200, `one line, not 532 bytes (was ${t.length})`)
})
