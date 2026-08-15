/* ------------------------------------------------------------------ *
 * GitHub contributions → the Scorecard's "GitHub" group + its sparkline.
 *
 * Pulls your contribution calendar (the green grid on your profile) and writes
 * the two OPTIONAL data files the API already serves:
 *
 *   <DATA_DIR>/heatmap.json    { generated, days: [{ date, count }] }
 *   <DATA_DIR>/scorecard.json  { generated, stats: [...] }
 *
 * DATA_DIR is resolved EXACTLY as api/src/read-routes.mjs resolves it
 * (`DATA_DIR`, else `<VAULT_PATH>/data`) — a producer writing one path while the
 * reader reads another is a blank card with nothing to debug.
 *
 * Config: `ATLAS_GITHUB_USER` (whose profile to read). Auth: the **`gh` CLI on
 * your own login** — no token in `.env`, no API key. Because `gh` runs as you,
 * `restrictedContributionsCount` (private-repo activity the calendar anonymises)
 * is included, so the total matches what your profile shows.
 *
 * A CLEAN NO-OP when `ATLAS_GITHUB_USER` is blank, `gh` is missing, or `gh` is
 * not logged in: it says why and exits 0. An unconfigured install therefore has
 * no GitHub tile and no error anywhere — the Scorecard renders whatever else it
 * has (agent work, addon stats) exactly as before.
 *
 *   node --env-file=.env scripts/refresh-github.mjs
 *
 * Cron-wired in infra/atlas-kit.cron; the dashboard also fires
 * POST /api/refresh/github on open (cooldown-guarded).
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const VAULT = process.env.VAULT_PATH || process.env.VAULT_DIR || '/vault'

/** Where the machine-written dashboard JSON lives — read-routes.mjs's rule. */
export const dataDir = () => process.env.DATA_DIR || path.join(VAULT, 'data')

export const QUERY = `query($login:String!,$from:DateTime!,$to:DateTime!){
  user(login:$login){ contributionsCollection(from:$from,to:$to){
    restrictedContributionsCount
    contributionCalendar{ totalContributions weeks{ contributionDays{ date contributionCount } } }
  } }
}`

/** The Scorecard tiles this script OWNS. Must keep matching `isGithubStat` in
 *  web/src/components/cards/Scorecard.tsx — that predicate is what anchors the
 *  cumulative sparkline after the last GitHub tile, so a label drift on either
 *  side silently unanchors it. Pinned by api/test/refresh-github.test.mjs. */
export const ownsStat = (label) =>
  /github contributions/i.test(label) || /^contributions (today|yesterday)$/i.test(label)

/** One year back from `to`, as the two ISO timestamps the query wants. */
export function yearWindow(to = new Date()) {
  const from = new Date(to)
  from.setFullYear(to.getFullYear() - 1)
  return { from: from.toISOString(), to: to.toISOString() }
}

function ghGraphql(login, from, to) {
  const out = execFileSync(
    'gh',
    ['api', 'graphql', '-f', `query=${QUERY}`, '-f', `login=${login}`, '-f', `from=${from}`, '-f', `to=${to}`],
    { encoding: 'utf-8', timeout: 30000 },
  )
  return JSON.parse(out)
}

/** The API payload → { total, days }. Throws on a shape the query cannot have
 *  returned (a wrong login, a partial error) rather than writing a hollow file. */
export function parseContributions(payload) {
  const cc = payload?.data?.user?.contributionsCollection
  const cal = cc?.contributionCalendar
  if (!cal || !Array.isArray(cal.weeks)) throw new Error('no contribution calendar in the response')
  const days = cal.weeks
    .flatMap((w) => w?.contributionDays ?? [])
    .map((d) => ({ date: d.date, count: d.contributionCount }))
  return { total: (cal.totalContributions || 0) + (cc.restrictedContributionsCount ?? 0), days }
}

/** Count for the LOCAL day `offset` days from `now` (0 = today, -1 = yesterday).
 *  Local, not UTC: "contributions today" has to mean the operator's today, and
 *  GitHub's calendar dates are already in their profile timezone. */
export function dayCount(days, offset, now = new Date()) {
  const d = new Date(now)
  d.setDate(d.getDate() + offset)
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return days.find((x) => x.date === key)?.count ?? 0
}

/** The three tiles, in render order. `group: 'GitHub'` heads their frame. */
export function githubStats({ total, todayCount, yesterdayCount }) {
  return [
    { label: 'GitHub Contributions (1y)', value: total.toLocaleString('en-US'), trend: 'neutral', group: 'GitHub' },
    { label: 'Contributions Today', value: String(todayCount), trend: todayCount > 0 ? 'up' : 'neutral', group: 'GitHub' },
    { label: 'Contributions Yesterday', value: String(yesterdayCount), trend: 'neutral', group: 'GitHub' },
  ]
}

/** Ours first, everything we don't own preserved verbatim — the file is shared
 *  with whatever else an operator writes into it, so this is a merge, never a
 *  clobber. (Addon tiles don't come through here at all: they are joined at read
 *  time in read-routes.mjs and never touch the file.) */
export function mergeScorecard(existing, stats, generated) {
  const kept = (existing?.stats ?? []).filter((s) => !ownsStat(s.label))
  return { generated, stats: [...stats, ...kept] }
}

/** Fetch → write both files. `run` is injectable so the tests exercise the whole
 *  path off a fixture, with no network and no `gh`. Returns a summary line. */
export function refresh({ login, run = ghGraphql, now = new Date() } = {}) {
  const { from, to } = yearWindow(now)
  const payload = run(login, from, to)
  if (payload?.errors?.length) throw new Error(`GraphQL error: ${JSON.stringify(payload.errors)}`)
  const { total, days } = parseContributions(payload)
  const generated = now.toISOString()
  const dir = dataDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'heatmap.json'), JSON.stringify({ generated, days }, null, 2) + '\n')

  const scPath = path.join(dir, 'scorecard.json')
  let existing = null
  try {
    existing = JSON.parse(fs.readFileSync(scPath, 'utf-8'))
  } catch {
    /* first run, or a file that no longer parses → rewritten whole */
  }
  const stats = githubStats({
    total,
    todayCount: dayCount(days, 0, now),
    yesterdayCount: dayCount(days, -1, now),
  })
  fs.writeFileSync(scPath, JSON.stringify(mergeScorecard(existing, stats, generated), null, 2) + '\n')
  return `${login} — ${total} contributions over ${days.length} days → ${dir}/{heatmap,scorecard}.json`
}

function main() {
  const login = (process.env.ATLAS_GITHUB_USER || '').trim()
  if (!login) {
    console.log('refresh-github: ATLAS_GITHUB_USER is unset — nothing to do (no GitHub tile is shown).')
    return
  }
  try {
    execFileSync('gh', ['auth', 'status'], { stdio: 'ignore', timeout: 15000 })
  } catch {
    console.log('refresh-github: `gh` is missing or not logged in — skipping (run `gh auth login`).')
    return
  }
  console.log(`refresh-github: ${refresh({ login })}`)
}

// Run only when EXECUTED, not when imported (the test imports the helpers above).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    main()
  } catch (e) {
    console.error(`refresh-github: ${e?.message || e}`)
    process.exit(1)
  }
}
