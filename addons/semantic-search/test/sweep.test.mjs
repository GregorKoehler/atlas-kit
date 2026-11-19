/* ------------------------------------------------------------------ *
 * The sweep's state file and its scorecard group (api/sweep.mjs).
 *
 * What this pins, and why each one is a real failure and not a style point:
 *   · a ZERO THAT MEANS "BROKEN" and a zero that means "nothing changed" must
 *     not render identically — never-swept renders NOTHING, and a stale sweep
 *     renders `—` rather than a reassuring 0;
 *   · `trend` means "is this good", not "did it rise": a growing index age is
 *     `down` (red), because green on a stale index inverts the one signal the
 *     group exists for;
 *   · the daily counter accumulates within a day and RESETS across one, and a
 *     corrupt carry-over resets instead of poisoning the tile with NaN forever;
 *   · a partial may not read as a whole: `Chunks indexed` is filled OF total, red
 *     below full, and an aborted run neither stamps `sweptAt` nor goes unshown.
 *
 * Run: node --test addons/semantic-search/test/sweep.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dayKey, readSweep, rollSweep, sweepStats, STALE_MINUTES } from '../api/sweep.mjs'

const NOW = Date.parse('2026-03-04T12:00:00Z')
const agoMin = (m) => new Date(NOW - m * 60000).toISOString()
const tile = (rows, label) => rows.find((r) => r.label === label)

test('never swept renders NOTHING — silence, not a row of zeroes', () => {
  assert.deepEqual(sweepStats(null, NOW), [])
  assert.deepEqual(sweepStats({}, NOW), [])
  assert.deepEqual(sweepStats({ sweptAt: 'not a date' }, NOW), [])
})

test('a fresh sweep renders three neutral tiles under one group', () => {
  const rows = sweepStats({ sweptAt: agoMin(4), chunks: 11445, filled: 11445, day: dayKey(new Date(NOW)), embeddedToday: 37 }, NOW)
  assert.deepEqual(
    rows.map((r) => r.group),
    ['Semantic index', 'Semantic index', 'Semantic index'],
  )
  assert.equal(tile(rows, 'Last swept').value, '4 min')
  assert.equal(tile(rows, 'Last swept').trend, 'neutral')
  assert.equal(tile(rows, 'Re-embedded today').value, '37')
  assert.equal(tile(rows, 'Chunks indexed').value, '11,445 of 11,445')
  assert.equal(tile(rows, 'Chunks indexed').trend, 'neutral')
})

test('a stale sweep is `down` (red), and today’s churn becomes `—`, never 0', () => {
  const rows = sweepStats({ sweptAt: agoMin(STALE_MINUTES + 1), chunks: 11445, filled: 11445, day: dayKey(new Date(NOW)), embeddedToday: 37 }, NOW)
  assert.equal(tile(rows, 'Last swept').trend, 'down', 'a growing age must never paint green')
  assert.equal(tile(rows, 'Re-embedded today').value, '—', 'a stopped sweep re-embeds nothing; reporting that as 0 hides the outage')
  // Chunk count is still a fact about the index on disk, so it stays.
  assert.equal(tile(rows, 'Chunks indexed').value, '11,445 of 11,445')
})

test('ages read in the right unit, and yesterday’s counter does not leak into today', () => {
  assert.equal(tile(sweepStats({ sweptAt: agoMin(90), chunks: 1 }, NOW), 'Last swept').value, '2 h')
  assert.equal(tile(sweepStats({ sweptAt: agoMin(60 * 72), chunks: 1 }, NOW), 'Last swept').value, '3 d')
  const rows = sweepStats({ sweptAt: agoMin(2), chunks: 5, day: '2026-03-03', embeddedToday: 900 }, NOW)
  assert.equal(tile(rows, 'Re-embedded today').value, '0', 'a counter stamped with another day is 0 today, not 900')
})

test('a missing chunk count renders `—`, not NaN', () => {
  assert.equal(tile(sweepStats({ sweptAt: agoMin(1) }, NOW), 'Chunks indexed').value, '—')
})

test('rollSweep accumulates within a day and resets across one', () => {
  const next = { sweptAt: agoMin(0), vaultSha: 'abc', chunks: 10, changed: true, embedded: 5, day: '2026-03-04' }
  assert.equal(rollSweep({ day: '2026-03-04', embeddedToday: 12 }, next).embeddedToday, 17)
  assert.equal(rollSweep({ day: '2026-03-03', embeddedToday: 12 }, next).embeddedToday, 5)
  assert.equal(rollSweep(null, next).embeddedToday, 5, 'a first sweep starts the counter')
  // An index built before the counters existed is the same case as a new day —
  // no migration needed, and no NaN inherited from a corrupt carry-over.
  assert.equal(rollSweep({ day: '2026-03-04' }, next).embeddedToday, 5)
  assert.equal(rollSweep({ day: '2026-03-04', embeddedToday: 'oops' }, next).embeddedToday, 5)
  assert.equal(rollSweep({ day: '2026-03-04', embeddedToday: 3 }, { ...next, embedded: undefined }).embeddedToday, 3)
})

test('rollSweep keeps the file bounded BY SHAPE — a fixed key set, no history array', () => {
  const out = rollSweep({ day: '2026-03-04', embeddedToday: 1 }, { sweptAt: agoMin(0), vaultSha: 'abc', chunks: 10, changed: false, embedded: 0, day: '2026-03-04' })
  assert.deepEqual(Object.keys(out).sort(), ['aborted', 'abortedToday', 'changed', 'chunks', 'day', 'embeddedToday', 'filled', 'sweptAt', 'vaultSha'])
  assert.ok(JSON.stringify(out).length < 400, 'sweep.json must stay tiny — it is rewritten every few minutes')
  // An abort reason is free text from an exception, and is capped.
  const a = rollSweep(out, { sweptAt: agoMin(0), vaultSha: 'abc', chunks: 10, filled: 1, changed: false, embedded: 0, day: '2026-03-04', aborted: 'x'.repeat(5000) })
  assert.ok(JSON.stringify(a).length < 500)
})

test('an aborted run keeps the last confirmation and counts itself; a finished run clears the state', () => {
  const clean = rollSweep(null, { sweptAt: 'T1', vaultSha: 'sha1', chunks: 10, filled: 10, changed: true, embedded: 10, day: '2026-03-04' })
  assert.equal(clean.aborted, null)
  const bad = rollSweep(clean, { sweptAt: 'T2', vaultSha: 'sha2', chunks: 10, filled: 4, changed: true, embedded: 3, day: '2026-03-04', aborted: 'ABORTED on memory headroom' })
  assert.equal(bad.sweptAt, 'T1')
  assert.equal(bad.vaultSha, 'sha1')
  assert.deepEqual(bad.aborted, { at: 'T2', reason: 'ABORTED on memory headroom' })
  assert.equal(bad.abortedToday, 1)
  assert.equal(bad.embeddedToday, 13, 'the work was spent, kept or not')
  const twice = rollSweep(bad, { sweptAt: 'T3', vaultSha: 'sha3', chunks: 10, filled: 4, changed: false, embedded: 0, day: '2026-03-04', aborted: 'again' })
  assert.equal(twice.abortedToday, 2)
  const healed = rollSweep(twice, { sweptAt: 'T4', vaultSha: 'sha4', chunks: 10, filled: 10, changed: true, embedded: 6, day: '2026-03-04' })
  assert.equal(healed.sweptAt, 'T4')
  assert.equal(healed.aborted, null)
  assert.equal(healed.abortedToday, 2, 'today`s count is history, the state is not')
  assert.equal(rollSweep(healed, { sweptAt: 'T5', chunks: 10, filled: 10, changed: false, day: '2026-03-05' }).abortedToday, 0)
})

test('a hollow index reads as filled of total, in red — never as every chunk indexed', () => {
  const rows = sweepStats({ sweptAt: agoMin(4), chunks: 13238, filled: 2427 }, NOW)
  assert.equal(tile(rows, 'Chunks indexed').value, '2,427 of 13,238')
  assert.equal(tile(rows, 'Chunks indexed').trend, 'down')
})

test('a sweep.json from before `filled` says unknown, never the total', () => {
  const rows = sweepStats({ sweptAt: agoMin(4), chunks: 13238 }, NOW)
  assert.equal(tile(rows, 'Chunks indexed').value, '— of 13,238')
  assert.equal(tile(rows, 'Chunks indexed').trend, 'neutral')
})

test('the aborted tile shows only for an aborted last run, in red', () => {
  const base = { sweptAt: agoMin(4), chunks: 10, filled: 10 }
  assert.equal(tile(sweepStats(base, NOW), 'Last run'), undefined)
  assert.equal(tile(sweepStats({ ...base, aborted: null }, NOW), 'Last run'), undefined)
  const rows = sweepStats({ ...base, aborted: { at: 'x', reason: 'y' } }, NOW)
  assert.equal(tile(rows, 'Last run').value, 'aborted')
  assert.equal(tile(rows, 'Last run').trend, 'down')
})

test('aborted before any sweep ever finished: visible, and never a fresh age', () => {
  const rows = sweepStats({ chunks: 100, filled: 3, aborted: { at: 'x', reason: 'y' } }, NOW)
  assert.equal(tile(rows, 'Last swept').value, 'never')
  assert.equal(tile(rows, 'Last swept').trend, 'down')
  assert.equal(tile(rows, 'Chunks indexed').value, '3 of 100')
})

test('readSweep: absent, unreadable and corrupt all read as null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-sweep-'))
  assert.equal(readSweep(dir), null)
  fs.writeFileSync(path.join(dir, 'sweep.json'), '{ not json')
  assert.equal(readSweep(dir), null)
  fs.writeFileSync(path.join(dir, 'sweep.json'), JSON.stringify({ sweptAt: agoMin(1), chunks: 3 }))
  assert.equal(readSweep(dir).chunks, 3)
})
