/* ------------------------------------------------------------------ *
 * UNREACHABLE IS NOT EMPTY — the two cases must not render the same.
 *
 * The failure this pins, seen twice with the operator watching: a bridge box's
 * load climbed into three figures, its /sessions stopped answering inside the
 * timeout, and every surface — the agent cards, the graph, and an Atlas
 * orchestrator reading list_agents — drew "no agents". All of its sessions were
 * alive inside the dev-host container the whole time. A missing REPORT was
 * rendered as a missing THING.
 *
 * So the contrast is what is pinned here, end to end through GET /api/agents:
 *   • a bridge that ANSWERS with zero sessions → a genuine, unremarkable "no
 *     agents": reachable, and NOTHING extra on the payload (no lastSeen, no
 *     staleSessions) so the healthy case is byte-identical to before.
 *   • a bridge that CANNOT ANSWER → reachable:false PLUS `lastSeen` and the
 *     roster it last answered with, kept strictly OUT of `sessions` so nothing
 *     can count a stale agent as live.
 * …and that the second survives an API restart, since the box restarts far more
 * often than a bridge outage lasts.
 *
 * Run: node --test api/test/bridge-unreachable-roster.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-unreachable-'))
process.env.AGENT_LOCAL_DIR = DIR
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.AGENT_LOCAL_DRIVE = '0'
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-unreachable-ws-')) // not a git repo
// The fake bridge below must be the ONLY bridge (see agent-bridge-hysteresis).
process.env.AGENT_BRIDGES = '[]'
process.env.AGENT_WORKSTATION_LABEL = 'lab-box'
// Keep the independent remote-phase timer out of these tests: it polls the same
// bridges and would refresh the roster underneath the assertions.
process.env.AGENT_REMOTE_PHASE_POLL_MS = String(60 * 60 * 1000)
// One failed poll is enough to flip unreachable — the hysteresis itself is
// covered by agent-bridge-hysteresis.test.mjs; here it is just in the way.
process.env.AGENT_BRIDGE_STALE_FAILURES = '0'

// --- The restart. A roster written by a PREVIOUS process, on disk before
// anything imports the module — exactly what a deploy or a watchdog bounce
// leaves behind.
const SEEN_AT = Date.parse('2026-08-06T09:12:00.000Z')
const SEEDED = [
  { id: 'lab-1', kind: 'dev', repo: 'demo-app', status: 'running', task: 'the 3d viewer', startedAt: '2026-08-06T08:00:00.000Z' },
  { id: 'lab-2', kind: 'dev', repo: 'demo-app', status: 'idle', task: 'migration head assert', startedAt: '2026-08-06T08:30:00.000Z' },
]
fs.writeFileSync(path.join(DIR, 'bridge-roster.json'), JSON.stringify({ 'lab-box': { at: SEEN_AT, sessions: SEEDED } }))
// lab-1 is a child of the orchestrator that will read list_agents below.
fs.writeFileSync(path.join(DIR, 'spawn-parents.json'), JSON.stringify({ 'lab-1': 'orch-a' }))

const { agentRouter, __resetBridgeCacheForTests } = await import('../src/agent-routes.mjs')

const FAKE_TOKEN = 'test-bridge-token'
const LIVE_SESSION = {
  id: 'lab-3',
  repo: 'demo-app',
  task: 'the one it is actually running',
  status: 'running',
  startedAt: '2026-08-06T10:00:00.000Z',
}
let bridgeSessions = [] // what the fake bridge answers /sessions with
const DEAD_URL = 'http://127.0.0.1:1' // nothing listens — a bridge that cannot answer at all

const fakeBridge = await new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/sessions') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ generated: new Date().toISOString(), sessions: bridgeSessions }))
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'not found' }))
  })
  s.listen(0, '127.0.0.1', () => resolve(s))
})
const LIVE_URL = `http://127.0.0.1:${fakeBridge.address().port}`
process.env.AGENT_BRIDGE_TOKEN = FAKE_TOKEN

const app = express()
app.use(express.json())
app.use(agentRouter((_req, _res, next) => next()))
const api = await new Promise((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s))
})
const base = `http://127.0.0.1:${api.address().port}`

test.after(() => {
  fakeBridge.close()
  api.close()
})

async function agents(url) {
  process.env.AGENT_BRIDGE_URL = url
  __resetBridgeCacheForTests() // no cached poll — each test starts from cold
  const r = await fetch(`${base}/api/agents`)
  return r.json()
}

test('a bridge that CANNOT ANSWER carries its last-known roster — across a restart', async () => {
  const v = await agents(DEAD_URL)
  const b = v.bridges[0]
  assert.equal(b.label, 'lab-box')
  assert.equal(b.reachable, false)
  assert.equal(b.lastSeen, new Date(SEEN_AT).toISOString(), 'the roster a PREVIOUS process wrote is what makes this answerable')
  assert.deepEqual(
    b.staleSessions.map((s) => [s.id, s.status]),
    [
      ['lab-1', 'running'],
      ['lab-2', 'idle'],
    ],
  )
  assert.deepEqual(v.sessions, [], 'stale sessions must NEVER be merged into the live roster')
  assert.equal(v.workstationReachable, false)
  assert.equal(b.staleSessions[0].spawnedBy, 'orch-a', 'lineage rides along so an orchestrator can see its own children')
  assert.equal(b.staleSessions[1].spawnedBy, undefined)
})

test('a bridge that ANSWERS with zero sessions is a genuine "no agents" — nothing extra on the payload', async () => {
  bridgeSessions = []
  const v = await agents(LIVE_URL)
  const b = v.bridges[0]
  assert.equal(b.reachable, true)
  assert.deepEqual(v.sessions, [])
  assert.equal(b.lastSeen, undefined, 'a healthy bridge must not carry a staleness story')
  assert.equal(b.staleSessions, undefined)
  assert.equal(b.stale, undefined)
})

test('a bridge that answered, then went silent, reports what it was running and when', async () => {
  bridgeSessions = [LIVE_SESSION]
  const up = await agents(LIVE_URL)
  assert.deepEqual(up.sessions.map((s) => s.id), ['lab-3'])
  assert.equal(up.bridges[0].lastSeen, undefined)

  const t0 = Date.now()
  const down = await agents(DEAD_URL)
  const b = down.bridges[0]
  assert.equal(b.reachable, false)
  assert.deepEqual(down.sessions, [], 'the box genuinely cannot see it any more — it is not live')
  assert.deepEqual(
    b.staleSessions.map((s) => [s.id, s.status, s.task]),
    [['lab-3', 'running', 'the one it is actually running']],
    'and it is not GONE either — this is the whole fix',
  )
  assert.ok(Date.parse(b.lastSeen) >= t0 - 60_000, 'a live poll refreshes lastSeen (it is not stuck on the seeded value)')
})

/* --- the orchestrator's copy ---------------------------------------- *
 * An Atlas chat reading the roster made exactly the operator's mistake and told
 * him his agents had been killed. tools.mjs reads ATLAS_API_BASE at import and
 * ATLAS_SESSION when the control tools register, so both are set against the
 * REAL route above — this is the payload an orchestrator actually sees. */
process.env.ATLAS_API_BASE = base
process.env.ATLAS_AGENT_CONTROL = '1'
process.env.ATLAS_SESSION = 'orch-a'
const { buildServer } = await import('../src/mcp/tools.mjs')

async function connect() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  await Promise.all([buildServer().connect(serverT), client.connect(clientT)])
  return client
}

test('list_agents carries the bridge silence — reachability, lastSeen, and whose children were silenced', async () => {
  bridgeSessions = SEEDED // lab-1 is this orchestrator's child (spawn-parents above)
  await agents(LIVE_URL) // observe them…
  await agents(DEAD_URL) // …then the bridge goes silent, here and for the MCP call that follows
  const client = await connect()
  const r = await client.callTool({ name: 'list_agents', arguments: {} })
  const payload = JSON.parse(r.content[0].text)
  const b = payload.bridges[0]
  assert.equal(b.label, 'lab-box')
  assert.equal(b.reachable, false)
  assert.ok(b.lastSeen, 'without a lastSeen the model has no way to say "since when"')
  assert.deepEqual(
    b.staleSessions.map((s) => [s.id, s.status, s.yours]),
    [
      ['lab-1', 'running', true],
      ['lab-2', 'idle', undefined],
    ],
  )
  assert.deepEqual(payload.sessions, [], 'still absent from sessions — the tool must not fake liveness either')
  await client.close()
})

test('list_agents SAYS SO in its description — a silent bridge is not a dead fleet', async () => {
  const client = await connect()
  const { tools } = await client.listTools()
  const d = tools.find((t) => t.name === 'list_agents').description
  assert.match(d, /does NOT mean it died|not mean it died/, 'the mistake this exists to prevent must be named')
  assert.match(d, /staleSessions/)
  assert.match(d, /lastSeen/)
  await client.close()
})

test('a reachable bridge tells the orchestrator nothing about staleness', async () => {
  bridgeSessions = [LIVE_SESSION]
  await agents(LIVE_URL)
  const client = await connect()
  const payload = JSON.parse((await client.callTool({ name: 'list_agents', arguments: {} })).content[0].text)
  assert.equal(payload.bridges[0].reachable, true)
  assert.equal(payload.bridges[0].lastSeen, undefined)
  assert.equal(payload.bridges[0].staleSessions, undefined)
  assert.deepEqual(payload.sessions.map((s) => s.id), ['lab-3'])
  await client.close()
})
