/* ------------------------------------------------------------------ *
 * An Atlas chat may only tear down the agents IT spawned.
 *
 * The failure this exists to stop: on a bare "let's clean up", an orchestrator
 * runs cleanup_agent across the roster — which is FLEET-WIDE, so most of what it
 * reaches belongs to OTHER Atlas chats. Nothing needs to be unmerged for that to
 * hurt: the owning chats lose their worktrees without ever being told. Three
 * things have to be true at once to prevent it, and each is pinned here:
 *   1. OWNERSHIP IS VISIBLE — `list_agents` exposes `spawnedBy` (+ `yours` for
 *      the caller's own), so ship state is no longer the only gate available.
 *   2. THE CALLER IS NAMED — kill_agent/cleanup_agent stamp `by`, like every
 *      other control tool already did (spawn's parent, steers' steeredBy).
 *   3. THE SERVER ENFORCES IT — /api/agents/{kill,cleanup} refuse another
 *      chat's child, NAME the owning chat, and tear down nothing.
 *
 * ⚠️ The most important test in here is the LAST one of each route matrix: the
 * dashboard's ✕/⌦ buttons send no `by`, and that is the OPERATOR acting
 * directly. Absent caller identity MUST stay allowed — this scoping binds
 * agents, never the operator. Breaking the ⌦ button would be a bad way to find
 * out.
 *
 * No tmux is driven on any ALLOWED path: teardowns that pass the gate target ids
 * that are not live local sessions, so the route falls through to a (deliberately
 * unreachable) bridge — a non-403 answer is exactly the proof that the gate let
 * it past. The REFUSED paths do use seeded local sessions, because "nothing was
 * torn down" is only meaningful against a session that existed.
 *
 * Run: node --test api/test/agent-teardown-scope.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-teardown-'))
process.env.AGENT_LOCAL_DIR = DIR
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.AGENT_LOCAL_DRIVE = '0'
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-teardown-ws-'))
process.env.WORKSPACE_DIR = WORKSPACE
// Pin the ambient facts rather than inheriting the box's: no box-local repos and
// no extra bridges, so the box never looks Atlas-capable (which would send an
// ALLOWED teardown down the graceful remote-close path instead of at the bridge).
const REPOS_FILE = path.join(DIR, 'repos.json')
fs.writeFileSync(REPOS_FILE, '{}')
process.env.AGENT_LOCAL_REPOS = REPOS_FILE
process.env.AGENT_BRIDGES = '[]'
// A bridge that is never up: an allowed teardown of a non-local id fails fast
// there instead of hanging, and 502 "bridge unreachable" is plainly not a 403.
process.env.AGENT_BRIDGE_URL = 'http://127.0.0.1:1'
process.env.AGENT_BRIDGE_TOKEN = 'x'.repeat(24)
// Keep the independent remote-phase timer away from these assertions.
process.env.AGENT_REMOTE_PHASE_POLL_MS = String(60 * 60 * 1000)

// Lineage: orch-a spawned mine-* ; orch-b spawned theirs-* ; loner-* have no
// spawn-parents entry at all (the operator started them from the dashboard).
const session = (id) => ({
  id,
  kind: 'dev',
  repo: 'demo-app',
  path: WORKSPACE,
  worktree: path.join(WORKSPACE, id),
  branch: `agent/${id}`,
  tmux: `agentbox-${id}`,
  status: 'running',
  startedAt: '2026-07-30T10:00:00Z',
})
fs.writeFileSync(
  path.join(DIR, 'state.json'),
  JSON.stringify({
    sessions: Object.fromEntries(
      ['mine-kill', 'mine-cleanup', 'theirs-kill', 'theirs-cleanup', 'loner-kill', 'loner-cleanup'].map((id) => [id, session(id)]),
    ),
  }),
)
fs.writeFileSync(
  path.join(DIR, 'spawn-parents.json'),
  JSON.stringify({
    'mine-kill': 'orch-a',
    'mine-cleanup': 'orch-a',
    'mine-remote': 'orch-a',
    'theirs-kill': 'orch-b',
    'theirs-cleanup': 'orch-b',
    'theirs-remote': 'orch-b',
  }),
)

const { agentRouter, ownsChild, messageAllowed } = await import('../src/agent-routes.mjs')
const local = await import('../src/agent-local.mjs')

const listen = (a) =>
  new Promise((resolve) => {
    const s = a.listen(0, '127.0.0.1', () => resolve(s))
  })

const app = express()
// kill/cleanup carry no router-level body parser (only the prompt-shaped routes
// do), so the body has to be parsed here — as the real server does.
app.use(express.json())
app.use(agentRouter((_req, _res, next) => next()))
const server = await listen(app)
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => server.close())

const post = (route, body) =>
  fetch(`${base}/api/agents/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

const scopeLines = () => {
  try {
    return fs
      .readFileSync(path.join(DIR, 'audit.log'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((l) => l.action === 'teardown-scope')
  } catch {
    return []
  }
}

/* --- 1. the predicate, pure ----------------------------------------- */

const parentOf = (id) => ({ child: 'orch-a', other: 'orch-b' })[id]

test('ownsChild: own child only — not a stranger, not an orphan', () => {
  assert.equal(ownsChild('orch-a', 'child', parentOf).ok, true)

  // Another chat's child: refused, and the error NAMES the owner — an agent that
  // only learns "not allowed" has nothing useful to tell the operator.
  const other = ownsChild('orch-a', 'other', parentOf)
  assert.equal(other.ok, false)
  assert.match(other.error, /orch-b/)
  assert.match(other.error, /scope:"any"/)

  // Unparented (dashboard-spawned): owned by nobody ⇒ the operator's.
  const orphan = ownsChild('orch-a', 'unknown-id', parentOf)
  assert.equal(orphan.ok, false)
  assert.match(orphan.error, /not spawned by any chat/)

  assert.equal(ownsChild('', 'child', parentOf).ok, false)
})

test('teardown is STRICTER than the message bus: a sibling may write but not reap', () => {
  const sibs = (_id) => 'orch-a' // both children share a parent
  assert.equal(messageAllowed('one', 'two', sibs).ok, true) // the bus allows it…
  assert.equal(ownsChild('one', 'two', sibs).ok, false) // …teardown does not
})

/* --- 2. the routes, per destructive verb ---------------------------- */

for (const [route, theirs, loner] of [
  ['kill', 'theirs-kill', 'loner-kill'],
  ['cleanup', 'theirs-cleanup', 'loner-cleanup'],
]) {
  test(`${route}: another chat's child is refused, names the owner, and tears down NOTHING`, async () => {
    const before = scopeLines().length
    const r = await post(route, { id: theirs, by: 'orch-a' })
    assert.equal(r.status, 403)
    assert.match((await r.json()).error, /orch-b/) // the owning chat, by name
    assert.equal(local.hasSession(theirs), true) // still there — nothing was reaped

    const line = scopeLines().slice(before)[0]
    assert.deepEqual(
      { action: line.action, via: line.via, id: line.id, by: line.by, owner: line.owner, ok: line.ok },
      { action: 'teardown-scope', via: route, id: theirs, by: 'orch-a', owner: 'orch-b', ok: false },
    )
  })

  test(`${route}: an unparented (dashboard-spawned) session is refused by default`, async () => {
    const r = await post(route, { id: loner, by: 'orch-a' })
    assert.equal(r.status, 403)
    assert.match((await r.json()).error, /not spawned by any chat/)
    assert.equal(local.hasSession(loner), true)
  })

  test(`${route}: the caller's OWN child proceeds`, async () => {
    const before = scopeLines().length
    const r = await post(route, { id: 'mine-remote', by: 'orch-a' })
    assert.notEqual(r.status, 403) // past the gate (then fails at the dead bridge)
    const line = scopeLines().slice(before)[0]
    assert.equal(line.ok, true)
    assert.equal(line.by, 'orch-a')
    assert.equal(line.scope, undefined)
  })

  test(`${route}: scope:"any" lifts the scope AND leaves an audit trail`, async () => {
    const before = scopeLines().length
    const r = await post(route, { id: 'theirs-remote', by: 'orch-a', scope: 'any' })
    assert.notEqual(r.status, 403)
    const line = scopeLines().slice(before)[0]
    assert.deepEqual(
      { id: line.id, by: line.by, owner: line.owner, scope: line.scope, ok: line.ok },
      { id: 'theirs-remote', by: 'orch-a', owner: 'orch-b', scope: 'any', ok: true },
    )
  })

  // ⚠️ THE DASHBOARD BUTTON. No `by` = the operator acting directly = allowed,
  // on anything, including an agent no chat owns. Never scope the operator.
  test(`${route}: the dashboard ⌦/✕ (no "by") is unaffected — operator, not agent`, async () => {
    const before = scopeLines().length
    const r = await post(route, { id: 'unowned-remote-id' })
    assert.notEqual(r.status, 403)
    assert.equal(scopeLines().length, before) // and nothing to audit: it's the operator
  })
}

/* --- 3. the MCP tools: ownership visible, caller named -------------- */

// A stand-in for the dashboard API, so the TOOL contract is asserted on its own:
// /api/agents returns a roster with mixed ownership, and the destructive routes
// just record the body the tool sent. (The routes' own behaviour is §2's job.)
const stub = { last: null, base: '' }
{
  const a = express()
  a.use(express.json())
  a.get('/api/agents', (_req, res) =>
    res.json({
      localRepos: ['demo-app'],
      bridges: [],
      sessions: [
        { id: 'mine', kind: 'dev', repo: 'demo-app', status: 'idle', spawnedBy: 'orch-a' },
        { id: 'theirs', kind: 'dev', repo: 'demo-app', status: 'idle', spawnedBy: 'orch-b' },
        { id: 'loner', kind: 'dev', repo: 'demo-app', status: 'idle' },
      ],
    }),
  )
  a.post(/^\/api\/agents\/(kill|cleanup)$/, (req, res) => {
    stub.last = { body: req.body }
    res.json({ ok: true })
  })
  const s = await listen(a)
  stub.base = `http://127.0.0.1:${s.address().port}`
  test.after(() => s.close())
}

// tools.mjs reads ATLAS_API_BASE at import time and ATLAS_SESSION when the
// agent-control tools register — so both must be set before buildServer().
process.env.ATLAS_API_BASE = stub.base
process.env.ATLAS_AGENT_CONTROL = '1'
process.env.ATLAS_SESSION = 'orch-a'
const { buildServer } = await import('../src/mcp/tools.mjs')

async function connect() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0' }, { capabilities: {} })
  await Promise.all([buildServer().connect(serverT), client.connect(clientT)])
  return client
}

test('list_agents exposes spawnedBy and marks the caller’s own sessions', async () => {
  const client = await connect()
  const r = await client.callTool({ name: 'list_agents', arguments: {} })
  const sessions = JSON.parse(r.content[0].text).sessions
  assert.deepEqual(
    sessions.map((s) => [s.id, s.spawnedBy, s.yours]),
    [
      ['mine', 'orch-a', true],
      ['theirs', 'orch-b', undefined],
      ['loner', undefined, undefined],
    ],
  )
  await client.close()
})

test('kill_agent and cleanup_agent name their caller (`by`) and pass the override through', async () => {
  const client = await connect()
  for (const name of ['kill_agent', 'cleanup_agent']) {
    await client.callTool({ name, arguments: { id: 'theirs' } })
    assert.deepEqual(stub.last.body, { id: 'theirs', by: 'orch-a' })
    await client.callTool({ name, arguments: { id: 'theirs', scope: 'any' } })
    assert.deepEqual(stub.last.body, { id: 'theirs', by: 'orch-a', scope: 'any' })
  }
  await client.close()
})
