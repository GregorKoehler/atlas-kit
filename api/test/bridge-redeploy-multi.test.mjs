/* ------------------------------------------------------------------ *
 * Tests for the MULTI-BRIDGE redeploy routes (agent-routes.mjs) — the box
 * addressing any registered bridge by label, not just the catch-all one:
 *  - GET /api/agents/bridge-status: no label = the default bridge (the legacy
 *    shape a phone with cached JS still sends) and carries `labels`;
 *    ?label=<x> resolves through bridgeByLabel to THAT bridge.
 *  - POST /api/agents/bridge-redeploy: {label} picks the bridge; omitting it
 *    is unchanged; an UNKNOWN label is a 404 naming the configured labels and
 *    NEVER falls back to the default (redeploying the wrong machine is the one
 *    dangerous failure this surface has).
 *  - the behind-count TTL cache is keyed per bridge, so one bridge's count is
 *    never served for another (a shared key leaked it whenever the other bridge
 *    reported no sha — i.e. was unreachable).
 *
 * WORKSPACE_DIR is a REAL throwaway git repo here (unlike the sibling
 * agent-routes-bridge-status.test.mjs, which points at a non-repo to exercise
 * the degrade path) so `behind` is actually computed: its origin is itself, so
 * the `git fetch origin <branch>` inside bridgeBehind resolves without a
 * network. The fixture's branch is `main` — the kit's own default branch, which
 * is what BRIDGE_DEPLOY_BRANCH falls back to, so no env override is needed and
 * the default path is the one under test.
 *
 * Run: node --test api/test/bridge-redeploy-multi.test.mjs
 * ------------------------------------------------------------------ */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.AGENT_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-bridge-multi-local-'))
process.env.AGENT_LOCAL_RECONCILE = '0'
const REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-bridge-multi-ws-'))
process.env.WORKSPACE_DIR = REPO

// A two-commit repo whose commits touch the paths bridgeBehind counts
// (agent-bridge/), with `origin` pointing back at itself.
function git(...args) {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf-8' }).trim()
}
fs.mkdirSync(path.join(REPO, 'agent-bridge'))
git('init', '--quiet', '--initial-branch=main')
git('config', 'user.email', 'test@example.com')
git('config', 'user.name', 'test')
fs.writeFileSync(path.join(REPO, 'agent-bridge', 'server.mjs'), 'v1\n')
git('add', '-A')
git('commit', '--quiet', '-m', 'feat(bridge): v1')
const SHA_OLD = git('rev-parse', 'HEAD')
fs.writeFileSync(path.join(REPO, 'agent-bridge', 'server.mjs'), 'v2\n')
git('commit', '--quiet', '-am', 'fix(bridge): v2')
const SHA_HEAD = git('rev-parse', 'HEAD')
git('remote', 'add', 'origin', REPO)
git('fetch', '--quiet', 'origin', 'main')

const { agentRouter } = await import('../src/agent-routes.mjs')

const TOK_A = 'token-bridge-a'
const TOK_B = 'token-bridge-b'
const LABEL_B = 'second-box'
const hits = { a: 0, b: 0 }

// A fake bridge reporting `sha` from /health and counting its /redeploy calls.
function startFakeBridge(sha, token, which) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const json = (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.headers['authorization'] !== `Bearer ${token}`) return json(401, { ok: false, error: 'unauthorized' })
      if (req.method === 'GET' && req.url === '/health') return json(200, { ok: true, service: 'agent-bridge', sha })
      if (req.method === 'GET' && req.url === '/redeploy-status') return json(200, { ok: true, redeploy: null })
      if (req.method === 'POST' && req.url === '/redeploy') {
        hits[which]++
        return json(202, { ok: true, started: true, bridge: which })
      }
      json(404, { ok: false, error: 'not found' })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

let bridgeA, bridgeB
let bearerCalls = 0

function makeApp() {
  const bearerAuth = (_req, _res, next) => {
    bearerCalls++
    next()
  }
  const app = express()
  app.use(express.json())
  app.use(agentRouter(bearerAuth))
  return app
}

// Run one request against a freshly-listening app; returns { status, body }.
async function call(pathname, init) {
  const server = makeApp().listen(0)
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${pathname}`, init)
    return { status: res.status, body: await res.json() }
  } finally {
    server.close()
  }
}

const post = (label) =>
  call('/api/agents/bridge-redeploy', {
    method: 'POST',
    ...(label === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ label }) }),
  })

before(async () => {
  bridgeA = await startFakeBridge(SHA_OLD, TOK_A, 'a') // one commit behind the default branch
  bridgeB = await startFakeBridge(SHA_HEAD, TOK_B, 'b') // up to date
  process.env.AGENT_BRIDGE_URL = `http://127.0.0.1:${bridgeA.address().port}`
  process.env.AGENT_BRIDGE_TOKEN = TOK_A
  process.env.AGENT_BRIDGES = JSON.stringify([
    { label: LABEL_B, url: `http://127.0.0.1:${bridgeB.address().port}`, token: TOK_B, repos: ['demo-app'] },
  ])
})

after(() => {
  bridgeA.close()
  bridgeB.close()
  delete process.env.AGENT_BRIDGES
})

test('GET bridge-status without a label = the default bridge, and lists every label', async () => {
  const { status, body } = await call('/api/agents/bridge-status')
  assert.equal(status, 200)
  assert.equal(body.label, 'workstation')
  assert.equal(body.sha, SHA_OLD)
  assert.deepEqual(body.labels, ['workstation', LABEL_B])
})

test('GET bridge-status?label= resolves to THAT bridge', async () => {
  const { status, body } = await call(`/api/agents/bridge-status?label=${LABEL_B}`)
  assert.equal(status, 200)
  assert.equal(body.label, LABEL_B)
  assert.equal(body.sha, SHA_HEAD, 'must report the labelled bridge’s own running SHA')
})

test('behind is computed per bridge — a bridge with no sha never inherits another’s count', async () => {
  process.env.AGENT_BRIDGES = JSON.stringify([
    ...JSON.parse(process.env.AGENT_BRIDGES),
    { label: 'dead-box', url: 'http://127.0.0.1:1', token: 'unused', repos: ['nothing'] },
  ])
  // The default bridge is one bridge-relevant commit behind origin/main, and
  // that lands in ITS cache entry…
  const first = await call('/api/agents/bridge-status?fresh=1')
  assert.equal(first.body.behind, 1)
  assert.deepEqual(first.body.changes, ['v2'])
  // …so an UNREACHABLE bridge polled next — no sha, therefore falling back to
  // the last known count — must fall back to its OWN (empty) entry, not to the
  // one just written. A single shared cache answered 1 here.
  const dead = await call('/api/agents/bridge-status?label=dead-box')
  assert.equal(dead.body.reachable, false)
  assert.equal(dead.body.behind, 0, 'must not cross-serve another bridge’s behind-count')
  assert.deepEqual(dead.body.changes, [])
  // And a reachable bridge at HEAD computes its own 0, leaving the default's 1
  // intact for the next poll.
  const second = await call(`/api/agents/bridge-status?label=${LABEL_B}&fresh=1`)
  assert.equal(second.body.behind, 0)
  assert.deepEqual(second.body.changes, [])
  const again = await call('/api/agents/bridge-status')
  assert.equal(again.body.behind, 1)
})

test('GET bridge-status with an unknown label 404s and names the configured labels', async () => {
  const { status, body } = await call('/api/agents/bridge-status?label=nope')
  assert.equal(status, 404)
  assert.equal(body.ok, false)
  assert.match(body.error, /unknown bridge "nope"/)
  assert.match(body.error, /workstation/)
  assert.match(body.error, new RegExp(LABEL_B))
  assert.equal(body.sha, undefined, 'must not answer with some other bridge’s status')
})

test('POST bridge-redeploy {label} proxies to that bridge only', async () => {
  hits.a = 0
  hits.b = 0
  const { status, body } = await post(LABEL_B)
  assert.equal(status, 202)
  assert.deepEqual(body, { ok: true, started: true, bridge: 'b' })
  assert.equal(hits.a, 0, 'the default bridge must not be touched')
  assert.equal(hits.b, 1)
})

test('POST bridge-redeploy without a label is unchanged: the default bridge', async () => {
  hits.a = 0
  hits.b = 0
  const { status, body } = await post(undefined)
  assert.equal(status, 202)
  assert.equal(body.bridge, 'a')
  assert.equal(hits.a, 1)
  assert.equal(hits.b, 0)
})

test('POST bridge-redeploy with an unknown label 404s and redeploys NOTHING', async () => {
  hits.a = 0
  hits.b = 0
  bearerCalls = 0
  const { status, body } = await post('workstatoin') // typo'd label
  assert.equal(status, 404)
  assert.equal(body.ok, false)
  assert.match(body.error, /unknown bridge "workstatoin"/)
  assert.equal(hits.a, 0, 'an unknown label must NEVER fall back to the default bridge')
  assert.equal(hits.b, 0)
  assert.equal(bearerCalls, 1, 'still behind the bearer gate')
})

test('POST bridge-redeploy stays bearer-gated on the labelled path too', async () => {
  bearerCalls = 0
  await post(LABEL_B)
  assert.equal(bearerCalls, 1)
})
