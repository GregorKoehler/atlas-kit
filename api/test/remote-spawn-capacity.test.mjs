/* ------------------------------------------------------------------ *
 * The remote spawn path, gated on the TARGET box's own memory.
 *
 * `atCapacity()` protected the dashboard box only, so `POST /spawn` to a bridge
 * was the last unbounded path onto someone else's machine: a small bridge box
 * running agents alongside CI and preview stacks saw its load climb into three
 * figures, fell off the network and started OOM-killing whatever else it ran —
 * and nothing would have refused the next agent. This pins the box's half of the
 * fix, end to end through POST /api/agents/spawn against a fake bridge, plus the
 * two things a capped fleet must never do quietly:
 *
 *  • a refusal SAYS WHY (the numbers, the bridge, what to do) — a spawn that
 *    silently does not happen is the same defect as a clipped prompt;
 *  • an un-upgraded bridge, which reports no capacity at all, still spawns —
 *    FAIL OPEN — but says so on the console, in the audit log, and in the
 *    capacity an orchestrator reads.
 *
 * Run: node --test api/test/remote-spawn-capacity.test.mjs
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

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))
const STATE_DIR = tmp('atlas-kit-cap-state-')
process.env.AGENT_LOCAL_DIR = STATE_DIR
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.AGENT_LOCAL_DRIVE = '0'
process.env.AGENT_LOCAL_REPOS = path.join(tmp('atlas-kit-cap-repos-'), 'none.json') // every repo routes to a bridge
process.env.WORKSPACE_DIR = tmp('atlas-kit-cap-ws-') // not a git repo
process.env.AGENT_BRIDGES = '[]' // the fake below is the only bridge
process.env.AGENT_WORKSTATION_LABEL = 'lab-box'
process.env.AGENT_BRIDGE_STALE_FAILURES = '0'
process.env.AGENT_REMOTE_PHASE_POLL_MS = String(60 * 60 * 1000)
// "No Atlas is configured" must be a FACT THIS TEST SETS: a spawn that passes
// the gate goes on to retrieve Atlas evidence, and on a configured box that
// would read the operator's real vault. Both the registry and the single-vault
// fallback are pointed at nothing (must precede the import — vaults.mjs reads
// VAULTS_FILE at module load).
process.env.VAULTS_FILE = path.join(tmp('atlas-kit-cap-reg-'), 'no-vaults.json')
process.env.VAULT_PATH = path.join(os.tmpdir(), 'atlas-kit-cap-no-such-vault')
// A successful spawn fires generateTitle(), a fire-and-forget `claude -p`. Both
// lines below keep that from becoming a real model call that holds the test
// process open: an empty PATH, AND an unresolvable CLAUDE_BIN — the resolver
// (src/claude-bin.mjs) deliberately falls back to ~/.local/bin and
// /usr/local/bin when PATH misses, so on a box with the CLI installed an empty
// PATH alone would no longer be hermetic. CLAUDE_BIN is authoritative, so this
// makes the refusal a fact this test sets rather than one it inherits.
process.env.PATH = tmp('atlas-kit-cap-nopath-')
process.env.CLAUDE_BIN = path.join(tmp('atlas-kit-cap-noclaude-'), 'claude')

const { agentRouter, __resetBridgeCacheForTests, remoteCapacity } = await import('../src/agent-routes.mjs')

const FAKE_TOKEN = 'test-bridge-token'
const REPO = 'demo-app'
const LIMITS = { maxAgents: 8, floorMb: 1200, perAgentMb: 500, chargeSwap: true }
// What the bridge answers /health with. `null` = a bridge from before this
// shipped: a valid /health, no capacity key at all.
const roomy = { live: 2, availMb: 6000, swapUsedMb: 200, swapTotalMb: 4096, ...LIMITS }
const drowning = { live: 7, availMb: 4021, swapUsedMb: 3512, swapTotalMb: 4096, ...LIMITS }
const atCeiling = { live: 8, availMb: 6000, swapUsedMb: 0, swapTotalMb: 4096, ...LIMITS }
let capacity = roomy
let spawnCalls = 0
let bridgeSessions = []

const fakeBridge = await new Promise((resolve) => {
  const s = http.createServer((req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method === 'GET' && req.url === '/health')
      return json(200, { ok: true, service: 'agent-bridge', sha: 'abc1234', features: ['prompt-file'], ...(capacity ? { capacity } : {}) })
    if ((req.headers['authorization'] || '') !== `Bearer ${FAKE_TOKEN}`) return json(401, { ok: false, error: 'unauthorized' })
    if (req.method === 'GET' && req.url === '/sessions')
      return json(200, { generated: new Date().toISOString(), sessions: bridgeSessions })
    if (req.method === 'POST' && req.url === '/spawn') {
      spawnCalls++
      let raw = ''
      req.on('data', (d) => (raw += d))
      return req.on('end', () => json(200, { ok: true, id: 'lab-agent' }))
    }
    json(404, { ok: false, error: 'not found' })
  })
  s.listen(0, '127.0.0.1', () => resolve(s))
})
process.env.AGENT_BRIDGE_URL = `http://127.0.0.1:${fakeBridge.address().port}`
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

async function spawn(task = 'cap the remote spawn path') {
  spawnCalls = 0
  const r = await fetch(`${base}/api/agents/spawn`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task, repo: REPO }),
  })
  return { status: r.status, body: await r.json(), spawnCalls }
}
const auditLines = () =>
  fs.readFileSync(path.join(STATE_DIR, 'audit.log'), 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const lastSpawnAudit = () => auditLines().findLast((l) => l.action === 'spawn')
async function agents() {
  __resetBridgeCacheForTests()
  return (await fetch(`${base}/api/agents`)).json()
}

/* --- 1. the gate ----------------------------------------------------- */

test('a bridge box with room spawns exactly as before', async () => {
  capacity = roomy
  const r = await spawn()
  assert.equal(r.status, 200)
  assert.equal(r.body.id, 'lab-agent')
  assert.equal(r.spawnCalls, 1)
  const line = lastSpawnAudit()
  assert.equal(line.ok, true)
  assert.deepEqual(line.capacity, { live: 2, maxAgents: 8, effectiveMb: 5800, slots: 6 })
})

test('a drowning bridge box REFUSES the spawn, and the bridge is never even called', async () => {
  capacity = drowning
  const r = await spawn()
  assert.equal(r.status, 503)
  assert.equal(r.body.ok, false)
  // The whole point: MemAvailable alone reads 4 GB free on this box.
  assert.match(r.body.error, /lab-box is too low on memory/)
  assert.match(r.body.error, /MemAvailable 4021 MB − 3512 MB already in swap = 509 MB effective/)
  assert.match(r.body.error, /needs 1700 MB/)
  assert.match(r.body.error, /7 session\(s\) are already live/)
  assert.equal(r.body.capacity.slots, 0)
  assert.equal(r.spawnCalls, 0, 'refuse BEFORE the bridge does any work — and before the Atlas retrieval')
  const line = lastSpawnAudit()
  assert.equal(line.ok, false)
  assert.equal(line.remote, true)
  assert.equal(line.bridge, 'lab-box')
  assert.equal(line.capacity.reason, 'memory')
})

test('a bridge box at its agent ceiling refuses too, and says which limit it hit', async () => {
  capacity = atCeiling
  const r = await spawn()
  assert.equal(r.status, 503)
  assert.match(r.body.error, /at its agent ceiling: 8\/8 sessions live/)
  assert.equal(r.spawnCalls, 0)
})

test('the operator can pin a lower ceiling per bridge, and it binds over what the bridge reports', async () => {
  capacity = { ...roomy, live: 4 } // the bridge itself would allow 4 more
  process.env.AGENT_BRIDGE_MAX_AGENTS = '4'
  try {
    const r = await spawn()
    assert.equal(r.status, 503)
    assert.match(r.body.error, /at its agent ceiling: 4\/4 sessions live/)
    assert.equal(r.spawnCalls, 0)
  } finally {
    delete process.env.AGENT_BRIDGE_MAX_AGENTS
  }
})

/* --- 2. the in-between state: bridge code lands one machine at a time -- */

test('a bridge that reports no capacity STILL SPAWNS — fail open — and the hole is audited, not silent', async () => {
  capacity = null // a /health from before this shipped
  const r = await spawn()
  assert.equal(r.status, 200, 'failing closed would make every un-redeployed bridge unspawnable the moment the box deploys')
  assert.equal(r.spawnCalls, 1)
  assert.equal(lastSpawnAudit().capacity, 'unreported', '"we did not check" must be answerable from the log afterwards')
})

test('a half-filled capacity reading is an UNREADABLE one, not a permissive one', () => {
  const half = { capacity: { live: 3, availMb: 6000 } } // no limits → no rule
  const c = remoteCapacity(null, half)
  assert.equal(c.known, false)
  assert.match(c.reason, /predates spawn-capacity reporting/)
  // …and a bridge that did not answer /health at all is its own reason.
  assert.match(remoteCapacity(null, null).reason, /did not answer \/health/)
})

/* --- 3. the limit is visible BEFORE it is hit ------------------------- */

test('GET /api/agents carries each bridge\'s remaining capacity', async () => {
  capacity = { ...roomy, live: 6 }
  const v = await agents()
  const b = v.bridges[0]
  assert.equal(b.label, 'lab-box')
  assert.equal(b.capacity.known, true)
  assert.equal(b.capacity.slots, 2)
  assert.equal(b.capacity.live, 6)
  assert.equal(b.capacity.ok, true)

  capacity = null
  const old = (await agents()).bridges[0]
  assert.equal(old.capacity.known, false)
  assert.match(old.capacity.reason, /restart-agent-bridge\.sh/, 'the remedy, not just the gap')
})

process.env.ATLAS_API_BASE = base
process.env.ATLAS_AGENT_CONTROL = '1'
process.env.ATLAS_SESSION = 'orch-a'
const { buildServer } = await import('../src/mcp/tools.mjs')

test('list_agents shows an orchestrator the limit before it hits it', async () => {
  capacity = drowning
  await agents()
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  await Promise.all([buildServer().connect(serverT), client.connect(clientT)])
  const out = JSON.parse((await client.callTool({ name: 'list_agents', arguments: {} })).content[0].text)
  const b = out.bridges[0]
  assert.equal(b.label, 'lab-box')
  assert.equal(b.capacity.known, true)
  assert.equal(b.capacity.slots, 0, 'zero slots is a plan; a 503 mid-turn is a surprise')
  assert.equal(b.capacity.ok, false)
  const tools = await client.listTools()
  const desc = tools.tools.find((t) => t.name === 'list_agents').description
  assert.match(desc, /capacity\.slots/)
  assert.match(desc, /known === false/, 'an un-capped bridge must be legible as such, not look like a capped one')
  await client.close()
})
