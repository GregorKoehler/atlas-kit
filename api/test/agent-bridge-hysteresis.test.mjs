/* ------------------------------------------------------------------ *
 * Tests for the bridge-poll hysteresis in agent-routes.mjs
 * (resolveBridgePoll, wired into GET /api/agents): a single failed bridge
 * poll must not blank the project cards / Agent constellation. The bug this
 * guards: a workstation bridge's GET /sessions can take longer than
 * AGENT_BRIDGE_TIMEOUT_MS under a big fleet, so an occasional failed poll is
 * expected even after a bridge-side speedup — the box must ride it out
 * instead of dropping every workstation session for one bad beat.
 *
 * Failures are simulated as fast HTTP 500s (not real timeouts) so the tests
 * stay quick; AGENT_BRIDGE_STALE_FAILURES / AGENT_BRIDGE_STALE_MAX_MS are
 * read fresh per call (like the rest of that file's runtime config), so each
 * test can dial them down to isolate the failure-count vs. staleness-age
 * trigger without a real 60s wait.
 *
 * Same sandbox convention as agent-routes-bridge-status.test.mjs: fresh
 * AGENT_LOCAL_DIR/WORKSPACE_DIR temp dirs, a fake bridge on 127.0.0.1.
 *
 * Run: node --test api/test/agent-bridge-hysteresis.test.mjs
 * ------------------------------------------------------------------ */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.AGENT_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-bridge-hysteresis-local-'))
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-bridge-hysteresis-ws-')) // not a git repo
// The fake bridge below must be the ONLY bridge. Left unset, the registry falls
// through to an operator-local api/src/bridges.json — absent on a CI runner, but
// on a configured box it would add a real bridge that these tests then poll over
// the network, mixing live sessions into every assertion. '[]' pins the world.
process.env.AGENT_BRIDGES = '[]'

const { agentRouter, __resetBridgeCacheForTests } = await import('../src/agent-routes.mjs')

const FAKE_TOKEN = 'test-bridge-token'
const FAKE_SESSION = {
  id: 'remote-1',
  repo: 'demo-app',
  task: 'do the thing',
  status: 'running',
  startedAt: '2026-07-25T00:00:00.000Z',
}

// Mutable so each test can flip the fake bridge between healthy and failing
// without restarting the server.
let bridgeUp = true
let fakeBridge, fakeBridgeUrl

function startFakeBridge() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, service: 'agent-bridge', sha: 'abc1234' }))
      }
      const auth = req.headers['authorization'] || ''
      if (auth !== `Bearer ${FAKE_TOKEN}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
      }
      if (req.method === 'GET' && req.url === '/sessions') {
        if (!bridgeUp) {
          res.writeHead(500, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ ok: false, error: 'simulated bridge failure' }))
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ generated: new Date().toISOString(), sessions: [FAKE_SESSION] }))
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

function makeApp() {
  const bearerAuth = (_req, _res, next) => next()
  const app = express()
  app.use(agentRouter(bearerAuth))
  return app
}

async function getAgents(server) {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/agents`)
  return res.json()
}

before(async () => {
  fakeBridge = await startFakeBridge()
  fakeBridgeUrl = `http://127.0.0.1:${fakeBridge.address().port}`
  process.env.AGENT_BRIDGE_URL = fakeBridgeUrl
  process.env.AGENT_BRIDGE_TOKEN = FAKE_TOKEN
})

after(() => {
  fakeBridge.close()
})

beforeEach(() => {
  bridgeUp = true
  __resetBridgeCacheForTests()
  delete process.env.AGENT_BRIDGE_STALE_FAILURES
  delete process.env.AGENT_BRIDGE_STALE_MAX_MS
})

test('a single failed poll keeps serving the last-known-good sessions, marked stale, reachable still true', async () => {
  const server = makeApp().listen(0)
  try {
    const first = await getAgents(server)
    assert.equal(first.workstationReachable, true)
    assert.deepEqual(
      first.sessions.map((s) => s.id),
      ['remote-1'],
    )
    assert.equal(first.bridges[0].stale, undefined, 'a fresh successful poll must not carry a stale marker')

    bridgeUp = false
    const second = await getAgents(server)
    assert.equal(second.workstationReachable, true, 'one failed poll must not flip reachable false')
    assert.deepEqual(
      second.sessions.map((s) => s.id),
      ['remote-1'],
      'one failed poll must not drop the cached session',
    )
    assert.equal(second.bridges[0].reachable, true)
    assert.equal(second.bridges[0].stale, true, 'the served sessions came from cache, not a fresh poll')

    bridgeUp = true
    const third = await getAgents(server)
    assert.equal(third.workstationReachable, true)
    assert.equal(third.bridges[0].stale, undefined, 'a recovered poll must clear the stale marker')
  } finally {
    server.close()
  }
})

test('consecutive failures beyond AGENT_BRIDGE_STALE_FAILURES flip reachable false and drop sessions', async () => {
  process.env.AGENT_BRIDGE_STALE_FAILURES = '1'
  process.env.AGENT_BRIDGE_STALE_MAX_MS = '600000' // isolate the failure-count path from the age path
  const server = makeApp().listen(0)
  try {
    await getAgents(server) // seed the cache with one healthy poll
    bridgeUp = false
    const afterOne = await getAgents(server)
    assert.equal(afterOne.workstationReachable, true, 'failure #1 stays within budget (<= 1)')

    const afterTwo = await getAgents(server)
    assert.equal(afterTwo.workstationReachable, false, 'failure #2 exceeds AGENT_BRIDGE_STALE_FAILURES=1')
    assert.deepEqual(afterTwo.sessions.map((s) => s.id), [])
    assert.equal(afterTwo.bridges[0].reachable, false)
    assert.equal(afterTwo.bridges[0].stale, undefined, 'a hard-down bridge is not "stale", it is just unreachable')
  } finally {
    server.close()
  }
})

test('staleness age beyond AGENT_BRIDGE_STALE_MAX_MS flips reachable false even with few failures', async () => {
  process.env.AGENT_BRIDGE_STALE_FAILURES = '100' // isolate the age path from the failure-count path
  process.env.AGENT_BRIDGE_STALE_MAX_MS = '50'
  const server = makeApp().listen(0)
  try {
    await getAgents(server) // seed the cache with one healthy poll
    bridgeUp = false
    await new Promise((r) => setTimeout(r, 80)) // outlive the 50ms staleness budget
    const stale = await getAgents(server)
    assert.equal(stale.workstationReachable, false, 'the cache outlived AGENT_BRIDGE_STALE_MAX_MS')
    assert.deepEqual(stale.sessions.map((s) => s.id), [])
  } finally {
    server.close()
  }
})

test('no prior successful poll (nothing cached yet) fails reachable immediately, no crash', async () => {
  process.env.AGENT_BRIDGE_STALE_FAILURES = '100'
  process.env.AGENT_BRIDGE_STALE_MAX_MS = '600000'
  bridgeUp = false
  const server = makeApp().listen(0)
  try {
    const res = await getAgents(server)
    assert.equal(res.workstationReachable, false)
    assert.deepEqual(res.sessions.map((s) => s.id), [])
  } finally {
    server.close()
  }
})
