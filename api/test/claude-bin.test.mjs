/* ------------------------------------------------------------------ *
 * The `claude` binary resolver (api/src/claude-bin.mjs) + the PATH lines
 * the kit writes into cron files.
 *
 * The bug being pinned: `claude` installed at ~/.local/bin, a service started
 * by the watchdog cron or by systemd (PATH=/usr/local/bin:/usr/bin:/bin), every
 * agent spawning into ENOENT — while an interactive restart, with a login PATH,
 * worked. Both halves of the fix are asserted here:
 *   1. resolution never depends on the ambient PATH alone, and refuses LOUDLY
 *      (with the reason) rather than falling through to a silent ENOENT;
 *   2. every cron file the kit writes carries ~/.local/bin on its PATH= line.
 *
 * Hermetic: the resolver takes injectable env/home/probe, so nothing here reads
 * the real filesystem or the real PATH.
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const { resolveClaudeBin, cronPathValue, claudeBinHealth, reportClaudeBinAtBoot, claudeShellWord } = await import(
  '../src/claude-bin.mjs'
)

const HOME = '/home/tester'
// A fake filesystem: the set of paths that exist AND are executable.
const world = (...present) => (p) => present.includes(p)
const resolve = (env, present, home = HOME) =>
  resolveClaudeBin({ env, home, isExecutable: world(...present) })

/* --- search order -------------------------------------------------------- */

test('PATH wins, in PATH order, and the answer is absolute', () => {
  const r = resolve(
    { PATH: '/opt/bin:/usr/local/bin:/usr/bin' },
    ['/usr/local/bin/claude', '/usr/bin/claude'],
  )
  assert.deepEqual(r, { ok: true, path: '/usr/local/bin/claude', source: 'PATH' })
  assert.ok(path.isAbsolute(r.path))
})

test('THE FIELD BUG: a cron-shaped PATH still finds ~/.local/bin/claude', () => {
  // Exactly infra/atlas-kit.cron's old PATH, and the binary only in ~/.local/bin.
  const r = resolve({ PATH: '/usr/local/bin:/usr/bin:/bin' }, [`${HOME}/.local/bin/claude`])
  assert.deepEqual(r, { ok: true, path: `${HOME}/.local/bin/claude`, source: 'fallback' })
})

test('/usr/local/bin is the last resort — the root symlink the setup docs create', () => {
  const r = resolve({ PATH: '' }, ['/usr/local/bin/claude'])
  assert.deepEqual(r, { ok: true, path: '/usr/local/bin/claude', source: 'fallback' })
})

test('~/.local/bin is preferred over /usr/local/bin when both exist', () => {
  const r = resolve({ PATH: '' }, [`${HOME}/.local/bin/claude`, '/usr/local/bin/claude'])
  assert.equal(r.path, `${HOME}/.local/bin/claude`)
})

test('a relative PATH entry resolves to an absolute path, never a cwd-dependent one', () => {
  const abs = path.resolve('node_modules/.bin', 'claude')
  const r = resolve({ PATH: 'node_modules/.bin' }, [abs])
  assert.equal(r.path, abs)
})

test('a homeless environment skips ~/.local/bin instead of probing a relative path', () => {
  const probed = []
  const r = resolveClaudeBin({
    env: { PATH: '' },
    home: '',
    isExecutable: (p) => {
      probed.push(p)
      return false
    },
  })
  assert.equal(r.ok, false)
  assert.deepEqual(probed, ['/usr/local/bin/claude'])
})

/* --- CLAUDE_BIN is authoritative ----------------------------------------- */

test('CLAUDE_BIN overrides everything, including a perfectly good PATH hit', () => {
  const r = resolve(
    { CLAUDE_BIN: '/opt/claude/bin/claude', PATH: '/usr/bin' },
    ['/opt/claude/bin/claude', '/usr/bin/claude'],
  )
  assert.deepEqual(r, { ok: true, path: '/opt/claude/bin/claude', source: 'CLAUDE_BIN' })
})

test('a BAD CLAUDE_BIN refuses — it never falls through to another binary', () => {
  const r = resolve({ CLAUDE_BIN: '/opt/gone/claude', PATH: '/usr/bin' }, ['/usr/bin/claude'])
  assert.equal(r.ok, false)
  assert.match(r.error, /CLAUDE_BIN.*not an executable file/)
  // The silent-substitution failure this guards against.
  assert.ok(!('path' in r))
})

test('a relative CLAUDE_BIN is rejected — the whole point is an absolute path', () => {
  const r = resolve({ CLAUDE_BIN: 'claude', PATH: '/usr/bin' }, ['/usr/bin/claude'])
  assert.equal(r.ok, false)
  assert.match(r.error, /ABSOLUTE/)
})

/* --- unresolvable is loud ------------------------------------------------ */

test('unresolvable names the reason and what it looked at', () => {
  const r = resolve({ PATH: '/usr/bin:/bin' }, [])
  assert.equal(r.ok, false)
  assert.match(r.error, /claude-code|CLAUDE_BIN/)
  assert.deepEqual(r.tried, ['/usr/bin/claude', '/bin/claude', `${HOME}/.local/bin/claude`, '/usr/local/bin/claude'])
})

test('a duplicated PATH entry is probed once', () => {
  const r = resolve({ PATH: '/usr/bin:/usr/bin:' }, [])
  assert.equal(r.tried.filter((p) => p === '/usr/bin/claude').length, 1)
})

test('the boot report refuses loudly, naming the reason', () => {
  const lines = []
  // Drives the REAL (memoized) resolution, so this also proves the process-wide
  // path used by every spawn site is reported rather than silently assumed.
  const ok = reportClaudeBinAtBoot((m) => lines.push(m))
  const out = lines.join('\n')
  const health = claudeBinHealth()
  assert.equal(ok, health.ok)
  if (health.ok) {
    assert.equal(claudeShellWord(), `'${health.path}'`)
    assert.match(out, new RegExp(`\\[claude-bin\\] ${health.path}`))
  } else {
    assert.match(out, /REFUSING TO RUN AGENTS/)
    assert.match(out, /Looked at:/)
    assert.ok(health.error)
  }
})

/* --- the cron PATH lines ------------------------------------------------- */

const REPO = new URL('../../', import.meta.url).pathname

test('cronPathValue puts ~/.local/bin first, then the standard cron dirs', () => {
  assert.equal(cronPathValue('/root'), '/root/.local/bin:/usr/local/bin:/usr/bin:/bin')
  // No home to speak of → the standard dirs, and nothing relative.
  assert.equal(cronPathValue(''), '/usr/local/bin:/usr/bin:/bin')
})

test('infra/atlas-kit.cron ships the same PATH line (the watchdog runs from it)', () => {
  const cron = fs.readFileSync(path.join(REPO, 'infra/atlas-kit.cron'), 'utf-8')
  const home = /^HOME=(.+)$/m.exec(cron)
  assert.ok(home, 'the cron file must pin HOME')
  const line = /^PATH=(.+)$/m.exec(cron)
  assert.ok(line, 'the cron file must pin PATH')
  assert.equal(line[1], cronPathValue(home[1]))
  // The watchdog is the line that restarts the services from this PATH.
  assert.match(cron, /serve\.sh ensure/)
})

test('scripts/addon-cron.mjs writes that same PATH line into its generated file', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts/addon-cron.mjs'), 'utf-8')
  // Generated from the shared helper, not a second hardcoded literal that can drift.
  assert.match(src, /PATH=\$\{cronPathValue\(CRON_HOME\)\}/)
  assert.doesNotMatch(src, /'PATH=\/usr\/local\/bin:\/usr\/bin:\/bin'/)
})

test('the systemd unit the provisioner writes pins PATH too', () => {
  const sh = fs.readFileSync(path.join(REPO, 'scripts/provision-hetzner.sh'), 'utf-8')
  const env = /^Environment=PATH=(.+)$/m.exec(sh)
  assert.ok(env, 'atlas-kit.service must pin PATH')
  assert.ok(env[1].split(':').includes('/root/.local/bin'), env[1])
  // …and the root symlink step, so /usr/local/bin/claude exists as a second route.
  assert.match(sh, /ln -sfn "\$CLAUDE_PATH" \/usr\/local\/bin\/claude/)
})
