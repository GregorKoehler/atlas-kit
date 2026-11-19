/* ------------------------------------------------------------------ *
 * `sweep.json` — the index sweep's OWN state file, and the scorecard group read
 * off it.
 *
 * 🔴 ONE WRITER PER FILE. `data/scorecard.json` is written WHOLESALE by its own
 * producer (e.g. scripts/refresh-github.mjs). This sweep must never write it:
 * two producers read-modify-writing one JSON is a silent clobber — whichever ran
 * last wins, and the loser's numbers vanish with no error anywhere. So the sweep
 * keeps its counters in the ~150-byte `sweep.json` it ALREADY writes beside the
 * index, and the core dashboard bundle JOINS THE TWO AT READ TIME (the
 * `scorecardStats` addon hook → `read-routes.mjs`'s `scorecardData()`). This
 * module is that contract, in one place, so the writer (scripts/index.mjs) and
 * the reader cannot drift apart.
 *
 * ⚠️ THE SWEEP MUST STAY CHEAP. A no-op sweep is a measured ~0.33 s and it runs
 * every few minutes, so the roll-forward below is a 150-byte read and a 150-byte
 * write — no vault walk, no git call, and above all no touching the multi-MB
 * `meta.json`, which no-op sweeps deliberately leave alone.
 *
 * ⚠️ THE FILE IS BOUNDED BY SHAPE, not by pruning: a fixed set of scalar keys
 * and one day counter that RESETS on date change. There is no history array to
 * grow — the scorecard wants "today", and yesterday's number has no reader.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'

/** Six missed sweeps of the five-minute indexer. Past this the index is not "a
 * little behind" — something has stopped, which is the failure this card exists
 * to catch. */
export const STALE_MINUTES = Number(process.env.ATLAS_SEMANTIC_STALE_MINUTES || 30)

/** Local calendar date, `YYYY-MM-DD`. LOCAL, not UTC, and deliberately the same
 * convention a GitHub-contributions refresher uses for its today/yesterday
 * counts — the two halves of one card must not roll over at different moments. */
export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** The sweep state for an index dir, or null (no index, never swept). */
export function readSweep(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'sweep.json'), 'utf-8'))
  } catch {
    return null
  }
}

/**
 * How many of a vector file's rows hold a vector. A written vector is L2-normalised
 * and can never be all-zero; an unwritten slot always is, and the first two floats
 * decide it, the same test `loadIndex` uses. For an index with no `meta.filled` (one
 * built before the field existed), so it reads 8 bytes per row rather than the whole
 * file: this can run on the API's main thread, once per index change. Throws.
 */
export function countFilled(file, rows, dims) {
  const fd = fs.openSync(file, 'r')
  try {
    const b = Buffer.alloc(8)
    let n = 0
    for (let i = 0; i < rows; i++) {
      if (fs.readSync(fd, b, 0, 8, i * dims * 4) < 8) break
      if (b.readFloatLE(0) !== 0 || b.readFloatLE(4) !== 0) n++
    }
    return n
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * The next `sweep.json`, given the previous one and what this run did. Pure.
 *
 * The daily counter accumulates while `day` matches and RESETS the moment it
 * does not — including when `prev` predates this field entirely (an index built
 * before the counters existed), which is the same case as "a new day" and needs
 * no migration. A corrupt or non-numeric carry-over resets rather than poisoning
 * the tally with NaN, which would render as a broken tile forever.
 *
 * ⚠️ AN ABORTED RUN DOES NOT STAMP `sweptAt` or `vaultSha`. `sweptAt` means "a sweep
 * confirmed the index matches the vault", and an aborted run confirmed nothing: a
 * scorecard saying "last swept 21 min" over an index 18 % full is the reading this
 * prevents. Its embeds still count in `embeddedToday`, because that tile is the
 * work spent, kept or not. `aborted` is the LAST run's state, cleared by the next
 * run that finishes.
 */
export function rollSweep(prev, next) {
  const sameDay = prev?.day === next.day
  const carry = sameDay && Number.isFinite(prev?.embeddedToday) ? prev.embeddedToday : 0
  const abortCarry = sameDay && Number.isFinite(prev?.abortedToday) ? prev.abortedToday : 0
  return {
    sweptAt: next.aborted ? prev?.sweptAt : next.sweptAt,
    vaultSha: next.aborted ? prev?.vaultSha : next.vaultSha,
    chunks: next.chunks,
    filled: next.filled,
    changed: next.changed,
    day: next.day,
    embeddedToday: carry + (Number.isFinite(next.embedded) ? next.embedded : 0),
    abortedToday: abortCarry + (next.aborted ? 1 : 0),
    aborted: next.aborted ? { at: next.sweptAt, reason: String(next.aborted).slice(0, 160) } : null,
  }
}

const fmtAge = (min) => {
  if (min < 60) return `${min} min`
  if (min < 48 * 60) return `${Math.round(min / 60)} h`
  return `${Math.round(min / 1440)} d`
}

/**
 * The `Semantic index` scorecard group. Pure — takes the sweep state, returns
 * the `Stat[]` the core dashboard bundle appends to `data/scorecard.json`'s own.
 *
 * ⚠️ `trend` MEANS "is this good", not "did the number rise" — the renderer
 * paints `up` green and `down` red, and there is no other colour channel on a
 * tile. So a growing index age is `down`, never `up`: a stale index is a
 * PROBLEM, and painting it green would invert the one signal this group is here
 * for. Churn is `neutral` in both directions — hundreds of re-embedded chunks
 * means the operator wrote a lot, which is neither good nor bad.
 *
 * ⚠️ A ZERO THAT MEANS "BROKEN" AND A ZERO THAT MEANS "NOTHING CHANGED" MUST
 * NOT LOOK IDENTICAL. Never swept (no encoder, no index, an addon enabled but
 * never installed) renders NOTHING — silence, not a row of zeroes and not a
 * permanent "not running" tile that becomes wallpaper. And once the sweep is
 * stale, today's churn is UNKNOWN rather than zero, so it renders `—`: a
 * stopped sweep re-embeds nothing, and reporting that as a quiet `0` is exactly
 * the reading that would hide the outage.
 *
 * ⚠️ `Chunks indexed` IS FILLED OF TOTAL, red below full. Rows alone is what read
 * "every chunk indexed" over an index 18 % full. A sweep.json from before the
 * field says `—`: unknown, never the total. And `Last run` appears only when it
 * aborted, so an index that aborted before any sweep finished still shows up.
 */
export function sweepStats(sweep, now = Date.now()) {
  const swept = Date.parse(sweep?.sweptAt ?? '')
  const everSwept = Number.isFinite(swept)
  if (!everSwept && !sweep?.aborted) return []
  const ageMin = everSwept ? Math.max(0, Math.round((now - swept) / 60000)) : null
  const stale = !everSwept || ageMin > STALE_MINUTES
  const group = 'Semantic index'
  const total = Number.isFinite(sweep.chunks) ? sweep.chunks : null
  const filled = Number.isFinite(sweep.filled) ? sweep.filled : null
  return [
    { label: 'Last swept', value: everSwept ? fmtAge(ageMin) : 'never', trend: stale ? 'down' : 'neutral', group },
    {
      label: 'Re-embedded today',
      value: stale ? '—' : (sweep.day === dayKey(new Date(now)) ? (sweep.embeddedToday ?? 0) : 0).toLocaleString('en-US'),
      trend: 'neutral',
      group,
    },
    {
      label: 'Chunks indexed',
      value: total === null ? '—' : `${filled === null ? '—' : filled.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`,
      trend: filled !== null && total !== null && filled < total ? 'down' : 'neutral',
      group,
    },
    ...(sweep.aborted ? [{ label: 'Last run', value: 'aborted', trend: 'down', group }] : []),
  ]
}
