/* ------------------------------------------------------------------ *
 * The seen-state file: the thing that stops every sweep from re-summarizing the
 * same front page, and therefore the thing whose failure costs money.
 *
 * What this pins: a missing/corrupt file is the first-run state rather than a
 * crash, the cap drops the OLDEST entries (never the newest, which are the ones
 * still on a feed), and the run log is bounded too.
 *
 * Run: node --test addons/news-ingest/test/state.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-news-state-'))
const file = path.join(dir, 'nested', 'news-ingest.json')
process.env.ATLAS_NEWS_STATE_FILE = file
process.env.ATLAS_NEWS_MAX_SEEN = '3'
process.env.ATLAS_NEWS_MAX_RUNS = '2'

const { readState, saveState, pruneSeen, recentItems, recentRuns, stateSummary } = await import('../api/state.mjs')

const entry = (n, day) => [`key-${n}`, { at: `2026-08-${day}T00:00:00.000Z`, title: `Item ${n}`, url: `https://e/${n}`, feed: 'f', page: `Wiki/Sources/news-${n}.md` }]

test('an absent file reads as the first-run state', () => {
  assert.deepEqual(readState(), { seen: {}, runs: [] })
})

test('a corrupt file reads as the first-run state too — never a throw', () => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{ truncated…')
  assert.deepEqual(readState(), { seen: {}, runs: [] })
  fs.rmSync(file)
})

test('save → read round-trips, creating the directory on the way', () => {
  const state = { seen: Object.fromEntries([entry(1, '11'), entry(2, '12')]), runs: [{ at: 'a', ok: true }] }
  assert.equal(saveState(state), true)
  const back = readState()
  assert.equal(Object.keys(back.seen).length, 2)
  assert.equal(back.seen['key-2'].title, 'Item 2')
  assert.equal(back.runs.length, 1)
})

test('the cap drops the OLDEST entries, and the run log is bounded', () => {
  const state = {
    seen: Object.fromEntries([entry(1, '11'), entry(2, '12'), entry(3, '13'), entry(4, '14')]),
    runs: [{ at: '1' }, { at: '2' }, { at: '3' }],
  }
  saveState(state)
  const back = readState()
  assert.deepEqual(Object.keys(back.seen).sort(), ['key-2', 'key-3', 'key-4'], 'the newest 3 survive — those are the ones still on a feed')
  assert.deepEqual(back.runs.map((r) => r.at), ['2', '3'], 'the run log keeps the LATEST runs')
})

test('recentItems and recentRuns are newest-first', () => {
  const state = readState()
  assert.deepEqual(
    recentItems(state).map((i) => i.title),
    ['Item 4', 'Item 3', 'Item 2'],
  )
  assert.deepEqual(recentItems(state, 1).map((i) => i.title), ['Item 4'])
  assert.deepEqual(recentRuns(state).map((r) => r.at), ['3', '2'])
})

test('an entry with no timestamp sinks rather than poisoning the sort', () => {
  const state = { seen: { ...readState().seen, undated: { title: 'No at' } }, runs: [] }
  pruneSeen(state, 4)
  assert.equal(Object.keys(state.seen).length, 4)
  assert.equal(recentItems(state).at(-1).key, 'undated')
})

test('the summary is what GET /api/addons shows', () => {
  const state = readState()
  state.runs.push({ at: 'z', feeds: 2, new: 3, written: 3, errors: ['one feed failed'], ok: true })
  const s = stateSummary(state)
  assert.equal(s.stateFile, file)
  assert.equal(s.ingested, 3)
  assert.deepEqual(s.last, { at: 'z', feeds: 2, new: 3, written: 3, errors: 1, ok: true })
})

test('an unwritable path is loud, not fatal', () => {
  const state = { seen: {}, runs: [] }
  assert.equal(saveState(state, path.join(file, 'not-a-dir', 'x.json')), false)
})

test.after(() => fs.rmSync(dir, { recursive: true, force: true }))
