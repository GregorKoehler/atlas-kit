/* ------------------------------------------------------------------ *
 * The ingest log (api/records.mjs).
 *
 * What this pins:
 *   · FAILURES ARE RECORDED, not just successes — "did that one land, and if not
 *     why" is asked minutes later, when the HTTP answer is long gone, and the
 *     failure with its reason is the more useful half of this file;
 *   · the file is written WHOLE with tmp + rename and CAPPED, so a crash
 *     mid-write can only lose the newest record and a long-running box cannot
 *     grow it without bound;
 *   · a corrupt or absent file reads as an EMPTY log rather than throwing into
 *     an ingest that otherwise succeeded.
 *
 * Run: node --test addons/instagram-ingest/test/records.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-records-'))
const file = path.join(dir, 'nested', 'instagram-ingest.json') // nested: the dir is created for us
process.env.ATLAS_IG_RECORDS_FILE = file

const { appendRecord, listRecords, recordsSummary } = await import('../api/records.mjs')

test('an absent log is an empty log, not a throw', () => {
  assert.deepEqual(listRecords(), [])
  assert.deepEqual(recordsSummary(), { file, count: 0, ok: 0, failed: 0, last: null })
})

test('successes AND failures are both recorded, newest first', () => {
  appendRecord({ at: '2026-08-15T09:00:00Z', url: 'https://www.instagram.com/p/A/', ok: true, page: 'Wiki/Sources/instagram-A.md' })
  appendRecord({ at: '2026-08-15T09:05:00Z', url: 'https://www.instagram.com/p/B/', ok: false, error: 'Instagram refused the request' })
  const rows = listRecords()
  assert.deepEqual(
    rows.map((r) => [r.url, r.ok]),
    [
      ['https://www.instagram.com/p/B/', false],
      ['https://www.instagram.com/p/A/', true],
    ],
  )
  const s = recordsSummary()
  assert.equal(s.count, 2)
  assert.equal(s.ok, 1)
  assert.equal(s.failed, 1)
  assert.deepEqual(s.last, { at: '2026-08-15T09:05:00Z', url: 'https://www.instagram.com/p/B/', ok: false, page: null, error: 'Instagram refused the request' })
})

test('the log is capped, keeping the newest — and no .tmp is left behind', () => {
  process.env.ATLAS_IG_MAX_RECORDS = '5'
  for (let i = 0; i < 20; i++) appendRecord({ at: `t${i}`, url: `u${i}`, ok: true })
  const rows = listRecords(100)
  assert.equal(rows.length, 5)
  assert.deepEqual(
    rows.map((r) => r.url),
    ['u19', 'u18', 'u17', 'u16', 'u15'],
  )
  assert.ok(!fs.existsSync(`${file}.tmp`), 'tmp + rename leaves no partial file')
  delete process.env.ATLAS_IG_MAX_RECORDS
})

test('a corrupt log degrades to empty instead of poisoning every later ingest', () => {
  fs.writeFileSync(file, '{ not json')
  assert.deepEqual(listRecords(), [])
  appendRecord({ at: 't', url: 'u', ok: true })
  assert.equal(listRecords().length, 1, 'the next write repairs it')
})

test('listRecords(n) tails, it does not head', () => {
  fs.writeFileSync(file, JSON.stringify({ records: [{ url: 'old' }, { url: 'mid' }, { url: 'new' }] }))
  assert.deepEqual(
    listRecords(2).map((r) => r.url),
    ['new', 'mid'],
  )
})
