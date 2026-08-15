/* ------------------------------------------------------------------ *
 * Tests for the last-known remote roster (api/src/bridge-roster.mjs).
 *
 * The property: a bridge that CANNOT ANSWER must be distinguishable from a
 * bridge with NO AGENTS — including across an API restart, which is the case
 * that decides whether the distinction is worth anything. The box restarts on
 * every deploy and on every watchdog bounce; a bridge outage lasts longer than
 * that, so an in-memory-only memory would be blank exactly when it is needed.
 *
 * ⚠️ The most load-bearing assertion here is the SMALLEST one: an answer of
 * zero sessions is still an ANSWER (`{at, sessions: []}`), and must never
 * collapse to the same `null` as "we have never heard from this bridge".
 * Everything downstream — the stale badge, the MCP payload — reads that
 * difference.
 *
 * Run: node --test api/test/bridge-roster.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-bridge-roster-'))
process.env.AGENT_LOCAL_DIR = DIR
// Long enough that only a CHANGED roster triggers a write — that's the
// throttle branch the last test pins.
process.env.AGENT_BRIDGE_ROSTER_PERSIST_MS = '600000'
const ROSTER_FILE = path.join(DIR, 'bridge-roster.json')

const { rememberRoster, lastKnownRoster, __resetRosterForTests } = await import('../src/bridge-roster.mjs')

const session = (id, over = {}) => ({
  id,
  kind: 'dev',
  repo: 'demo-app',
  status: 'running',
  task: 'wire the scene loader',
  startedAt: '2026-08-06T09:00:00.000Z',
  // Fields a stale row has no use for — they must not be persisted.
  transcript: 'x'.repeat(1000),
  subAgents: [{ label: 'reader', active: true }],
  ...over,
})

const onDisk = () => JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf-8'))

test('a bridge we have never heard from is null — NOT an empty roster', () => {
  __resetRosterForTests()
  assert.equal(lastKnownRoster('never-seen'), null)
})

test('an answer of ZERO sessions is remembered as an answer, not as nothing', () => {
  __resetRosterForTests()
  rememberRoster('workstation', [], 1_000)
  assert.deepEqual(lastKnownRoster('workstation'), { at: 1_000, sessions: [] })
  assert.notEqual(lastKnownRoster('workstation'), null, 'the healthy-but-empty case must stay distinguishable')
})

test('rows are slimmed to what a stale row is drawn from', () => {
  __resetRosterForTests()
  rememberRoster('lab-box', [session('p-1')], 2_000)
  assert.deepEqual(lastKnownRoster('lab-box').sessions, [
    {
      id: 'p-1',
      kind: 'dev',
      repo: 'demo-app',
      status: 'running',
      task: 'wire the scene loader',
      title: undefined,
      startedAt: '2026-08-06T09:00:00.000Z',
    },
  ])
})

test('the roster survives an API restart (a deploy, a watchdog bounce)', async () => {
  __resetRosterForTests()
  rememberRoster('lab-box', [session('p-1'), session('p-2', { status: 'idle' })], 3_000)
  // A second module instance reads the same file from scratch — the closest
  // thing to a restarted process without spawning one.
  const restarted = await import('../src/bridge-roster.mjs?restart=1')
  const known = restarted.lastKnownRoster('lab-box')
  assert.equal(known.at, 3_000, 'lastSeen must survive the restart, or "unreachable since" has nothing to say')
  assert.deepEqual(
    known.sessions.map((s) => [s.id, s.status]),
    [
      ['p-1', 'running'],
      ['p-2', 'idle'],
    ],
  )
})

test('an unchanged roster is not rewritten every poll, but `at` still advances in memory', () => {
  __resetRosterForTests()
  rememberRoster('lab-box', [session('p-1')], 10_000)
  assert.equal(onDisk()['lab-box'].at, 10_000)

  rememberRoster('lab-box', [session('p-1')], 11_000) // same shape, inside the throttle
  assert.equal(onDisk()['lab-box'].at, 10_000, 'an identical roster must not rewrite the file')
  assert.equal(lastKnownRoster('lab-box').at, 11_000, 'the live answer is still the fresher one')

  rememberRoster('lab-box', [session('p-1'), session('p-2')], 12_000) // a real change
  assert.equal(onDisk()['lab-box'].at, 12_000, 'a changed roster is worth a write')
  assert.equal(onDisk()['lab-box'].sessions.length, 2)
})

test('a mutated result cannot corrupt the remembered roster', () => {
  __resetRosterForTests()
  rememberRoster('lab-box', [session('p-1')], 20_000)
  lastKnownRoster('lab-box').sessions[0].status = 'done'
  assert.equal(lastKnownRoster('lab-box').sessions[0].status, 'running')
})
