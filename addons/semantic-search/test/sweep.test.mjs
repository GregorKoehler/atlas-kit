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
 *     corrupt carry-over resets instead of poisoning the tile with NaN forever.
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
  const rows = sweepStats({ sweptAt: agoMin(4), chunks: 11445, day: dayKey(new Date(NOW)), embeddedToday: 37 }, NOW)
  assert.deepEqual(
    rows.map((r) => r.group),
    ['Semantic index', 'Semantic index', 'Semantic index'],
  )
  assert.equal(tile(rows, 'Last swept').value, '4 min')
  assert.equal(tile(rows, 'Last swept').trend, 'neutral')
  assert.equal(tile(rows, 'Re-embedded today').value, '37')
  assert.equal(tile(rows, 'Chunks indexed').value, '11,445')
})

test('a stale sweep is `down` (red), and today’s churn becomes `—`, never 0', () => {
  const rows = sweepStats({ sweptAt: agoMin(STALE_MINUTES + 1), chunks: 11445, day: dayKey(new Date(NOW)), embeddedToday: 37 }, NOW)
  assert.equal(tile(rows, 'Last swept').trend, 'down', 'a growing age must never paint green')
  assert.equal(tile(rows, 'Re-embedded today').value, '—', 'a stopped sweep re-embeds nothing; reporting that as 0 hides the outage')
  // Chunk count is still a fact about the index on disk, so it stays.
  assert.equal(tile(rows, 'Chunks indexed').value, '11,445')
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
  assert.deepEqual(Object.keys(out).sort(), ['changed', 'chunks', 'day', 'embeddedToday', 'sweptAt', 'vaultSha'])
  assert.ok(JSON.stringify(out).length < 400, 'sweep.json must stay tiny — it is rewritten every few minutes')
})

test('readSweep: absent, unreadable and corrupt all read as null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-sweep-'))
  assert.equal(readSweep(dir), null)
  fs.writeFileSync(path.join(dir, 'sweep.json'), '{ not json')
  assert.equal(readSweep(dir), null)
  fs.writeFileSync(path.join(dir, 'sweep.json'), JSON.stringify({ sweptAt: agoMin(1), chunks: 3 }))
  assert.equal(readSweep(dir).chunks, 3)
})
