/* ------------------------------------------------------------------ *
 * The ingest log — one persistent record per finished ingest, SUCCESS OR NOT.
 *
 * Why it exists: an ingest is a spawn of two external programs against a service
 * that rate-limits and expires sessions, so "did that one land, and if not why"
 * is a question the operator and an agent both ask minutes later, when the HTTP
 * response is long gone. A failure with its reason is the more valuable half of
 * this file, which is why failures are recorded rather than only logged.
 *
 * Stored OUTSIDE the vault (the same place the agent runtime keeps its state):
 * this is bookkeeping about ingests, not knowledge, and a failed ingest must not
 * leave a commit behind. Written whole with tmp + rename and capped, exactly like
 * api/src/atlas-prospects.mjs — a crash mid-write can then only lose the newest
 * record, never corrupt the file.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { recordsFile, limits } from './config.mjs'

function load(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return Array.isArray(j?.records) ? j.records : []
  } catch {
    return [] // absent or unreadable → an empty log, which is the first-run state
  }
}

/** Newest first — the order every reader (UI, agent, `--check`) wants. */
export function listRecords(limit = 50) {
  const rows = load(recordsFile())
  return rows.slice(-Math.max(0, limit)).reverse()
}

/** Append one record, capped. Never throws: losing the log must not fail an
 *  ingest that actually landed. Returns the record. */
export function appendRecord(rec) {
  const file = recordsFile()
  try {
    const rows = load(file)
    rows.push(rec)
    const capped = rows.slice(-limits().records)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ records: capped }, null, 2), 'utf-8')
    fs.renameSync(tmp, file)
  } catch (e) {
    console.error(`[instagram-ingest] could not write the ingest log (${file}): ${e.message}`)
  }
  return rec
}

/** A one-glance summary for `GET /api/addons` — how many, and how the last one went. */
export function recordsSummary() {
  const rows = load(recordsFile())
  const last = rows[rows.length - 1]
  return {
    file: recordsFile(),
    count: rows.length,
    ok: rows.filter((r) => r.ok).length,
    failed: rows.filter((r) => !r.ok).length,
    last: last ? { at: last.at, url: last.url, ok: last.ok, page: last.page || null, error: last.error || null } : null,
  }
}
