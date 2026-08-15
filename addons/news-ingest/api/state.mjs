/* ------------------------------------------------------------------ *
 * The persistent memory of the sweep: what has already been ingested, and how
 * the last runs went.
 *
 *   { seen: { <key>: { at, title, url, feed, page } }, runs: [ … ] }
 *
 * 🔴 `seen` IS THE DEDUPE, AND IT IS WRITTEN ONLY AFTER THE COMMIT LANDS. A feed
 * re-serves the same items every time it is polled, so without this file every
 * sweep would re-summarize (and re-commit) the whole front page — the cost of
 * losing it is money, not just noise. Marking an item seen BEFORE its page is
 * committed would be the opposite failure: a failed commit would drop the item
 * forever, silently. So the sweep marks after, and a failed run simply retries.
 *
 * Stored OUTSIDE the vault, like every other piece of dashboard bookkeeping:
 * this is a record of ingests, not knowledge. Written whole with tmp + rename
 * and capped, exactly like api/src/atlas-prospects.mjs — a crash mid-write can
 * then only lose the newest entries, never corrupt the file.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { stateFile, limits } from './config.mjs'

/** Never throws: an absent or unreadable file is the first-run state.
 *
 *  ⚠️ Every call returns FRESH objects — callers mutate what they get (the sweep
 *  writes into `seen` before saving), and handing two callers one shared empty
 *  map would leak the first run's items into the next process-wide "empty" read. */
export function readState(file = stateFile()) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return {
      seen: j?.seen && typeof j.seen === 'object' && !Array.isArray(j.seen) ? j.seen : {},
      runs: Array.isArray(j?.runs) ? j.runs : [],
    }
  } catch {
    return { seen: {}, runs: [] }
  }
}

const byNewest = (a, b) => String(b[1]?.at || '').localeCompare(String(a[1]?.at || ''))

/** Cap `seen` by dropping the OLDEST entries. Feeds carry tens of items, so the
 *  default ceiling is far above what any feed can re-serve — an entry only ages
 *  out long after its item has fallen off every feed that carried it. */
export function pruneSeen(state, max = limits().seen) {
  const rows = Object.entries(state.seen).sort(byNewest).slice(0, Math.max(1, max))
  state.seen = Object.fromEntries(rows)
  return state
}

/** Write it whole. Returns false (loudly) rather than throwing — losing the log
 *  must not fail a run whose pages actually landed. */
export function saveState(state, file = stateFile()) {
  try {
    pruneSeen(state)
    state.runs = state.runs.slice(-limits().runs)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8')
    fs.renameSync(tmp, file)
    return true
  } catch (e) {
    console.error(`[news-ingest] could not write the state file (${file}): ${e.message}`)
    return false
  }
}

/** Ingested items, newest first — what the digest page and `GET /api/news` show. */
export function recentItems(state, limit = 40) {
  return Object.entries(state.seen)
    .sort(byNewest)
    .slice(0, Math.max(0, limit))
    .map(([key, v]) => ({ key, ...v }))
}

/** The run log, newest first. Failures are the valuable half — they are recorded
 *  with their reason, not only logged. */
export const recentRuns = (state, limit = 10) => state.runs.slice(-Math.max(0, limit)).reverse()

/** A one-glance summary for `GET /api/addons`. */
export function stateSummary(state, file = stateFile()) {
  const last = state.runs[state.runs.length - 1] || null
  return {
    stateFile: file,
    ingested: Object.keys(state.seen).length,
    runs: state.runs.length,
    last: last && {
      at: last.at,
      feeds: last.feeds,
      new: last.new,
      written: last.written,
      errors: last.errors?.length || 0,
      ok: last.ok,
    },
  }
}
