/* ------------------------------------------------------------------ *
 * The `voice` addon's client decisions (voice.ts) — the pure half.
 *
 * deriveEvents() is what decides HOW OFTEN THE DASHBOARD SPEAKS, so it is the
 * part worth pinning: a fleet poll that produced an event per poll instead of
 * per transition would turn auto-speak into a dashboard narrating itself, and a
 * first poll that reported history would make every page load recite the day.
 *
 * Runs the real TS module through node's native type-stripping (no build, no
 * browser): everything asserted here is pure — the DOM/speech half of voice.ts
 * is exercised in the browser, not here.
 * Run: node --test web/src/lib/voice.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { agentName, deriveEvents, joinDictation, pickDictation, voiceStatus } from './voice.ts'

const AT = '2026-08-15T12:00:00.000Z'
const session = (over) => ({ id: 'a1', task: 'do a thing', status: 'running', lastOutput: 'tail text', ...over })

test('the first sighting of a session is never an event', () => {
  const { events, snapshot } = deriveEvents({}, [session({ status: 'idle' }), session({ id: 'a2', status: 'done' })], AT)
  assert.deepEqual(events, [])
  assert.deepEqual(snapshot, { a1: { status: 'idle', shipState: undefined }, a2: { status: 'done', shipState: undefined } })
})

test('a turn ends when an agent goes from running to idle — and only then', () => {
  const first = deriveEvents({}, [session({ status: 'running' })], AT)
  const { events } = deriveEvents(first.snapshot, [session({ status: 'idle' })], AT)
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'turn-end')
  assert.match(events[0].line, /ended a turn/)
  assert.equal(events[0].tail, 'tail text', 'the tail rides along, for the optional recap')

  // Still idle on the next poll → nothing new to say.
  const quiet = deriveEvents(
    { a1: { status: 'idle' } },
    [session({ status: 'idle' })],
    AT,
  )
  assert.deepEqual(quiet.events, [])
})

test('a parked agent is announced as waiting on you, not as having ended a turn', () => {
  const { events } = deriveEvents({ a1: { status: 'running' } }, [session({ status: 'idle', menu: true })], AT)
  assert.match(events[0].line, /waiting on you/)
})

test('ship signals: ready once, shipped once, and shipped wins a tie', () => {
  const ready = deriveEvents({ a1: { status: 'running' } }, [session({ status: 'idle', shipState: 'ready' })], AT)
  assert.equal(ready.events[0].kind, 'ready')

  // The same 'ready' on every subsequent poll must NOT re-announce itself.
  const stillReady = deriveEvents(ready.snapshot, [session({ status: 'idle', shipState: 'ready' })], AT)
  assert.deepEqual(stillReady.events, [])

  const shipped = deriveEvents(ready.snapshot, [session({ status: 'done', shipState: 'merged', shipInfo: 'PR #12 abc1234' })], AT)
  assert.equal(shipped.events.length, 1, 'merged AND done in one tick is one piece of news')
  assert.equal(shipped.events[0].kind, 'shipped')
  assert.match(shipped.events[0].line, /PR #12 abc1234/)
})

test('a session that ends or fails says so, once', () => {
  const done = deriveEvents({ a1: { status: 'running' } }, [session({ status: 'done' })], AT)
  assert.equal(done.events[0].kind, 'done')
  assert.deepEqual(deriveEvents(done.snapshot, [session({ status: 'done' })], AT).events, [])

  const failed = deriveEvents({ a1: { status: 'running' } }, [session({ status: 'error' })], AT)
  assert.equal(failed.events[0].kind, 'error')
})

test('events carry a key that is stable per agent, kind and poll', () => {
  const { events } = deriveEvents({ a1: { status: 'running' } }, [session({ status: 'idle' })], AT)
  assert.equal(events[0].key, `a1:turn-end:${AT}`)
})

test('an agent is named for the ear: shortest useful label, truncated', () => {
  assert.equal(agentName({ micro: 'docs sweep', title: 'Sweep the docs', task: 'x', id: 'a1' }), 'docs sweep')
  assert.equal(agentName({ title: 'Sweep the docs', task: 'x', id: 'a1' }), 'Sweep the docs')
  assert.equal(agentName({ task: '  a  long   task  ', id: 'a1' }), 'a long task')
  assert.equal(agentName({ id: 'a1' }), 'a1')
  const long = agentName({ task: 'x'.repeat(200), id: 'a1' })
  assert.equal(long.length, 58)
  assert.ok(long.endsWith('…'))
})

test('dictation appends to the draft — it never replaces it', () => {
  assert.equal(joinDictation('Fix the', ' parser  bug '), 'Fix the parser bug')
  assert.equal(joinDictation('', 'from scratch'), 'from scratch')
  assert.equal(joinDictation('typed only', ''), 'typed only')
})

test('the browser engine wins where it exists; the box is the fallback; neither is a reason', () => {
  assert.deepEqual(pickDictation(true, true), { engine: 'browser', reason: '' })
  assert.deepEqual(pickDictation(true, false), { engine: 'browser', reason: '' })
  assert.equal(pickDictation(false, true).engine, 'on-box')
  const none = pickDictation(false, false)
  assert.equal(none.engine, 'none')
  assert.match(none.reason, /ATLAS_VOICE_STT_CMD/)
})

test('voiceStatus tolerates an addon that is absent or answering something else', () => {
  assert.equal(voiceStatus(null), null)
  assert.equal(voiceStatus({ name: 'voice', description: '', hooks: [], status: null }), null)
  assert.equal(voiceStatus({ name: 'voice', description: '', hooks: [], status: { error: 'boom' } }), null)
  const real = { tts: { configured: false, available: false }, stt: { configured: false, available: false } }
  assert.equal(voiceStatus({ name: 'voice', description: '', hooks: [], status: real }), real)
})
