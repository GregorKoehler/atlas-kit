/* ------------------------------------------------------------------ *
 * Tests for the Redeploy endpoint's decision layer (deploy-routes.mjs) — the
 * parts that decide WHETHER a redeploy runs at all, before any bash exists:
 *
 *   • which cards opt in (`self_deploy: true` AND a `repo_path`, never one
 *     alone — `self_deploy` on its own is just a delivery-mode flag),
 *   • which project an unnamed request targets (exactly one → it; several →
 *     refuse rather than guess which app to restart),
 *   • single-flight: a run still in `deploying` blocks the next POST, but a
 *     wedged state file goes stale so it can't block forever,
 *   • the systemd-run argv, and the unit-collision error that must NOT fall
 *     through to the detached fallback (it would start a second deploy).
 *
 * Hermetic: pure functions plus a temp state dir. No git, no systemd, no HTTP.
 *
 * Run: node --test api/test/deploy-routes.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STATE_DIR = mkdtempSync(join(tmpdir(), 'atlas-kit-deploystate-'))
process.env.ATLAS_DEPLOY_STATE_DIR = STATE_DIR

const {
  deployTargets,
  pickTarget,
  repoPathProblem,
  isInFlight,
  readDeployState,
  claimDeploying,
  recordLaunchFailure,
  deploySlug,
  buildDeploySystemdRunArgs,
  isUnitCollisionError,
} = await import('../src/deploy-routes.mjs')

const project = (name, extra = {}) => ({ name, selfDeploy: false, repo: '', ...extra })
const KIT = project('Atlas Kit', { selfDeploy: true, repo: '/srv/atlas-kit' })
const OTHER = project('Another App', { selfDeploy: true, repo: '/srv/other' })

test('opting in needs BOTH self_deploy and repo_path', () => {
  const projects = [
    KIT,
    project('Flag only', { selfDeploy: true }), // no checkout on this box → nothing to redeploy
    project('Path only', { repo: '/srv/somewhere' }), // never opted in
  ]
  assert.deepEqual(deployTargets(projects), [{ name: 'Atlas Kit', repoPath: '/srv/atlas-kit' }])
})

test('no project named + exactly one opted-in card → that card', () => {
  assert.deepEqual(pickTarget([KIT, project('Docs')], undefined).target, {
    name: 'Atlas Kit',
    repoPath: '/srv/atlas-kit',
  })
})

test('no project named + several opted in → refuses and names them', () => {
  const r = pickTarget([KIT, OTHER], undefined)
  assert.equal(r.target, undefined)
  assert.equal(r.status, 400)
  assert.match(r.error, /Atlas Kit/)
  assert.match(r.error, /Another App/)
})

test('no opted-in card at all → 404 that says what the page needs', () => {
  const r = pickTarget([project('Docs')], undefined)
  assert.equal(r.status, 404)
  assert.match(r.error, /self_deploy/)
  assert.match(r.error, /repo_path/)
})

test('a named project resolves by name; an unknown/ineligible one is a 404', () => {
  assert.equal(pickTarget([KIT, OTHER], 'Another App').target.repoPath, '/srv/other')
  assert.equal(pickTarget([KIT, OTHER], 'Nope').status, 404)
  // Named but not opted in — refused with the same reason, never silently
  // falling back to the other card (that would restart the wrong app).
  assert.equal(pickTarget([KIT, project('Docs')], 'Docs').status, 404)
})

test('a repo_path that cannot go into a shell command is refused, not escaped', () => {
  assert.equal(repoPathProblem('/srv/atlas-kit'), null)
  assert.equal(repoPathProblem('/srv/my kit'), null, 'a space is fine — the script quotes the path')
  assert.match(repoPathProblem('srv/atlas-kit'), /absolute/)
  assert.match(repoPathProblem('/srv/kit"; rm -rf /'), /shell command/)
  assert.match(repoPathProblem('/srv/kit$(id)'), /shell command/)
  assert.match(repoPathProblem('/srv/kit\nrm -rf /'), /shell command/)
})

test('single-flight: a fresh `deploying` blocks, a stale one does not', () => {
  const now = Date.parse('2026-08-15T12:00:00Z')
  const at = (iso) => ({ phase: 'deploying', step: 'build', at: iso })
  assert.equal(isInFlight(at('2026-08-15T11:59:00Z'), now), true, 'a minute old → still running')
  assert.equal(isInFlight(at('2026-08-15T11:30:00Z'), now), false, 'half an hour → wedged, allow a retry')
  assert.equal(isInFlight({ phase: 'done', at: '2026-08-15T11:59:00Z' }, now), false)
  assert.equal(isInFlight({ phase: 'error', at: '2026-08-15T11:59:00Z' }, now), false)
  assert.equal(isInFlight(null, now), false, 'never deployed → not running')
  // No/garbage timestamp: assume it IS live and refuse — starting a second
  // build+restart on top of a running one is the worse failure.
  assert.equal(isInFlight({ phase: 'deploying', step: 'build' }, now), true)
})

test('the slot is claimed BEFORE launching, and released when the launch fails', () => {
  // Without the pre-claim, two POSTs a moment apart both read "not running"
  // (the script writes its own state only once it is up) and both launch.
  claimDeploying('Claimed')
  assert.equal(isInFlight(readDeployState('Claimed')), true, 'the next POST refuses')
  recordLaunchFailure('Claimed', 'systemd-run exploded')
  const after = readDeployState('Claimed')
  assert.equal(isInFlight(after), false, 'a failed launch must not hold the slot')
  assert.equal(after.phase, 'error')
  assert.equal(after.reason, 'systemd-run exploded', 'and the card says why')
})

test('state file: missing or garbage reads as null, valid JSON round-trips', () => {
  assert.equal(readDeployState('Never Deployed'), null)
  writeFileSync(join(STATE_DIR, `atlas-kit-deploy-${deploySlug('Broken')}.json`), 'not json{')
  assert.equal(readDeployState('Broken'), null)
  writeFileSync(
    join(STATE_DIR, `atlas-kit-deploy-${deploySlug('Atlas Kit')}.json`),
    JSON.stringify({ phase: 'done', step: 'ok', reason: 'restarted', targetSha: 'abc1234', at: '2026-08-15T12:00:00Z' }),
  )
  assert.equal(readDeployState('Atlas Kit').targetSha, 'abc1234')
})

test('slugs are filesystem- and unit-name-safe, and never empty', () => {
  assert.equal(deploySlug('Atlas Kit'), 'atlas-kit')
  assert.equal(deploySlug('../../etc/passwd'), 'etc-passwd')
  assert.equal(deploySlug('Ünicode ✨'), 'nicode')
  assert.equal(deploySlug(''), 'project')
})

test('systemd-run argv: transient, collected, non-blocking, in the repo', () => {
  const args = buildDeploySystemdRunArgs({ unit: 'atlas-kit-deploy-atlas-kit', script: 'echo hi', cwd: '/srv/atlas-kit' })
  assert.ok(args.includes('--collect'), 'unloads itself so the fixed unit name is free next time')
  assert.ok(args.includes('--no-block'), 'never waits for a script that restarts us')
  assert.ok(args.includes('--unit=atlas-kit-deploy-atlas-kit'))
  assert.ok(args.includes('--working-directory=/srv/atlas-kit'))
  assert.deepEqual(args.slice(-3), ['bash', '-lc', 'echo hi'], 'the script is the last argument, after --')
  assert.equal(args[args.indexOf('bash') - 1], '--', 'nothing after -- can be read as a systemd-run option')
})

test('a unit collision is a 409, not a reason to fall back to a second deploy', () => {
  assert.equal(isUnitCollisionError({ stderr: 'Failed to start transient service unit: Unit x was already loaded' }), true)
  assert.equal(isUnitCollisionError({ message: 'unit already active' }), true)
  assert.equal(isUnitCollisionError({ message: 'systemd-run: command not found' }), false, 'no systemd → use the fallback')
  assert.equal(isUnitCollisionError({}), false)
})
