/* ------------------------------------------------------------------ *
 * Tests for the merge pre-flight (merge-preflight.mjs + mergePr in
 * agent-local.mjs) — the guard that stops `merge_pr` landing a stale or red PR.
 *
 * Driven end-to-end with a FAKE `gh` on PATH against a REAL throwaway git repo,
 * because the freshness half of the verdict is a real `git fetch` + ancestry
 * test — the half GitHub cannot answer on an unprotected repo. Both PRs below
 * are reported by the fake `gh` as CLEAN and green; only `agent/stale` is built
 * on an old default branch, and only it must be refused.
 *
 *  - behind → refused (and NOT merged), dirty → refused, blocked → refused,
 *    pending → refused, red → refused (naming the check)
 *  - clean + green → merged, byte-identical to the old bare `gh pr merge`
 *  - UNKNOWN then CLEAN → merged after a retry (transient, not a failure)
 *  - force: true → merges regardless, without even asking GitHub
 *
 * Hermetic: no network, no tmux, no real `gh`, no vault.
 *
 * Run: node --test api/test/merge-preflight.test.mjs
 * ------------------------------------------------------------------ */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { rollupChecks, preflightVerdict } from '../src/merge-preflight.mjs'

const GIT_ISO = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-merge-preflight-'))
const ws = path.join(dir, 'ws')
const fakeBin = path.join(dir, 'bin')
const viewDir = path.join(dir, 'views')
const ghLog = path.join(dir, 'gh.log')
const ghCount = path.join(dir, 'gh.count')

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, ...GIT_ISO } })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}
function commit(msg) {
  fs.writeFileSync(path.join(ws, 'f.txt'), `${msg}\n`)
  git(ws, 'add', '-A')
  git(ws, 'commit', '--quiet', '-m', msg)
}

// One repo, two branches, so the ONLY difference between the two sessions below
// is freshness: origin/main ends at B; agent/stale forked before it, agent/fresh
// after it.
fs.mkdirSync(fakeBin, { recursive: true })
fs.mkdirSync(viewDir, { recursive: true })
git(dir, 'init', '--bare', '-b', 'main', path.join(dir, 'origin.git'))
git(dir, 'clone', '--quiet', path.join(dir, 'origin.git'), ws)
git(ws, 'config', 'user.email', 'test@example.com')
git(ws, 'config', 'user.name', 'Test')
commit('A')
git(ws, 'push', '--quiet', 'origin', 'main')
git(ws, 'checkout', '--quiet', '-b', 'agent/stale')
commit('S')
git(ws, 'push', '--quiet', 'origin', 'agent/stale')
git(ws, 'checkout', '--quiet', 'main')
commit('B')
git(ws, 'push', '--quiet', 'origin', 'main')
git(ws, 'checkout', '--quiet', '-b', 'agent/fresh')
commit('F')
git(ws, 'push', '--quiet', 'origin', 'agent/fresh')
git(ws, 'checkout', '--quiet', 'main')

// Fake `gh`: logs every call; `pr view` serves views/view-<Nth call>.json (falling
// back to views/view.json) and exits 1 — like the real "no pull requests found for
// branch" — when there is none; `pr merge` just succeeds.
fs.writeFileSync(
  path.join(fakeBin, 'gh'),
  [
    '#!/usr/bin/env bash',
    `echo "$*" >> "${ghLog}"`,
    'if [ "$1" = "pr" ] && [ "$2" = "view" ]; then',
    `  n=$(cat "${ghCount}" 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > "${ghCount}"`,
    `  f="${viewDir}/view-$n.json"; [ -f "$f" ] || f="${viewDir}/view.json"`,
    '  if [ ! -f "$f" ]; then echo "no pull requests found for branch" >&2; exit 1; fi',
    '  cat "$f"; exit 0',
    'fi',
    'if [ "$1" = "pr" ] && [ "$2" = "merge" ]; then echo "Merged pull request"; exit 0; fi',
    'exit 0',
  ].join('\n') + '\n',
)
fs.chmodSync(path.join(fakeBin, 'gh'), 0o755)

// State fixture written BEFORE import (the module loads state.json at load time).
const session = (id, branch) => ({
  id, branch, kind: 'dev', repo: 'demo', path: ws,
  tmux: `atlas-kit-test-${id}`, worktree: ws,
  status: 'idle', startedAt: '2026-08-03T10:00:00.000Z',
})
fs.writeFileSync(
  path.join(dir, 'state.json'),
  JSON.stringify({ sessions: { fresh: session('fresh', 'agent/fresh'), stale: session('stale', 'agent/stale') } }),
)

process.env.AGENT_LOCAL_DIR = dir
process.env.WORKSPACE_DIR = dir
process.env.AGENT_LOCAL_RECONCILE = '0' // keep the boot reconciler quiet in the test
process.env.AGENT_LOCAL_DRIVE = '0' // …and the lifecycle driver off these fixtures
process.env.AGENT_MERGED_CHECK_MS = String(24 * 60 * 60 * 1000) // no background merged sampling
process.env.AGENT_MERGE_PREFLIGHT_DELAY_MS = '5' // don't really wait out the UNKNOWN retry
process.env.PATH = `${fakeBin}:${process.env.PATH}`
Object.assign(process.env, GIT_ISO)

/** Queue the responses the next `gh pr view` calls get (none → "no open PR"). */
function setViews(...views) {
  fs.rmSync(viewDir, { recursive: true, force: true })
  fs.mkdirSync(viewDir, { recursive: true })
  fs.rmSync(ghCount, { force: true })
  fs.rmSync(ghLog, { force: true })
  views.forEach((v, i) => fs.writeFileSync(path.join(viewDir, `view-${i + 1}.json`), JSON.stringify(v)))
}
const calls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf-8').trim().split('\n').filter(Boolean) : [])
const merges = () => calls().filter((l) => l.startsWith('pr merge'))
const views = () => calls().filter((l) => l.startsWith('pr view'))

const GREEN = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }]
const pr = (over = {}) => ({
  number: 123, state: 'OPEN', mergeStateStatus: 'CLEAN', mergeable: 'MERGEABLE',
  baseRefName: 'main', statusCheckRollup: GREEN, ...over,
})

let local
before(async () => {
  local = await import('../src/agent-local.mjs')
})

test('a stale branch is refused — even though GitHub calls it CLEAN and green', async () => {
  // Exactly what an UNPROTECTED repo reports for a branch built on an old default
  // branch: mergeStateStatus is only ever BEHIND where protection requires
  // up-to-date branches. The local ancestry test is what catches it.
  setViews(pr())
  const r = await local.mergePr({ id: 'stale' })
  assert.equal(r.ok, false)
  assert.equal(r.status, 409)
  assert.equal(r.preflight, 'behind')
  assert.match(r.error, /PR #123 is BEHIND main/)
  assert.match(r.error, /Ship the agent/)
  assert.deepEqual(merges(), [], 'a refused merge must never reach `gh pr merge`')
})

test('a conflicted PR is refused', async () => {
  setViews(pr({ mergeStateStatus: 'DIRTY', mergeable: 'CONFLICTING' }))
  const r = await local.mergePr({ id: 'fresh' })
  assert.equal(r.ok, false)
  assert.equal(r.preflight, 'dirty')
  assert.match(r.error, /PR #123 CONFLICTS with main/)
  assert.deepEqual(merges(), [])
})

test('a blocked PR names branch protection', async () => {
  setViews(pr({ mergeStateStatus: 'BLOCKED' }))
  const r = await local.mergePr({ id: 'fresh' })
  assert.equal(r.preflight, 'blocked')
  assert.match(r.error, /BLOCKED by main's branch protection/)
  assert.deepEqual(merges(), [])
})

test('still-running checks are refused (wait, do not merge)', async () => {
  setViews(pr({ statusCheckRollup: [{ name: 'ci', status: 'IN_PROGRESS' }] }))
  const r = await local.mergePr({ id: 'fresh' })
  assert.equal(r.ok, false)
  assert.equal(r.preflight, 'checks-pending')
  assert.match(r.error, /PENDING checks/)
  assert.deepEqual(merges(), [])
})

test('a red PR names the failing check', async () => {
  setViews(pr({ statusCheckRollup: [{ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }] }))
  const r = await local.mergePr({ id: 'fresh' })
  assert.equal(r.preflight, 'checks-failing')
  assert.match(r.error, /RED — failing checks: build/)
  assert.deepEqual(merges(), [])
})

test('no open PR for the branch is refused, not attempted', async () => {
  setViews() // fake gh exits 1, as it does for a branch with no PR
  const r = await local.mergePr({ id: 'fresh' })
  assert.equal(r.preflight, 'no-pr')
  assert.match(r.error, /no open PR for branch `agent\/fresh`/)
  assert.deepEqual(merges(), [])
})

test('a fresh, green PR merges — unchanged behaviour', async () => {
  setViews(pr())
  const r = await local.mergePr({ id: 'fresh' })
  assert.equal(r.ok, true)
  assert.equal(r.status, 200)
  assert.equal(r.branch, 'agent/fresh')
  assert.match(r.output, /Merged pull request/)
  assert.deepEqual(merges(), ['pr merge agent/fresh --merge'])
})

test('UNKNOWN mergeability is retried, then merges once GitHub settles', async () => {
  setViews(pr({ mergeStateStatus: 'UNKNOWN' }), pr())
  const r = await local.mergePr({ id: 'fresh' })
  assert.equal(r.ok, true)
  assert.equal(views().length, 2, 'should re-view rather than refuse the first UNKNOWN')
  assert.deepEqual(merges(), ['pr merge agent/fresh --merge'])
})

test('UNKNOWN that never settles is refused as transient, not as a failure', async () => {
  setViews(pr({ mergeStateStatus: 'UNKNOWN' }), pr({ mergeStateStatus: 'UNKNOWN' }), pr({ mergeStateStatus: 'UNKNOWN' }))
  const r = await local.mergePr({ id: 'fresh' })
  assert.equal(r.preflight, 'unknown')
  assert.match(r.error, /transient; retry in a moment/)
  assert.deepEqual(merges(), [])
})

test('force: true merges a stale, conflicted PR without asking GitHub at all', async () => {
  setViews(pr({ mergeStateStatus: 'DIRTY' }))
  const r = await local.mergePr({ id: 'stale', force: true })
  assert.equal(r.ok, true)
  assert.deepEqual(views(), [], 'force skips the pre-flight entirely')
  assert.deepEqual(merges(), ['pr merge agent/stale --merge'])
})

test('an unknown session is refused before any IO', async () => {
  const r = await local.mergePr({ id: 'nope' })
  assert.equal(r.status, 404)
})

// The check rollup mixes two node shapes and `gh` does not always include
// __typename — the one bit of parsing worth pinning directly.
test('rollupChecks reads CheckRun (status/conclusion) and StatusContext (state) alike', () => {
  assert.equal(rollupChecks([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }]).state, 'passing')
  assert.equal(rollupChecks([{ context: 'legacy', state: 'PENDING' }]).state, 'pending')
  assert.deepEqual(rollupChecks([{ context: 'legacy', state: 'ERROR' }]).failing, ['legacy'])
  // A skipped job (path filter) is a normal outcome, not a failure; no checks at
  // all is 'none' — a repo without CI must still be mergeable.
  assert.equal(rollupChecks([{ name: 'lint', status: 'COMPLETED', conclusion: 'SKIPPED' }]).state, 'passing')
  assert.equal(rollupChecks(undefined).state, 'none')
})

test('an undeterminable freshness check never refuses on its own', () => {
  assert.equal(preflightVerdict({ pr: pr(), fresh: null }).ok, true)
  assert.equal(preflightVerdict({ pr: pr(), fresh: false }).state, 'behind')
})

test('an already-merged PR is refused rather than re-merged', () => {
  const v = preflightVerdict({ pr: pr({ state: 'MERGED' }), fresh: true })
  assert.equal(v.state, 'already-merged')
  assert.match(v.error, /PR #123 is MERGED, not OPEN/)
})
