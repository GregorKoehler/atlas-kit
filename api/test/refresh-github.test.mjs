/* ------------------------------------------------------------------ *
 * Tests for scripts/refresh-github.mjs — the OPTIONAL GitHub-contributions
 * producer behind the Scorecard's "GitHub" group.
 *
 * What it guards:
 *   • the response → tile shape (private contributions folded into the total,
 *     the calendar flattened into the heatmap's { date, count } days),
 *   • the label pact with `isGithubStat` in web/…/Scorecard.tsx — that predicate
 *     anchors the cumulative sparkline, so a label drift on either side
 *     unanchors it silently,
 *   • that a rewrite MERGES: stats this script doesn't own survive,
 *   • that an UNCONFIGURED install is a clean no-op — exit 0, no files, no error
 *     (the whole "no GitHub tile and nothing breaks" guarantee),
 *   • that a malformed response throws instead of writing a hollow file.
 *
 * Hermetic: a small SYNTHETIC fixture and an injected fetcher — no network, no
 * `gh`, no real account.
 *
 * Run: node --test api/test/refresh-github.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'refresh-github.mjs')
const FIXTURE = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'github-contributions.json'), 'utf-8'))

// DATA_DIR is read at call time (dataDir()), so pointing it at a temp dir here
// is enough — no import-order dance.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'atlas-kit-ghdata-'))
process.env.DATA_DIR = DATA_DIR

const { parseContributions, dayCount, githubStats, ownsStat, mergeScorecard, yearWindow, refresh } = await import(
  '../../scripts/refresh-github.mjs'
)

test('parse: private contributions fold into the total, weeks flatten into days', () => {
  const { total, days } = parseContributions(FIXTURE)
  assert.equal(total, 25, '20 public + 5 restricted — what the profile shows')
  assert.deepEqual(days, [
    { date: '2026-01-01', count: 3 },
    { date: '2026-01-02', count: 0 },
    { date: '2026-01-03', count: 7 },
    { date: '2026-01-04', count: 10 },
  ])
})

test('parse: a malformed response throws (never a hollow file)', () => {
  assert.throws(() => parseContributions({}))
  assert.throws(() => parseContributions({ data: { user: null } }), /contribution calendar/)
})

test('day lookup is by LOCAL date, and a missing day is 0 (never undefined)', () => {
  const { days } = parseContributions(FIXTURE)
  const now = new Date(2026, 0, 3, 13, 0, 0) // local noon-ish on the 3rd
  assert.equal(dayCount(days, 0, now), 7)
  assert.equal(dayCount(days, -1, now), 0, 'the 2nd is present with a zero count')
  assert.equal(dayCount(days, -30, now), 0, 'outside the window → 0, not undefined/NaN')
})

test('tiles: the three labels, all in the GitHub group, all owned by this script', () => {
  const stats = githubStats({ total: 25, todayCount: 7, yesterdayCount: 0 })
  assert.deepEqual(
    stats.map((s) => s.label),
    ['GitHub Contributions (1y)', 'Contributions Today', 'Contributions Yesterday'],
  )
  assert.ok(stats.every((s) => s.group === 'GitHub'))
  // The pact with Scorecard.tsx's isGithubStat — same two patterns, both sides.
  assert.ok(stats.every((s) => ownsStat(s.label)))
  assert.equal(stats[1].trend, 'up', 'a non-zero today reads as up')
  assert.equal(githubStats({ total: 0, todayCount: 0, yesterdayCount: 0 })[1].trend, 'neutral')
})

test('ownsStat claims only the GitHub tiles', () => {
  assert.equal(ownsStat('Agent time · this month'), false)
  assert.equal(ownsStat('Semantic index'), false)
  assert.equal(ownsStat('contributions today'), true, 'case-insensitive')
})

test('merge: foreign stats survive, a stale GitHub tile does not', () => {
  const stats = githubStats({ total: 25, todayCount: 7, yesterdayCount: 0 })
  const merged = mergeScorecard(
    { generated: 'old', stats: [{ label: 'Core tile', value: '7' }, { label: 'Contributions Today', value: '99' }] },
    stats,
    'new',
  )
  assert.equal(merged.generated, 'new')
  assert.deepEqual(merged.stats.slice(0, 3), stats, 'ours first, in render order')
  assert.deepEqual(merged.stats.slice(3), [{ label: 'Core tile', value: '7' }], 'someone else’s tile kept verbatim')
})

test('the query window is exactly one year back, as ISO timestamps', () => {
  const { from, to } = yearWindow(new Date('2026-08-15T10:00:00Z'))
  assert.equal(to, '2026-08-15T10:00:00.000Z')
  assert.equal(from, '2025-08-15T10:00:00.000Z')
})

test('end to end (no network): both files land in the shape the API serves', () => {
  const now = new Date(2026, 0, 3, 9, 0, 0)
  const calls = []
  const summary = refresh({
    login: 'example-user',
    now,
    run: (login, from, to) => {
      calls.push({ login, from, to })
      return FIXTURE
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].login, 'example-user')

  const heatmap = JSON.parse(readFileSync(join(DATA_DIR, 'heatmap.json'), 'utf-8'))
  assert.deepEqual(Object.keys(heatmap), ['generated', 'days'])
  assert.equal(heatmap.days.length, 4)

  const scorecard = JSON.parse(readFileSync(join(DATA_DIR, 'scorecard.json'), 'utf-8'))
  assert.deepEqual(Object.keys(scorecard), ['generated', 'stats'])
  assert.equal(scorecard.stats[0].value, '25', 'localeString of the folded total')
  assert.equal(scorecard.stats[1].value, '7', "today's count, by local date")
  assert.match(summary, /example-user/)

  // A second run over the same dir replaces its own tiles rather than doubling.
  refresh({ login: 'example-user', now, run: () => FIXTURE })
  const again = JSON.parse(readFileSync(join(DATA_DIR, 'scorecard.json'), 'utf-8'))
  assert.equal(again.stats.filter((s) => s.label === 'Contributions Today').length, 1)
})

test('unconfigured: no ATLAS_GITHUB_USER → exit 0, says why, writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-kit-ghnoop-'))
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf-8',
    env: { ...process.env, ATLAS_GITHUB_USER: '', DATA_DIR: dir },
  })
  assert.equal(r.status, 0, 'an unconfigured install is not an error')
  assert.match(r.stdout, /ATLAS_GITHUB_USER/)
  assert.deepEqual(readdirSync(dir), [], 'no data files created')
})

test('unconfigured: a stale scorecard.json is left exactly as it was', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-kit-ghkeep-'))
  const file = join(dir, 'scorecard.json')
  writeFileSync(file, '{"generated":"x","stats":[{"label":"Core tile","value":"7"}]}\n')
  const before = readFileSync(file, 'utf-8')
  spawnSync(process.execPath, [SCRIPT], { encoding: 'utf-8', env: { ...process.env, ATLAS_GITHUB_USER: '', DATA_DIR: dir } })
  assert.ok(existsSync(file))
  assert.equal(readFileSync(file, 'utf-8'), before)
})
