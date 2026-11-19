/* ------------------------------------------------------------------ *
 * A new dev-agent worktree starts from a FRESHLY FETCHED origin default
 * branch, not from whatever the shared checkout has checked out
 * (api/src/worktree-base.mjs).
 *
 * Why: both spawn paths ran `git worktree add -b <branch> <worktree>` with no
 * start point and no fetch, so a shared checkout 50 commits behind origin seeded
 * every new agent with stale code — each agent branch's reflog said
 * `branch: Created from HEAD`.
 *
 * Pinned here against REAL git repos (a bare origin + a stale shared clone):
 * fetch runs before the add, the add carries --no-track and the resolved start
 * ref, the shared checkout itself is never moved, a failed fetch still spawns
 * on the last fetched origin ref, and with no origin ref at all the HEAD
 * fallback is recorded. The box executor is driven end to end through spawn()
 * (with a fake `tmux` on PATH); the bridge can't be imported (it binds a port),
 * so its wiring is asserted on SOURCE, as agent-capacity.test.mjs does.
 * Run: node --test api/test/worktree-base.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync } from 'node:child_process'

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))

// Fixture commits must not depend on the runner's git identity (HOME moves below).
Object.assign(process.env, {
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
})

// The box executor, imported with a sandboxed state dir, repo allowlist, HOME
// (ensureRepoTrusted writes ~/.claude.json) and a fake `tmux` ahead of the real
// one, so spawn() runs its real git path and nothing else of this box's.
const STATE_DIR = tmp('atlas-kit-wtbase-state-')
const REPOS_FILE = path.join(tmp('atlas-kit-wtbase-repos-'), 'agent-local-repos.json')
const FAKE_BIN = tmp('atlas-kit-wtbase-bin-')
fs.writeFileSync(path.join(FAKE_BIN, 'tmux'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
// …and a stub `claude`: the kit's spawn refuses outright when the CLI does not
// resolve (claude-bin.mjs), and a CI runner has none. tmux is fake, so it never runs.
fs.writeFileSync(path.join(FAKE_BIN, 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
Object.assign(process.env, {
  AGENT_LOCAL_DIR: STATE_DIR,
  AGENT_LOCAL_REPOS: REPOS_FILE,
  AGENT_LOCAL_RECONCILE: '0',
  AGENT_LOCAL_DRIVE: '0',
  AGENT_LOCAL_REVIVE_MEM_FLOOR_MB: '0',
  AGENT_LOCAL_REVIVE_MEM_PER_AGENT_MB: '0',
  WORKSPACE_DIR: tmp('atlas-kit-wtbase-ws-'),
  HOME: tmp('atlas-kit-wtbase-home-'),
  PATH: `${FAKE_BIN}:${process.env.PATH}`,
  CLAUDE_BIN: path.join(FAKE_BIN, 'claude'),
})

const { addAgentWorktree, BASE_FETCH_TIMEOUT_MS } = await import('../src/worktree-base.mjs')
const local = await import('../src/agent-local.mjs')

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim()
const commit = (dir, msg) => {
  fs.writeFileSync(path.join(dir, 'f.txt'), `${msg}\n`)
  git(dir, 'add', 'f.txt')
  git(dir, 'commit', '-q', '-m', msg)
  return git(dir, 'rev-parse', 'HEAD')
}

// origin (bare, default branch `branch`) + the SHARED checkout cloned from it +
// a second clone that pushes `ahead` more commits — so the shared checkout's
// local branch is stale against origin, exactly as in the field.
function fixture({ branch = 'master', ahead = 2 } = {}) {
  const root = tmp('atlas-kit-wtbase-')
  const origin = path.join(root, 'origin.git')
  const shared = path.join(root, 'shared')
  const other = path.join(root, 'other')
  execFileSync('git', ['init', '-q', '--bare', '-b', branch, origin])
  execFileSync('git', ['clone', '-q', origin, other], { stdio: 'pipe' })
  git(other, 'checkout', '-q', '-b', branch)
  const old = commit(other, 'old')
  git(other, 'push', '-q', 'origin', branch)
  execFileSync('git', ['clone', '-q', origin, shared], { stdio: 'pipe' })
  let tip = old
  for (let i = 0; i < ahead; i++) tip = commit(other, `new ${i}`)
  git(other, 'push', '-q', 'origin', branch)
  return { root, origin, shared, old, tip }
}

// The box executor's shape: argv only, { ok, stdout, stderr }, recording each call.
function recorder() {
  const calls = []
  const exec = (argv, o = {}) => {
    calls.push({ argv, o })
    return new Promise((resolve) =>
      execFile(argv[0], argv.slice(1), o, (err, stdout, stderr) =>
        resolve({ ok: !err, stdout: stdout || '', stderr: (stderr || '') + (err && !stderr ? String(err.message) : '') })))
  }
  return { calls, exec }
}
const idx = (calls, sub) => calls.findIndex((c) => c.argv.includes(sub))
const addCall = (calls) => calls.find((c) => c.argv.includes('worktree') && c.argv.includes('add'))
const upstream = (dir) => {
  try {
    return git(dir, 'rev-parse', '--abbrev-ref', '@{u}')
  } catch {
    return null
  }
}

test('fetches BEFORE the add, and starts the worktree on origin/HEAD — not the stale shared checkout', async () => {
  const fx = fixture()
  const headBefore = git(fx.shared, 'rev-parse', 'HEAD')
  assert.equal(headBefore, fx.old, 'fixture: the shared checkout is behind origin')
  const wt = path.join(fx.root, 'wt')
  const { calls, exec } = recorder()

  const r = await addAgentWorktree({ repo: fx.shared, branch: 'agent/a', worktree: wt, exec })

  assert.equal(r.ok, true, r.stderr)
  const f = idx(calls, 'fetch')
  assert.ok(f >= 0 && f < calls.indexOf(addCall(calls)), 'fetch runs before worktree add')
  assert.deepEqual(calls[f].argv, ['git', '-C', fx.shared, 'fetch', 'origin'])
  assert.equal(calls[f].o.timeout, BASE_FETCH_TIMEOUT_MS, 'the fetch carries its own short timeout')
  assert.deepEqual(addCall(calls).argv, ['git', '-C', fx.shared, 'worktree', 'add', '--no-track', '-b', 'agent/a', wt, 'origin/master'])
  assert.deepEqual({ baseRef: r.baseRef, baseSha: r.baseSha, baseFetched: r.baseFetched }, { baseRef: 'origin/master', baseSha: fx.tip, baseFetched: true })
  assert.equal(git(wt, 'rev-parse', 'HEAD'), fx.tip, 'the worktree starts at origin\'s tip')
  assert.equal(upstream(wt), null, '--no-track: the agent branch has no upstream (a bare push must not target master)')
  // The shared checkout is never pulled, reset or fast-forwarded.
  assert.equal(git(fx.shared, 'rev-parse', 'HEAD'), headBefore)
  assert.equal(git(fx.shared, 'rev-parse', 'master'), headBefore)
  assert.equal(git(fx.shared, 'status', '--porcelain'), '')
})

test('origin/HEAD unset → origin/main when that is what exists', async () => {
  const fx = fixture({ branch: 'main' })
  git(fx.shared, 'remote', 'set-head', 'origin', '-d')
  const { exec } = recorder()
  const r = await addAgentWorktree({ repo: fx.shared, branch: 'agent/m', worktree: path.join(fx.root, 'wt'), exec })
  assert.equal(r.ok, true, r.stderr)
  assert.deepEqual([r.baseRef, r.baseSha], ['origin/main', fx.tip])
})

test('a per-repo baseRef override wins when it resolves', async () => {
  const fx = fixture()
  const other = path.join(fx.root, 'other')
  git(other, 'checkout', '-q', '-b', 'develop')
  const dev = commit(other, 'develop')
  git(other, 'push', '-q', 'origin', 'develop')
  const { calls, exec } = recorder()
  const r = await addAgentWorktree({ repo: fx.shared, branch: 'agent/o', worktree: path.join(fx.root, 'wt'), baseRef: 'origin/develop', exec })
  assert.equal(r.ok, true, r.stderr)
  assert.deepEqual([r.baseRef, r.baseSha], ['origin/develop', dev])
  assert.equal(addCall(calls).argv.at(-1), 'origin/develop')
})

test('a FAILED fetch still spawns, on the last fetched origin ref, and says so', async () => {
  const fx = fixture()
  git(fx.shared, 'remote', 'set-url', 'origin', path.join(fx.root, 'gone.git')) // offline / auth failure
  const { exec } = recorder()
  const r = await addAgentWorktree({ repo: fx.shared, branch: 'agent/f', worktree: path.join(fx.root, 'wt'), exec })
  assert.equal(r.ok, true, r.stderr)
  assert.equal(r.baseFetched, false)
  assert.ok(r.fetchError, 'the fetch failure is carried for the audit line')
  assert.deepEqual([r.baseRef, r.baseSha], ['origin/master', fx.old], 'the last FETCHED origin ref — visibly stale')
})

test('no origin ref at all → HEAD, recorded as such', async () => {
  const root = tmp('atlas-kit-wtbase-noorigin-')
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', '-b', 'master', repo])
  const head = commit(repo, 'only')
  const { calls, exec } = recorder()
  const r = await addAgentWorktree({ repo, branch: 'agent/h', worktree: path.join(root, 'wt'), exec })
  assert.equal(r.ok, true, r.stderr)
  assert.deepEqual({ baseRef: r.baseRef, baseSha: r.baseSha, baseFetched: r.baseFetched }, { baseRef: 'HEAD', baseSha: head, baseFetched: false })
  assert.equal(addCall(calls).argv.at(-1), 'HEAD')
})

/* --- the box-local executor, end to end through spawn() ---------------- */
const auditLines = () =>
  fs.readFileSync(path.join(STATE_DIR, 'audit.log'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.action === 'spawn')
const sessionOf = (id) => JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'state.json'), 'utf-8')).sessions[id]

test('box-local spawn(): worktree on the fetched origin tip; base on the session and the audit line', async () => {
  const fx = fixture()
  fs.writeFileSync(REPOS_FILE, JSON.stringify({ fx: { path: fx.shared } }))
  const r = await local.spawn({ task: 'box fresh base', repo: 'fx' })
  assert.equal(r.ok, true, r.error)
  const s = sessionOf(r.id)
  assert.deepEqual([s.baseRef, s.baseSha, s.baseFetched], ['origin/master', fx.tip, true])
  assert.equal(git(s.worktree, 'rev-parse', 'HEAD'), fx.tip)
  assert.equal(upstream(s.worktree), null)
  assert.equal(git(fx.shared, 'rev-parse', 'HEAD'), fx.old, 'the shared checkout did not move')
  const a = auditLines().find((e) => e.id === r.id && e.ok)
  assert.deepEqual([a.baseRef, a.baseSha, a.baseFetched], ['origin/master', fx.tip, true])
})

test('box-local spawn(): a failed fetch still spawns; the HEAD fallback is recorded', async () => {
  const fx = fixture()
  git(fx.shared, 'remote', 'remove', 'origin') // nothing to fetch, no origin ref left
  fs.writeFileSync(REPOS_FILE, JSON.stringify({ fx: { path: fx.shared } }))
  const r = await local.spawn({ task: 'box head fallback', repo: 'fx' })
  assert.equal(r.ok, true, r.error)
  assert.deepEqual([sessionOf(r.id).baseRef, sessionOf(r.id).baseSha, sessionOf(r.id).baseFetched], ['HEAD', fx.old, false])
  const a = auditLines().find((e) => e.id === r.id && e.ok)
  assert.deepEqual([a.baseRef, a.baseSha, a.baseFetched], ['HEAD', fx.old, false])
  assert.ok(a.fetchError, 'why the fetch failed rides the audit line')
})

/* --- the bridge executor, asserted on SOURCE --------------------------- */
const bridge = fs.readFileSync(new URL('../../agent-bridge/server.mjs', import.meta.url), 'utf-8')
const localSrc = fs.readFileSync(new URL('../src/agent-local.mjs', import.meta.url), 'utf-8')
const fnBody = (src, sig) => {
  const start = src.indexOf(sig)
  assert.ok(start >= 0, `${sig} present`)
  return src.slice(start, src.indexOf('\n}\n', start))
}

test('bridge spawn(): the same helper, through docker exec, with its timeout forwarded', () => {
  assert.match(bridge, /import \{ addAgentWorktree \} from '\.\.\/api\/src\/worktree-base\.mjs'/)
  const spawn = fnBody(bridge, 'async function spawn({')
  assert.match(spawn, /addAgentWorktree\(\{\s*repo: target\.path, branch, worktree, baseRef: target\.baseRef,\s*exec: \(argv, o\) => dockerExec\(container, argv, o\),/)
  assert.doesNotMatch(spawn, /'worktree', 'add'/, 'no bare `worktree add` left in the dev spawn')
  assert.match(spawn, /Object\.assign\(session, wtBase\)/)
  assert.match(spawn, /audit\(\{ action: 'spawn', id, repo, \.\.\.wtBase, ok: false/)
  assert.match(spawn, /audit\(\{ action: 'spawn', id, repo, branch, container, \.\.\.wtBase,/)
})

test('box spawn(): no bare `worktree add` left in the dev spawn either', () => {
  const spawn = fnBody(localSrc, 'export async function spawn({')
  assert.match(spawn, /addAgentWorktree\(\{ repo: repoPath, branch, worktree, baseRef: target\.baseRef, exec: run \}\)/)
  assert.doesNotMatch(spawn, /'worktree', 'add'/)
})
