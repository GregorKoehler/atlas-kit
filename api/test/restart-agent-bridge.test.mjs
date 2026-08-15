/* ------------------------------------------------------------------ *
 * Tests for scripts/restart-agent-bridge.sh — run the REAL script (copied
 * verbatim into a throwaway repo, like deploy-script.test.mjs does for
 * buildDeployScript) against fake `sudo`/`systemctl`/`curl`, so a change to
 * the actual committed script is what's exercised.
 *
 * Focus: the git-auth wrinkle (BRIDGE_PULL_USER as a fallback for SUDO_USER
 * when the bridge invokes the script directly as root) and the optional
 * REDEPLOY_STATE_FILE phase-transition writer the bridge's POST /redeploy
 * reads back via GET /redeploy-status.
 *
 * Run: node --test api/test/restart-agent-bridge.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REAL_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'restart-agent-bridge.sh')
const GIT_ISO = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, ...GIT_ISO } })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

/** A throwaway clone of the script into `scripts/` (so its own ROOT resolves
 *  here) with fake `sudo`/`systemctl`/`curl` on PATH, all logged to files. */
function makeBridgeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'atlas-kit-bridge-redeploy-'))
  const origin = join(root, 'origin.git')
  const ws = join(root, 'ws')
  const fakeBin = join(root, 'bin')
  mkdirSync(fakeBin, { recursive: true })

  git(root, 'init', '--bare', '-b', 'main', origin)
  git(root, 'clone', '--quiet', origin, ws)
  git(ws, 'config', 'user.email', 'test@example.com')
  git(ws, 'config', 'user.name', 'Test')

  mkdirSync(join(ws, 'scripts'), { recursive: true })
  writeFileSync(join(ws, 'scripts', 'restart-agent-bridge.sh'), readFileSync(REAL_SCRIPT, 'utf-8'))
  chmodSync(join(ws, 'scripts', 'restart-agent-bridge.sh'), 0o755)
  writeFileSync(join(ws, 'README.md'), 'base\n')
  git(ws, 'add', '-A')
  git(ws, 'commit', '--quiet', '-m', 'base')
  git(ws, 'push', '--quiet', 'origin', 'main')

  // One commit ahead on origin, then rewind ws — so a pull has real work to do.
  writeFileSync(join(ws, 'README.md'), 'ahead\n')
  git(ws, 'add', '-A')
  git(ws, 'commit', '--quiet', '-m', 'ahead')
  git(ws, 'push', '--quiet', 'origin', 'main')
  git(ws, 'reset', '--hard', '--quiet', 'HEAD~1')

  // Fake `id`: every test below is a ROOT scenario (their names say so — the
  // bridge runs this script as root), and the script picks its whole git-auth
  // branch off `id -u`. Left to the real one, "am I root?" is answered by
  // WHOSE MACHINE runs the suite: true on the box, false on a CI runner, where
  // `SUDO=sudo` instead and the sudo/systemctl assertions below invert. Pin it,
  // so the file tests the case it names. Anything but `-u` goes to the real
  // binary — nothing else on PATH should see a doctored `id`.
  const realId = spawnSync('sh', ['-c', 'command -v id'], { encoding: 'utf-8' }).stdout.trim()
  writeFileSync(
    join(fakeBin, 'id'),
    ['#!/usr/bin/env bash', '[ "$1" = "-u" ] && { echo 0; exit 0; }', `exec ${realId} "$@"`].join('\n') + '\n',
  )
  chmodSync(join(fakeBin, 'id'), 0o755)

  // Fake sudo: log the call, drop the script's fixed `-H -u <user>` prefix, and
  // run the rest directly as the current (test) user — asserts on WHICH branch
  // called sudo and with what user, without needing a real second account.
  const sudoLog = join(root, 'sudo.log')
  writeFileSync(
    join(fakeBin, 'sudo'),
    ['#!/usr/bin/env bash', `echo "$*" >> "${sudoLog}"`, 'shift; shift; shift', 'exec "$@"'].join('\n') + '\n',
  )
  chmodSync(join(fakeBin, 'sudo'), 0o755)

  // Fake systemctl: `cat` reports the unit exists; `restart` just logs (exit
  // code driven by env so a test can fail it).
  const systemctlLog = join(root, 'systemctl.log')
  writeFileSync(
    join(fakeBin, 'systemctl'),
    [
      '#!/usr/bin/env bash',
      `echo "$*" >> "${systemctlLog}"`,
      '[ "$1" = "cat" ] && exit "${SYSTEMCTL_CAT_EXIT:-0}"',
      '[ "$1" = "restart" ] && exit "${SYSTEMCTL_EXIT:-0}"',
      // `show -p …` feeds the control-plane priority check. Default: prints
      // nothing (systemd too old / unit gone) — the "can't tell" path.
      '[ "$1" = "show" ] && { printf \'%s\' "${SYSTEMCTL_SHOW:-}"; exit 0; }',
      'exit 0',
    ].join('\n') + '\n',
  )
  chmodSync(join(fakeBin, 'systemctl'), 0o755)

  // Fake curl: the health check. Exit code driven by env; success prints a
  // fake /health body (unused by the script beyond a non-empty response).
  const curlLog = join(root, 'curl.log')
  writeFileSync(
    join(fakeBin, 'curl'),
    [
      '#!/usr/bin/env bash',
      `echo "$*" >> "${curlLog}"`,
      'if [ "${CURL_EXIT:-0}" != "0" ]; then exit "$CURL_EXIT"; fi',
      'echo \'{"ok":true,"service":"agent-bridge","sha":"deadbee"}\'',
    ].join('\n') + '\n',
  )
  chmodSync(join(fakeBin, 'curl'), 0o755)

  return { root, ws, fakeBin, sudoLog, systemctlLog, curlLog, statePath: join(root, 'state.json') }
}

function readLog(p) {
  return existsSync(p) ? readFileSync(p, 'utf-8') : ''
}

function runScript(env, args = [], extraEnv = {}) {
  const scriptPath = join(env.ws, 'scripts', 'restart-agent-bridge.sh')
  // Never let the outer test process's own env leak SUDO_USER/BRIDGE_PULL_USER
  // in — each test sets exactly what it wants to via extraEnv.
  const base = { ...process.env, ...GIT_ISO, PATH: `${env.fakeBin}:${process.env.PATH}`, REDEPLOY_STATE_FILE: env.statePath }
  delete base.SUDO_USER
  delete base.BRIDGE_PULL_USER
  const passedEnv = { ...base, ...extraEnv }
  const r = spawnSync('bash', [scriptPath, ...args], { cwd: env.ws, encoding: 'utf-8', env: passedEnv })
  return {
    code: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    sudo: readLog(env.sudoLog),
    systemctl: readLog(env.systemctlLog),
    state: existsSync(env.statePath) ? JSON.parse(readFileSync(env.statePath, 'utf-8')) : null,
  }
}

test('root, neither SUDO_USER nor BRIDGE_PULL_USER set → fails loud, no sudo call, state error:pull', () => {
  const env = makeBridgeWorkspace()
  const r = runScript(env)
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /neither SUDO_USER nor BRIDGE_PULL_USER/)
  assert.equal(r.sudo, '', 'must never shell out to sudo with no user to pull as')
  assert.equal(r.systemctl, '', 'must not reach restart after a failed pull')
  assert.equal(r.state.phase, 'error')
  assert.equal(r.state.step, 'pull')
})

test('root + BRIDGE_PULL_USER set (no SUDO_USER) → pulls as that user, restarts, state done:ok', () => {
  const env = makeBridgeWorkspace()
  const r = runScript(env, [], { BRIDGE_PULL_USER: 'someuser' })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.sudo, /-H -u someuser env GIT_TERMINAL_PROMPT=0/, 'pulls with the BRIDGE_PULL_USER override')
  assert.match(r.systemctl, /restart/)
  assert.equal(r.state.phase, 'done')
  assert.equal(r.state.step, 'ok')
  assert.ok(/^[0-9a-f]{4,}$/.test(r.state.sha), `sha should look like a short git hash, got ${r.state.sha}`)
})

test('SUDO_USER set takes priority over BRIDGE_PULL_USER (existing interactive-sudo path unchanged)', () => {
  const env = makeBridgeWorkspace()
  const r = runScript(env, [], { SUDO_USER: 'realuser', BRIDGE_PULL_USER: 'someuser' })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.sudo, /-H -u realuser env GIT_TERMINAL_PROMPT=0/, 'SUDO_USER wins when both are set')
})

test('--no-pull: skips the git-auth branching entirely, restarts + health-checks, state done:ok', () => {
  const env = makeBridgeWorkspace()
  const r = runScript(env, ['--no-pull'])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.sudo, '', '--no-pull never touches git_pull, so no sudo call either')
  assert.match(r.systemctl, /restart/)
  assert.equal(r.state.phase, 'done')
  assert.equal(r.state.step, 'ok')
})

test('restart fails → state error:restart', () => {
  const env = makeBridgeWorkspace()
  const r = runScript(env, ['--no-pull'], { SYSTEMCTL_EXIT: '1' })
  assert.notEqual(r.code, 0)
  assert.equal(r.state.phase, 'error')
  assert.equal(r.state.step, 'restart')
})

test('health check fails → state error:health', () => {
  const env = makeBridgeWorkspace()
  const r = runScript(env, ['--no-pull'], { CURL_EXIT: '7' })
  assert.notEqual(r.code, 0)
  assert.equal(r.state.phase, 'error')
  assert.equal(r.state.step, 'health')
})

/* --- control-plane priority check (advisory; docs/bridge-box-runbook.md) ---
 * The Nice/CPUWeight/OOMScoreAdjust that keep the bridge answering on a
 * saturated box live in the UNIT, which this script never writes — so a box
 * whose unit predates them redeploys perfectly and stays unprotected. The
 * check exists to make that audible. It must never fail a working redeploy. */

const GOOD_PROPS = 'Nice=-5\nCPUWeight=10000\nOOMScoreAdjust=-500\n'

test('priority present → reports it OK, exit 0', () => {
  const env = makeBridgeWorkspace()
  const r = runScript(env, ['--no-pull'], { SYSTEMCTL_SHOW: GOOD_PROPS })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /priority in effect: Nice=-5 CPUWeight=10000 OOMScoreAdjust=-500/)
  assert.equal(r.state.phase, 'done')
})

test('priority missing (old unit) → warns + names the fix, but still exits 0 with state done:ok', () => {
  const env = makeBridgeWorkspace()
  const r = runScript(env, ['--no-pull'], { SYSTEMCTL_SHOW: 'Nice=0\nCPUWeight=100\nOOMScoreAdjust=0\n' })
  assert.equal(r.code, 0, 'an unprotected unit is a warning, never a failed redeploy')
  assert.match(r.stdout, /priority NOT in effect/)
  assert.match(r.stdout, /Nice=0\(want<=-5\)/)
  assert.match(r.stdout, /CPUWeight=100\(want>=1000\)/)
  assert.match(r.stdout, /OOMScoreAdjust=0\(want<=-500\)/)
  assert.match(r.stdout, /install-agent-bridge\.sh/, 'must name the idempotent fix')
  assert.equal(r.state.phase, 'done')
  assert.equal(r.state.step, 'ok')
})

test('partial priority (Nice set, OOMScoreAdjust not) → flags only the missing one', () => {
  const env = makeBridgeWorkspace()
  const r = runScript(env, ['--no-pull'], { SYSTEMCTL_SHOW: 'Nice=-5\nCPUWeight=10000\nOOMScoreAdjust=0\n' })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /priority NOT in effect/)
  assert.doesNotMatch(r.stdout, /Nice=-5\(want/)
  assert.match(r.stdout, /OOMScoreAdjust=0\(want<=-500\)/)
})

test('non-numeric / unreadable properties → says so, never crashes the redeploy', () => {
  const env = makeBridgeWorkspace()
  const r = runScript(env, ['--no-pull'], { SYSTEMCTL_SHOW: 'CPUWeight=[not set]\n' })
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /priority NOT in effect/)
  assert.equal(r.state.phase, 'done')
})

test('systemctl show returns nothing → "could not read", still exit 0', () => {
  const env = makeBridgeWorkspace()
  const r = runScript(env, ['--no-pull']) // fake systemctl prints nothing by default
  assert.equal(r.code, 0, r.stderr)
  assert.match(r.stdout, /could not read the unit's priority properties/)
  assert.equal(r.state.phase, 'done')
})

test('REDEPLOY_STATE_FILE unset → the script runs exactly as before (no state file written)', () => {
  const env = makeBridgeWorkspace()
  const r = runScript(env, ['--no-pull'], { REDEPLOY_STATE_FILE: '' })
  assert.equal(r.code, 0, r.stderr)
  assert.equal(existsSync(env.statePath), false)
})
