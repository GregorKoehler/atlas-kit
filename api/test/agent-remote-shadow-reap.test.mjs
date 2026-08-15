/* ------------------------------------------------------------------ *
 * Tests for the remote phase-shadow reap grace window (trackRemotePhases in
 * agent-routes.mjs) — the source of the 2026-07-24/25 working-time spikes.
 *
 * The bridge answers GET /sessions with 200 and a list. When that list was
 * PARTIAL (a live session momentarily missing) the sweep read the absence as
 * "the agent was cleaned up": it recorded a lifetime and DELETED the shadow. The
 * next poll recreated the shadow from scratch, carrying the remote agent's
 * ORIGINAL spawn time, and trackPhase's first-observation branch re-anchored the
 * run there — so one ~2 h session billed ~9 h across five nested records, and one
 * remote session logged a single 221.8 h run. The live log shows the thrash
 * itself: ~1000 lifetime records for one session id.
 *
 * Guarded here:
 *  - one poll that omits a live session tears NOTHING down — no lifetime, no run
 *    record, no re-anchoring when it comes back.
 *  - a session genuinely gone past the grace window still gets its lifetime, and
 *    that record is stamped at the LAST OBSERVATION, so the grace window itself
 *    is never billed as agent time.
 *
 * Same sandbox convention as agent-bridge-hysteresis.test.mjs: temp
 * AGENT_LOCAL_DIR/WORKSPACE_DIR, AGENT_BRIDGES='[]' so the fake bridge is the
 * only one, and a tiny phase debounce so a run/wait flip commits without a wait.
 *
 * Run: node --test api/test/agent-remote-shadow-reap.test.mjs
 * ------------------------------------------------------------------ */
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-shadow-reap-local-'))
process.env.AGENT_LOCAL_DIR = stateDir
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-shadow-reap-ws-'))
process.env.AGENT_BRIDGES = '[]'
process.env.AGENT_PHASE_DEBOUNCE_MS = '1' // commit a run/wait flip on the next poll

const { agentRouter, __resetBridgeCacheForTests } = await import('../src/agent-routes.mjs')

const TIMINGS_LOG = path.join(stateDir, 'agent-timings.jsonl')
const FAKE_TOKEN = 'test-bridge-token'
const HOUR = 3600000
// Nine days old — a session that has been running since 2026-07-16, exactly the
// shape that produced the 221.8 h record.
const SPAWNED_AT = new Date(Date.now() - 9 * 24 * HOUR).toISOString()

// Mutable: what the fake bridge's /sessions returns on the next poll.
let served = []
let fakeBridge

function startFakeBridge() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, service: 'agent-bridge' }))
      }
      if ((req.headers['authorization'] || '') !== `Bearer ${FAKE_TOKEN}`) {
        res.writeHead(401, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
      }
      if (req.method === 'GET' && req.url === '/sessions') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ generated: new Date().toISOString(), sessions: served }))
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'not found' }))
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

const session = (id, status) => ({ id, repo: 'my-app', task: 'do the thing', status, startedAt: SPAWNED_AT })

function records() {
  if (!fs.existsSync(TIMINGS_LOG)) return []
  return fs.readFileSync(TIMINGS_LOG, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
const recordsFor = (id, type) => records().filter((r) => r.id === id && r.type === type)

function makeApp() {
  const app = express()
  app.use(agentRouter((_req, _res, next) => next()))
  return app
}

before(async () => {
  fakeBridge = await startFakeBridge()
  process.env.AGENT_BRIDGE_URL = `http://127.0.0.1:${fakeBridge.address().port}`
  process.env.AGENT_BRIDGE_TOKEN = FAKE_TOKEN
})
after(() => fakeBridge.close())
beforeEach(() => {
  __resetBridgeCacheForTests()
  delete process.env.AGENT_REMOTE_REAP_GRACE_MS
})

test('a single poll that omits a live session neither closes it nor re-anchors its run', async () => {
  const id = 'flaky-poll-survivor'
  const server = makeApp().listen(0)
  const poll = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/agents`)).json()
  try {
    served = [session(id, 'running')] // observed running → run opens, anchored at now
    await poll()
    served = [] // the partial response that used to destroy the shadow
    await poll()
    assert.deepEqual(recordsFor(id, 'lifetime'), [], 'one missing poll must not end the agent')
    assert.deepEqual(recordsFor(id, 'run'), [], 'nor close its open run')

    served = [session(id, 'running')] // back, same session
    const back = await poll()
    assert.equal(back.sessions.find((s) => s.id === id).phase, 'run', 'it is still in the same run phase')

    // Let that run finish: two idle polls (debounce armed, then committed).
    served = [session(id, 'idle')]
    await poll()
    await poll()
    const runs = recordsFor(id, 'run')
    assert.equal(runs.length, 1, 'exactly one run record for one busy period')
    assert.ok(runs[0].actualMs < HOUR, `the run is the observed seconds, not the 9-day session age (got ${runs[0].actualMs}ms)`)
    assert.equal(runs[0].clamped, undefined, 'a correctly anchored run never needs the clamp')
  } finally {
    served = []
    server.close()
  }
})

test('a session absent past the grace window still gets its lifetime, stamped at the last observation', async () => {
  process.env.AGENT_REMOTE_REAP_GRACE_MS = '50'
  const id = 'genuinely-finished'
  const server = makeApp().listen(0)
  const poll = async () => (await fetch(`http://127.0.0.1:${server.address().port}/api/agents`)).json()
  try {
    served = [session(id, 'idle')]
    await poll()
    const lastSeen = Date.now()
    await new Promise((r) => setTimeout(r, 80)) // outlive the 50ms grace
    served = []
    await poll()
    const [lt] = recordsFor(id, 'lifetime')
    assert.ok(lt, 'a genuinely gone session must still be recorded')
    assert.ok(
      Date.parse(lt.endedAt) <= lastSeen + 20,
      'the lifetime is stamped at the last observation, so the grace window is not billed',
    )
    assert.deepEqual(recordsFor(id, 'run'), [], 'an idle session contributes no run record')
  } finally {
    served = []
    server.close()
  }
})
