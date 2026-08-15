/* ------------------------------------------------------------------ *
 * Tests for the Redeploy script (buildDeployScript in deploy-routes.mjs) — the
 * bash the transient unit runs on a `self_deploy: true` project's checkout.
 *
 * What it guards: the two REFUSALS (a dirty checkout, a merge that is not a
 * fast-forward) never touch the running app; deps install ONLY when a lockfile
 * changed; and every failure writes phase:"error" + a reason to the state file
 * and stops BEFORE the restart, so a broken deploy can never look green.
 *
 * Hermetic: the REAL generated bash against a throwaway git repo with a local
 * bare "origin", plus fake `npm` and `scripts/serve.sh` (logged, exit-code
 * driven). No systemd, no network, no live box.
 *
 * Run: node --test api/test/deploy-script.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDeployScript } from '../src/deploy-routes.mjs'

const GIT_ISO = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const BRANCH = 'main'

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, ...GIT_ISO } })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

/**
 * A checkout whose origin/main is ONE commit ahead, with `ahead` = the files
 * that incoming commit changes ({ path: contents }). Returns the paths plus a
 * fake `npm` on PATH and a fake `scripts/serve.sh`, both logging to files.
 */
function makeRepo(ahead) {
  const root = mkdtempSync(join(tmpdir(), 'atlas-kit-deploy-'))
  const origin = join(root, 'origin.git')
  const ws = join(root, 'checkout')
  const fakeBin = join(root, 'bin')
  mkdirSync(fakeBin, { recursive: true })

  git(root, 'init', '--bare', '-b', BRANCH, origin)
  git(root, 'clone', '--quiet', origin, ws)
  git(ws, 'config', 'user.email', 'test@example.com')
  git(ws, 'config', 'user.name', 'Test')

  for (const pkg of ['web', 'api']) {
    mkdirSync(join(ws, pkg), { recursive: true })
    writeFileSync(join(ws, pkg, 'package-lock.json'), `{"name":"${pkg}","version":"base"}\n`)
    writeFileSync(join(ws, pkg, 'package.json'), `{"name":"${pkg}"}\n`)
  }
  mkdirSync(join(ws, 'scripts'), { recursive: true })
  const serveLog = join(root, 'serve.log')
  writeFileSync(
    join(ws, 'scripts', 'serve.sh'),
    `#!/usr/bin/env bash\necho "serve $*" >> "${serveLog}"\nexit "\${SERVE_EXIT:-0}"\n`,
  )
  chmodSync(join(ws, 'scripts', 'serve.sh'), 0o755)
  writeFileSync(join(ws, 'README.md'), 'base\n')
  git(ws, 'add', '-A')
  git(ws, 'commit', '--quiet', '-m', 'base')
  git(ws, 'push', '--quiet', 'origin', BRANCH)

  // The incoming commit, then rewind the checkout so origin/main is 1 ahead.
  for (const [rel, contents] of Object.entries(ahead)) writeFileSync(join(ws, rel), contents)
  git(ws, 'add', '-A')
  git(ws, 'commit', '--quiet', '-m', 'ahead')
  git(ws, 'push', '--quiet', 'origin', BRANCH)
  git(ws, 'reset', '--hard', '--quiet', 'HEAD~1')

  // Fake npm: logs "<verb> @ <cwd>"; exit codes driven by env so a test can fail
  // one specific step (ci / install / build).
  const npmLog = join(root, 'npm.log')
  writeFileSync(
    join(fakeBin, 'npm'),
    [
      '#!/usr/bin/env bash',
      `echo "$* @ $PWD" >> "${npmLog}"`,
      'if [ "$1" = "ci" ]; then exit "${NPM_CI_EXIT:-0}"; fi',
      'if [ "$1" = "install" ]; then exit "${NPM_INSTALL_EXIT:-0}"; fi',
      'if [ "$1" = "run" ] && [ "$2" = "build" ]; then exit "${NPM_BUILD_EXIT:-0}"; fi',
      'exit 0',
    ].join('\n') + '\n',
  )
  chmodSync(join(fakeBin, 'npm'), 0o755)

  return { root, ws, git: (...a) => git(ws, ...a), fakeBin, npmLog, serveLog, statePath: join(root, 'state.json'), deployLog: join(root, 'deploy.log') }
}

function runDeploy(env, extra = {}) {
  const script = buildDeployScript({
    repoPath: env.ws,
    branch: BRANCH,
    deployLog: env.deployLog,
    state: env.statePath,
  })
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf-8',
    env: { ...process.env, ...GIT_ISO, PATH: `${env.fakeBin}:${process.env.PATH}`, ...extra },
  })
  return {
    code: r.status,
    npm: existsSync(env.npmLog) ? readFileSync(env.npmLog, 'utf-8') : '',
    serve: existsSync(env.serveLog) ? readFileSync(env.serveLog, 'utf-8') : '',
    state: existsSync(env.statePath) ? JSON.parse(readFileSync(env.statePath, 'utf-8')) : null,
  }
}

test('web lockfile changed → npm ci in web (not api), builds, restarts, state done', () => {
  const env = makeRepo({ 'web/package-lock.json': '{"name":"web","version":"next"}\n' })
  const r = runDeploy(env)
  assert.equal(r.code, 0)
  assert.match(r.npm, /^ci @ .*\/web$/m, 'should npm ci in web')
  assert.doesNotMatch(r.npm, /ci @ .*\/api/, 'api lockfile unchanged → no npm ci in api')
  assert.match(r.npm, /run build @ .*\/web$/m, 'should build web')
  assert.match(r.serve, /^serve restart$/m, 'should restart')
  assert.equal(r.state.phase, 'done')
  assert.equal(r.state.targetSha, env.git('rev-parse', '--short', 'HEAD'), 'state names the sha now live')
})

test('no lockfile change → build + restart, but NO npm ci (fast path)', () => {
  const env = makeRepo({ 'README.md': 'changed, no deps\n' })
  const r = runDeploy(env)
  assert.equal(r.code, 0)
  assert.doesNotMatch(r.npm, /^ci @/m, 'no lockfile change → must not npm ci')
  assert.match(r.npm, /run build @ .*\/web$/m, 'still builds')
  assert.match(r.serve, /^serve restart$/m, 'still restarts')
  assert.equal(r.state.phase, 'done')
})

test('api lockfile changed → npm ci in api (not web)', () => {
  const env = makeRepo({ 'api/package-lock.json': '{"name":"api","version":"next"}\n' })
  const r = runDeploy(env)
  assert.equal(r.code, 0)
  assert.match(r.npm, /^ci @ .*\/api$/m, 'should npm ci in api')
  assert.doesNotMatch(r.npm, /ci @ .*\/web/, 'web lockfile unchanged → no npm ci in web')
  assert.equal(r.state.phase, 'done')
})

test('npm ci fails → falls back to npm install', () => {
  const env = makeRepo({ 'web/package-lock.json': '{"name":"web","version":"next"}\n' })
  const r = runDeploy(env, { NPM_CI_EXIT: '1' })
  assert.equal(r.code, 0)
  assert.match(r.npm, /^ci @ .*\/web$/m, 'tries npm ci first')
  assert.match(r.npm, /^install @ .*\/web$/m, 'falls back to npm install')
  assert.equal(r.state.phase, 'done')
})

test('dirty checkout → refuses with the reason, nothing merged, no restart', () => {
  const env = makeRepo({ 'README.md': 'incoming\n' })
  const before = env.git('rev-parse', 'HEAD')
  writeFileSync(join(env.ws, 'README.md'), 'local edit nobody committed\n')
  const r = runDeploy(env)
  assert.notEqual(r.code, 0)
  assert.equal(r.state.phase, 'error')
  assert.equal(r.state.step, 'dirty')
  assert.match(r.state.reason, /uncommitted changes/)
  assert.equal(env.git('rev-parse', 'HEAD'), before, 'must not merge over local work')
  assert.equal(r.serve, '', 'must not restart')
})

test('diverged checkout → non-fast-forward refusal names the branch, no restart', () => {
  const env = makeRepo({ 'README.md': 'incoming\n' })
  // A local commit origin doesn't have → the ff-only merge can't apply.
  writeFileSync(join(env.ws, 'LOCAL.md'), 'diverged\n')
  env.git('add', '-A')
  env.git('commit', '--quiet', '-m', 'local only')
  const before = env.git('rev-parse', 'HEAD')
  const r = runDeploy(env)
  assert.notEqual(r.code, 0)
  assert.equal(r.state.phase, 'error')
  assert.equal(r.state.step, 'merge')
  assert.match(r.state.reason, new RegExp(`origin/${BRANCH}`), 'reason names what it diverged from')
  assert.equal(env.git('rev-parse', 'HEAD'), before, 'refuses rather than force')
  assert.equal(r.npm, '', 'must not install or build')
  assert.equal(r.serve, '', 'must not restart')
})

test('build fails → state error:build, NO restart (visible failure)', () => {
  const env = makeRepo({ 'web/package-lock.json': '{"name":"web","version":"next"}\n' })
  const r = runDeploy(env, { NPM_BUILD_EXIT: '1' })
  assert.notEqual(r.code, 0, 'the script exits non-zero on build failure')
  assert.match(r.npm, /^ci @ .*\/web$/m, 'deps still installed before build')
  assert.equal(r.serve, '', 'must NOT restart after a failed build')
  assert.equal(r.state.phase, 'error')
  assert.equal(r.state.step, 'build')
})

test('dep install fails → state error:deps, no build, no restart', () => {
  const env = makeRepo({ 'web/package-lock.json': '{"name":"web","version":"next"}\n' })
  const r = runDeploy(env, { NPM_CI_EXIT: '1', NPM_INSTALL_EXIT: '1' })
  assert.notEqual(r.code, 0)
  assert.doesNotMatch(r.npm, /run build/, 'must not build when deps failed')
  assert.equal(r.serve, '', 'must not restart when deps failed')
  assert.equal(r.state.phase, 'error')
  assert.equal(r.state.step, 'deps')
})

test('restart fails → state error:restart (build succeeded, restart did not)', () => {
  const env = makeRepo({ 'README.md': 'no deps\n' })
  const r = runDeploy(env, { SERVE_EXIT: '1' })
  assert.notEqual(r.code, 0)
  assert.match(r.npm, /run build @ .*\/web$/m, 'build ran')
  assert.match(r.serve, /^serve restart$/m, 'restart was attempted')
  assert.equal(r.state.phase, 'error')
  assert.equal(r.state.step, 'restart')
})

test('every state line is valid JSON with the four fields the card reads', () => {
  const env = makeRepo({ 'README.md': 'plain\n' })
  const r = runDeploy(env)
  for (const k of ['phase', 'step', 'reason', 'targetSha', 'at']) assert.ok(k in r.state, `state carries ${k}`)
  assert.match(r.state.at, /^\d{4}-\d{2}-\d{2}T/, 'at is an ISO timestamp')
})
