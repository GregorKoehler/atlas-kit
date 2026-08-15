/* ------------------------------------------------------------------ *
 * Tests for the Task Prospects HTTP routes (atlas-routes.mjs), end to end
 * against a real throwaway Atlas vault (bare origin + clone) — the commit-queue
 * path (pull --rebase -> mutate -> commit -> push) is real, not mocked.
 *
 * atlas-prospects.test.mjs covers the store in isolation; what is only testable
 * here is the ROUTE contract: POST /api/prospects/new -> GET /api/prospects;
 * POST .../approve writes the REAL task through createTask (the exact
 * /api/tasks/new path, with edit-then-approve overrides) and stamps the sticky
 * "approved" decision; POST .../reject discards WITHOUT ever touching the vault
 * and stamps "rejected"; and the sticky guarantee end to end (propose -> reject
 * -> the producer re-scans the same source -> nothing is re-proposed).
 *
 * Run: node --test api/test/atlas-prospects-routes.test.mjs
 * ------------------------------------------------------------------ */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import { execFileSync } from 'node:child_process'

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV }).trim()
}

// A throwaway Atlas vault: a bare "origin" + a clone — enqueueAtlasCommit pulls
// --rebase and pushes against a real origin. Also carries Wiki/Legend.md so
// isTypedVault('atlas') is true (createTask / prospects/new require a TYPED vault).
function makeAtlasVault(branchName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-prospects-vault-'))
  const remote = path.join(root, 'remote.git')
  const vault = path.join(root, 'vault')
  git(root, 'init', '--bare', '-q', ...(branchName ? ['-b', branchName] : []), remote)
  git(root, 'clone', '-q', remote, vault)
  git(vault, 'config', 'user.email', 'test@example.com')
  git(vault, 'config', 'user.name', 'Test')
  fs.mkdirSync(path.join(vault, 'Tasks'), { recursive: true })
  fs.mkdirSync(path.join(vault, 'Wiki'), { recursive: true })
  fs.writeFileSync(path.join(vault, 'Wiki', 'Legend.md'), '# Legend\n')
  fs.writeFileSync(path.join(vault, 'README.md'), '# vault\n')
  git(vault, 'add', '.')
  git(vault, 'commit', '-q', '-m', 'init')
  const branch = branchName || git(vault, 'rev-parse', '--abbrev-ref', 'HEAD')
  git(vault, 'push', '-q', 'origin', branch)
  return { vault, branch }
}

const { vault, branch } = makeAtlasVault()
// vaults.mjs / atlas-commit-queue.mjs freeze env-derived constants at import
// time — set these BEFORE the first (dynamic) import of the modules under test.
const vaultsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-prospects-reg-')), 'vaults.json')
fs.writeFileSync(vaultsFile, JSON.stringify({ atlas: { path: vault, label: 'Test Atlas', default: true } }))
process.env.VAULTS_FILE = vaultsFile
process.env.ATLAS_BRANCH = branch
process.env.ATLAS_PROSPECTS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-prospects-state-')), 'atlas-prospects.json')

let atlasRouter
before(async () => {
  ;({ atlasRouter } = await import('../src/atlas-routes.mjs'))
})

let bearerCalls = 0
function makeApp() {
  bearerCalls = 0
  const bearerAuth = (_req, _res, next) => {
    bearerCalls++
    next()
  }
  const app = express()
  app.use(express.json())
  app.use(atlasRouter(bearerAuth))
  return app
}

async function withServer(fn) {
  const server = makeApp().listen(0)
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    return await fn(base)
  } finally {
    server.close()
  }
}

/* ------------------------------------------------------------------ *
 * propose -> GET pending queue
 * ------------------------------------------------------------------ */

test('POST /api/prospects/new: files a pending prospect, visible on GET /api/prospects', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/prospects/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Add a retry to the vault sync', body: 'it fails on a slow push', area: 'Infrastructure', source: 'agent' }),
    })
    const posted = await res.json()
    assert.equal(posted.ok, true, JSON.stringify(posted))
    assert.ok(posted.id)

    const list = await (await fetch(`${base}/api/prospects`)).json()
    const found = list.items.find((p) => p.id === posted.id)
    assert.equal(found.title, 'Add a retry to the vault sync')
    assert.equal(found.area, 'Infrastructure')
    assert.equal(bearerCalls, 1, 'bearerAuth must run on the write route')
  })
})

/* ------------------------------------------------------------------ *
 * approve -> the EXACT /api/tasks/new path (createTask)
 * ------------------------------------------------------------------ */

test('POST /api/prospects/approve: writes the real task via createTask, removes it from the queue, sticky-approves', async () => {
  await withServer(async (base) => {
    const propose = await (
      await fetch(`${base}/api/prospects/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: 'Make the bridge timeout configurable',
          body: 'Source: dev agent `my-app` — the bridge exec timeout is hardcoded',
          area: 'Infrastructure',
          source: 'agent',
          sourceKey: 'dev-agent:my-app:bridge-timeout',
        }),
      })
    ).json()
    assert.equal(propose.ok, true)

    const approve = await (
      await fetch(`${base}/api/prospects/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: propose.id }),
      })
    ).json()
    assert.equal(approve.ok, true, JSON.stringify(approve))
    assert.ok(approve.path, 'createTask returns the new Tasks/<slug>.md path')

    const note = fs.readFileSync(path.join(vault, approve.path), 'utf-8')
    assert.match(note, /type: task/)
    assert.match(note, /status: inbox/)
    assert.match(note, /source: agent/)
    assert.match(note, /area: "\[\[Infrastructure\]\]"/)
    assert.match(note, /Make the bridge timeout configurable/)

    const list = await (await fetch(`${base}/api/prospects`)).json()
    assert.equal(list.items.some((p) => p.id === propose.id), false, 'removed from the pending queue on approve')

    // The sticky guarantee also covers approved sources — a producer that
    // re-notices the same rough edge must not propose a second, duplicate task.
    const reproposed = await (
      await fetch(`${base}/api/prospects/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Make the bridge timeout configurable (again)', sourceKey: 'dev-agent:my-app:bridge-timeout' }),
      })
    ).json()
    assert.equal(reproposed.ok, false)
    assert.equal(reproposed.skipped, 'decided')
    assert.equal(reproposed.decision, 'approved')
  })
})

test('POST /api/prospects/approve: edit-then-approve overrides the proposed title/due', async () => {
  await withServer(async (base) => {
    const propose = await (
      await fetch(`${base}/api/prospects/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Original title', area: 'Health' }),
      })
    ).json()

    const approve = await (
      await fetch(`${base}/api/prospects/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: propose.id, edits: { title: 'Corrected title', due: '2026-09-01' } }),
      })
    ).json()
    assert.equal(approve.ok, true, JSON.stringify(approve))

    const note = fs.readFileSync(path.join(vault, approve.path), 'utf-8')
    assert.match(note, /Corrected title/)
    assert.doesNotMatch(note, /Original title/)
    assert.match(note, /due: 2026-09-01/)
    assert.match(note, /area: "\[\[Health\]\]"/, "fields NOT in edits keep the prospect's own value")
  })
})

/* ------------------------------------------------------------------ *
 * reject -> the sticky guarantee, end to end
 * ------------------------------------------------------------------ */

test('sticky guarantee end-to-end: propose -> reject -> the producer re-scans the same source -> nothing is re-proposed, vault untouched', async () => {
  await withServer(async (base) => {
    const key = 'dev-agent:my-app:flaky-push'
    const before = fs.readdirSync(path.join(vault, 'Tasks')).length

    const propose = await (
      await fetch(`${base}/api/prospects/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Retry the flaky vault push?', sourceKey: key }),
      })
    ).json()
    assert.equal(propose.ok, true)

    const reject = await (
      await fetch(`${base}/api/prospects/reject`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: propose.id }),
      })
    ).json()
    assert.equal(reject.ok, true)

    const list = await (await fetch(`${base}/api/prospects`)).json()
    assert.equal(list.items.some((p) => p.id === propose.id), false)

    // The producer runs again an hour later and re-scans the SAME source.
    const reproposed = await (
      await fetch(`${base}/api/prospects/new`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Retry the flaky vault push? (re-worded)', sourceKey: key }),
      })
    ).json()
    assert.equal(reproposed.ok, false)
    assert.equal(reproposed.skipped, 'decided')
    assert.equal(reproposed.decision, 'rejected')

    const list2 = await (await fetch(`${base}/api/prospects`)).json()
    assert.equal(list2.items.some((p) => p.sourceKey === key), false, 'never re-queued')
    assert.equal(fs.readdirSync(path.join(vault, 'Tasks')).length, before, 'a rejected prospect NEVER touches the vault')
  })
})
