/* ------------------------------------------------------------------ *
 * Tests for the box's workstation-bridge redeploy routes (agent-routes.mjs):
 *  - GET /api/agents/bridge-status: shape with no bridge configured, and with a
 *    fake reachable bridge (folds its /health sha + /redeploy-status phase in).
 *  - POST /api/agents/bridge-redeploy: goes through bearerAuth, proxies to the
 *    default bridge's /redeploy verbatim (status + body), and 503s with no
 *    bridge configured (without skipping bearerAuth).
 *
 * The git behind-count computation (bridgeBehind) is exercised only enough to
 * confirm it degrades gracefully when WORKSPACE_DIR isn't a git repo; the
 * counting itself — and the per-bridge cache it writes into — is covered against
 * a real throwaway repo in bridge-redeploy-multi.test.mjs.
 *
 * bridges.mjs reads AGENT_BRIDGE_URL/TOKEN fresh per call (no restart needed),
 * so each test can point the "workstation" at a fresh fake bridge instance.
 * AGENT_LOCAL_DIR/AGENT_LOCAL_RECONCILE sandbox agent-local.mjs (transitively
 * imported) away from the real box state, and WORKSPACE_DIR away from the real
 * checkout — the same convention as the sibling bridge tests.
 *
 * Run: node --test api/test/agent-routes-bridge-status.test.mjs
 * ------------------------------------------------------------------ */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.AGENT_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-bridge-status-local-'))
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-bridge-status-ws-')) // not a git repo
// "No bridge configured" must be a FACT THIS TEST SETS: left unset, the registry
// falls through to an operator-local api/src/bridges.json, and a box that has one
// would answer the first case with a real bridge. '[]' pins the world.
process.env.AGENT_BRIDGES = '[]'

const { agentRouter } = await import('../src/agent-routes.mjs')

const FAKE_TOKEN = 'test-bridge-token'
let fakeBridge, fakeBridgeUrl, redeployCalls, bearerCalls

function startFakeBridge() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const auth = req.headers['authorization'] || ''
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, service: 'agent-bridge', sha: 'abc1234' }))
      }
      if (auth !== `Bearer ${FAKE_TOKEN}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
      }
      if (req.method === 'GET' && req.url === '/redeploy-status') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(
          JSON.stringify({ ok: true, redeploy: { phase: 'done', step: 'ok', sha: 'abc1234', at: '2026-01-01T00:00:00Z' } }),
        )
      }
      if (req.method === 'POST' && req.url === '/redeploy') {
        redeployCalls++
        res.writeHead(202, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, started: true }))
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function makeApp() {
  bearerCalls = 0
  const bearerAuth = (_req, _res, next) => {
    bearerCalls++
    next()
  }
  const app = express()
  app.use(agentRouter(bearerAuth))
  return app
}

before(async () => {
  fakeBridge = await startFakeBridge()
  fakeBridgeUrl = `http://127.0.0.1:${fakeBridge.address().port}`
})

after(() => {
  fakeBridge.close()
})

test('GET /api/agents/bridge-status: no bridge configured → reachable:false, no crash', async () => {
  delete process.env.AGENT_BRIDGE_URL
  delete process.env.AGENT_BRIDGE_TOKEN
  const server = makeApp().listen(0)
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/agents/bridge-status`)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.reachable, false)
    assert.equal(body.sha, '')
    assert.equal(body.behind, 0)
    assert.deepEqual(body.changes, [])
    assert.equal(body.redeploy, null)
  } finally {
    server.close()
  }
})

test('GET /api/agents/bridge-status: reachable bridge → folds sha + redeploy phase from the bridge', async () => {
  process.env.AGENT_BRIDGE_URL = fakeBridgeUrl
  process.env.AGENT_BRIDGE_TOKEN = FAKE_TOKEN
  const server = makeApp().listen(0)
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/agents/bridge-status`)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.reachable, true)
    assert.equal(body.sha, 'abc1234')
    assert.equal(body.behind, 0) // WORKSPACE_DIR isn't a git repo → git fetch fails → degrades to 0, not a crash
    assert.deepEqual(body.redeploy, { phase: 'done', step: 'ok', sha: 'abc1234', at: '2026-01-01T00:00:00Z' })
  } finally {
    server.close()
  }
})

test('POST /api/agents/bridge-redeploy: no bridge configured → 503 (bearerAuth still runs)', async () => {
  delete process.env.AGENT_BRIDGE_URL
  delete process.env.AGENT_BRIDGE_TOKEN
  const server = makeApp().listen(0)
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/agents/bridge-redeploy`, { method: 'POST' })
    assert.equal(res.status, 503)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(bearerCalls, 1, 'bearerAuth middleware must still run even though there is no bridge')
  } finally {
    server.close()
  }
})

test('POST /api/agents/bridge-redeploy: goes through bearerAuth and proxies to the default bridge /redeploy', async () => {
  process.env.AGENT_BRIDGE_URL = fakeBridgeUrl
  process.env.AGENT_BRIDGE_TOKEN = FAKE_TOKEN
  redeployCalls = 0
  const server = makeApp().listen(0)
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/agents/bridge-redeploy`, { method: 'POST' })
    assert.equal(bearerCalls, 1)
    assert.equal(redeployCalls, 1, 'must proxy through to the bridge /redeploy exactly once')
    assert.equal(res.status, 202)
    const body = await res.json()
    assert.deepEqual(body, { ok: true, started: true })
  } finally {
    server.close()
  }
})
