/* ------------------------------------------------------------------ *
 * Tests for agent-bridge/redeploy.mjs — the pure helpers behind
 * server.mjs's redeploy(): the systemd-run argv construction (escaping
 * this process's own cgroup so `systemctl restart` can't kill the
 * redeploy script mid-flight — see server.mjs's redeploy() comment) and
 * the unit-collision → 409 mapping. Pure module, no side effects on
 * import, so no need to boot the bridge (BRIDGE_TOKEN, docker, tmux, ...).
 *
 * Run: node --test api/test/agent-bridge-redeploy.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRedeploySystemdRunArgs, isUnitCollisionError } from '../../agent-bridge/redeploy.mjs'

const BASE = { unit: 'atlas-kit-bridge-redeploy', stateFile: '/tmp/state.json', script: '/repo/scripts/restart-agent-bridge.sh', log: '/tmp/redeploy.log', cwd: '/repo' }

test('builds a --collect --no-block transient-unit invocation with the fixed unit name', () => {
  const args = buildRedeploySystemdRunArgs(BASE)
  assert.ok(args.includes('--collect'), 'must --collect so the fixed unit name frees up after it runs')
  assert.ok(args.includes('--no-block'), 'must not block the HTTP handler on the script finishing')
  assert.ok(args.includes('--unit=atlas-kit-bridge-redeploy'))
  assert.ok(args.includes('--property=Type=oneshot'))
  assert.ok(args.includes('--working-directory=/repo'))
})

test('forwards REDEPLOY_STATE_FILE via --setenv', () => {
  const args = buildRedeploySystemdRunArgs(BASE)
  assert.ok(args.includes('--setenv=REDEPLOY_STATE_FILE=/tmp/state.json'))
})

test('forwards BRIDGE_PULL_USER via --setenv only when set — never blanket-forwards env (no BRIDGE_TOKEN leak via `systemctl show`)', () => {
  const withUser = buildRedeploySystemdRunArgs({ ...BASE, pullUser: 'operator' })
  assert.ok(withUser.includes('--setenv=BRIDGE_PULL_USER=operator'))

  const withoutUser = buildRedeploySystemdRunArgs(BASE)
  assert.ok(!withoutUser.some((a) => a.startsWith('--setenv=BRIDGE_PULL_USER')))
  assert.ok(!withoutUser.some((a) => a.startsWith('--setenv=BRIDGE_TOKEN')))
})

test('wraps the script in the bash -lc + log-redirection idiom, single-quoted', () => {
  const args = buildRedeploySystemdRunArgs(BASE)
  const dashDash = args.indexOf('--')
  assert.deepEqual(args.slice(dashDash, dashDash + 3), ['--', 'bash', '-lc'])
  const cmd = args[dashDash + 3]
  assert.equal(cmd, "exec '/repo/scripts/restart-agent-bridge.sh' >>'/tmp/redeploy.log' 2>&1")
})

test('single-quotes a path containing a single quote', () => {
  const args = buildRedeploySystemdRunArgs({ ...BASE, script: "/repo/it's/restart.sh" })
  const cmd = args[args.length - 1]
  assert.equal(cmd, `exec '/repo/it'\\''s/restart.sh' >>'/tmp/redeploy.log' 2>&1`)
})

test('isUnitCollisionError: matches systemd-run\'s real "already loaded or has a fragment file" message', () => {
  const e = { status: 1, stderr: 'Failed to start transient service unit: Unit atlas-kit-bridge-redeploy.service was already loaded or has a fragment file.\n' }
  assert.equal(isUnitCollisionError(e), true)
})

test('isUnitCollisionError: false for an unrelated failure (e.g. systemd-run itself misconfigured)', () => {
  const e = { status: 1, stderr: 'Failed to connect to bus: No such file or directory\n' }
  assert.equal(isUnitCollisionError(e), false)
})

test('isUnitCollisionError: false for a bare ENOENT (systemd-run missing — the fallback path, not a collision)', () => {
  const e = { code: 'ENOENT', message: 'spawnSync systemd-run ENOENT' }
  assert.equal(isUnitCollisionError(e), false)
})
