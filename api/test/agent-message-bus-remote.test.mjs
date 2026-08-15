/* ------------------------------------------------------------------ *
 * Tests for the BRIDGE half of the agent↔agent message bus.
 *
 * The box half (auth, lineage, header-before-fingerprint, budget, bus log) is
 * covered in agent-message-bus.test.mjs. What matters here is that a remote
 * agent — one running in a container behind a bridge — goes through exactly the
 * same policy, in both directions:
 *
 *  1. RECEIVING — a message for a remote recipient rides the existing box→bridge
 *     /queue path, with the attribution header applied before the bridge ever
 *     sees the text (it fingerprints what it receives).
 *  2. SENDING — a container agent's send is relayed by its bridge and decided
 *     HERE: the sender is the id the box independently knows as a session on
 *     that bridge, never what the relay claims; lineage and the per-pair budget
 *     bind it identically; deliveries and rejections both hit the bus log; and
 *     the verdict goes back so the sending agent reads a real 403/429.
 *  3. A bridge that has NOT been restarted has no /outbox — it 404s, which must
 *     be a quiet no-op, not a crash or a retry storm.
 *
 * A fake bridge (plain node:http, like the real one) stands in for the
 * workstation; no docker, no tmux.
 *
 * Run: node --test api/test/agent-message-bus-remote.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-msgbus-remote-'))
process.env.AGENT_LOCAL_DIR = DIR
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.AGENT_LOCAL_DRIVE = '0'
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-msgbus-remote-ws-'))
// The remote poll would drain the fake bridge's outbox underneath the tests —
// park it far away and drive one drain cycle per test explicitly.
process.env.AGENT_REMOTE_PHASE_POLL_MS = String(60 * 60 * 1000)

const TOKEN_A = 'a'.repeat(48)
// Lineage: orch → { alpha (box-local), delta + epsilon (remote) }. zeta is a
// remote shadow owned by ANOTHER bridge; stranger has no lineage at all.
fs.writeFileSync(
  path.join(DIR, 'state.json'),
  JSON.stringify({
    sessions: {
      alpha: { id: 'alpha', kind: 'dev', repo: 'demo-app', tmux: 'agentbox-alpha', msgToken: TOKEN_A, status: 'running', startedAt: '2026-07-29T10:00:00Z' },
    },
  }),
)
fs.writeFileSync(
  path.join(DIR, 'spawn-parents.json'),
  JSON.stringify({ alpha: 'orch', delta: 'orch', epsilon: 'orch', zeta: 'orch' }),
)
// The remote shadows the box keeps per remote session (remote-timings.json) —
// what tells it an id is live on a given bridge. Normally seeded by the
// /sessions poll; written directly here so a drain needs no poll.
fs.writeFileSync(
  path.join(DIR, 'remote-timings.json'),
  JSON.stringify({
    delta: { id: 'delta', bridge: 'workstation', repo: 'my-app', kind: 'dev', task: 'a remote agent' },
    epsilon: { id: 'epsilon', bridge: 'workstation', repo: 'my-service', kind: 'dev', task: 'another remote agent' },
    zeta: { id: 'zeta', bridge: 'lab-box', repo: 'lab-app', kind: 'dev', task: 'on a different bridge' },
  }),
)

/* --- the fake bridge -------------------------------------------------- */
const seen = { queue: [], outboxCalls: 0, verdicts: [] }
let outboxPending = [] // what the bridge hands the box on the next drain
let outboxStatus = 200 // 404 = a bridge that predates this feature
let queueStatus = 200 // 409 = the real bridge's answer for a session that has died

const bridge = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    const reply = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (req.url === '/queue') {
      seen.queue.push(body)
      if (queueStatus !== 200) return reply(queueStatus, { ok: false, error: 'session not running' })
      return reply(200, { ok: true })
    }
    if (req.url === '/outbox') {
      seen.outboxCalls++
      if (outboxStatus === 404) return reply(404, { ok: false, error: 'not found' })
      if (Array.isArray(body.verdicts) && body.verdicts.length) seen.verdicts.push(...body.verdicts)
      const messages = outboxPending
      outboxPending = []
      return reply(200, { ok: true, messages })
    }
    return reply(404, { ok: false, error: 'not found' })
  })
})
await new Promise((r) => bridge.listen(0, '127.0.0.1', r))
process.env.AGENT_BRIDGE_URL = `http://127.0.0.1:${bridge.address().port}`
process.env.AGENT_BRIDGE_TOKEN = 'bridge-token'
test.after(() => bridge.close())

const { agentRouter, withHeader, __drainOutboxesForTests } = await import('../src/agent-routes.mjs')
const { steerKey, steerEntry, tagSteered } = await import('../src/agent-history.mjs')
const { noteSend, __resetForTests } = await import('../src/agent-messages.mjs')

const app = express()
app.use(agentRouter((_req, res) => res.status(401).json({ ok: false, error: 'unauthorized' })))
const server = app.listen(0)
const base = `http://127.0.0.1:${server.address().port}`
test.after(() => server.close())

const send = (token, body) =>
  fetch(`${base}/api/agents/message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

const busLog = () => {
  try {
    return fs
      .readFileSync(path.join(DIR, 'agent-messages.jsonl'), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

/* --- 1. receiving: a remote recipient -------------------------------- */

test('remote recipient: delivery goes over the existing box→bridge queue path', async () => {
  __resetForTests()
  const res = await send(TOKEN_A, { to: 'delta', text: 'the shared module moved' })
  assert.equal(res.status, 200)
  assert.equal((await res.json()).ok, true)
  const q = seen.queue.at(-1)
  assert.equal(q.id, 'delta')
  assert.equal(q.steeredBy, 'alpha', 'the sender rides along so the turn is attributable')
  assert.equal(q.source, 'agent', 'peer mail, not an Atlas steer — the chat-view colour')
  // …and the bus log has the join, delivered.
  const last = busLog().at(-1)
  assert.deepEqual({ from: last.from, to: last.to, delivered: last.delivered }, { from: 'alpha', to: 'delta', delivered: true })
})

test('remote recipient: the header is on the text the BRIDGE fingerprints', () => {
  const text = seen.queue.at(-1).text
  // Exactly what a box-local recipient would have received…
  assert.equal(text, withHeader({ id: 'alpha', kind: 'dev', repo: 'demo-app' }, 'the shared module moved'))
  // …and the bridge's recordSteer(text, source) tags the turn it produces.
  const msgs = [{ role: 'user', text }]
  tagSteered(msgs, new Set([steerEntry(steerKey(text), 'agent')]))
  assert.equal(msgs[0].source, 'agent')
})

test('remote recipient: lineage still bounds it', async () => {
  const before = busLog().length
  const res = await send(TOKEN_A, { to: 'zeta', text: 'hi' }) // zeta is orch's child too…
  assert.equal(res.status, 200, 'a sibling on another bridge is still a sibling')
  const res2 = await send(TOKEN_A, { to: 'stranger', text: 'hi' })
  assert.equal(res2.status, 403)
  assert.equal(busLog().length, before + 2)
  assert.equal(busLog().at(-1).reason, 'lineage')
})

test('remote recipient: a bridge that refuses the queue is a logged bounce, not a silent drop', async () => {
  queueStatus = 409 // what the real bridge answers for a session that has died
  const res = await send(TOKEN_A, { to: 'delta', text: 'hello?' })
  queueStatus = 200
  assert.equal(res.status, 409)
  assert.match((await res.json()).error, /not running/)
  assert.deepEqual({ delivered: busLog().at(-1).delivered, reason: busLog().at(-1).reason }, { delivered: false, reason: 'undeliverable' })
})

/* --- 2. sending: a container agent's relayed mail --------------------- */

test('remote sender: identity comes from the box’s own view of the bridge, not the relay', async () => {
  __resetForTests()
  const before = busLog().length
  outboxPending = [
    { seq: 1, from: 'nobody', to: 'alpha', text: 'let me in' },
    { seq: 2, from: 'zeta', to: 'alpha', text: 'wrong bridge' }, // a real id, but owned by lab-box
  ]
  seen.verdicts = []
  await __drainOutboxesForTests()
  assert.deepEqual(
    seen.verdicts.map((v) => [v.seq, v.status]),
    [
      [1, 401],
      [2, 401],
    ],
    'a bridge can only ever speak for its OWN sessions',
  )
  const log = busLog().slice(before)
  assert.equal(log.length, 2)
  assert.ok(log.every((l) => l.delivered === false && l.reason === 'unknown-sender'))
})

test('remote sender: a relayed message is delivered, headered and logged like any other', async () => {
  __resetForTests()
  outboxPending = [{ seq: 3, from: 'delta', to: 'epsilon', text: 'rebasing onto master now' }]
  seen.verdicts = []
  const queued = seen.queue.length
  await __drainOutboxesForTests()
  assert.deepEqual(seen.verdicts.map((v) => [v.seq, v.status, v.ok]), [[3, 200, true]])
  assert.equal(seen.queue.length, queued + 1)
  const q = seen.queue.at(-1)
  assert.equal(q.id, 'epsilon')
  assert.equal(q.steeredBy, 'delta')
  assert.equal(q.source, 'agent')
  // The sender's attribution is built from what the BOX knows about delta.
  assert.equal(q.text, withHeader({ id: 'delta', kind: 'dev', repo: 'my-app' }, 'rebasing onto master now'))
  const last = busLog().at(-1)
  assert.deepEqual({ from: last.from, to: last.to, delivered: last.delivered }, { from: 'delta', to: 'epsilon', delivered: true })
})

test('remote sender: lineage rejections come back as the verdict the agent reads', async () => {
  __resetForTests()
  outboxPending = [{ seq: 4, from: 'delta', to: 'orphan', text: 'psst' }]
  seen.verdicts = []
  await __drainOutboxesForTests()
  assert.equal(seen.verdicts[0].status, 403)
  assert.match(seen.verdicts[0].error, /lineage/)
  assert.deepEqual({ delivered: busLog().at(-1).delivered, reason: busLog().at(-1).reason }, { delivered: false, reason: 'lineage' })
})

test('remote sender: the per-pair budget binds it identically', async () => {
  __resetForTests()
  const max = Number(process.env.AGENT_MESSAGE_PAIR_MAX || 12)
  for (let i = 0; i < max; i++) noteSend('delta', 'epsilon')
  outboxPending = [{ seq: 5, from: 'delta', to: 'epsilon', text: 'one too many' }]
  seen.verdicts = []
  const queued = seen.queue.length
  await __drainOutboxesForTests()
  assert.equal(seen.verdicts[0].status, 429)
  assert.match(seen.verdicts[0].error, /budget/)
  assert.equal(seen.queue.length, queued, 'nothing was handed to the bridge')
  assert.deepEqual({ delivered: busLog().at(-1).delivered, reason: busLog().at(-1).reason }, { delivered: false, reason: 'budget' })
})

test('remote sender: a box-local recipient is reachable the other way too', async () => {
  __resetForTests()
  outboxPending = [{ seq: 6, from: 'delta', to: 'alpha', text: 'a finding for you' }]
  seen.verdicts = []
  await __drainOutboxesForTests()
  // alpha has no live tmux in this env, so delivery bounces — but it bounced at
  // the EXECUTOR, meaning sender resolution, lineage and budget all passed.
  assert.match(seen.verdicts[0].error, /not running/)
  assert.deepEqual({ from: busLog().at(-1).from, to: busLog().at(-1).to, reason: busLog().at(-1).reason }, { from: 'delta', to: 'alpha', reason: 'undeliverable' })
})

/* --- 3. a bridge that has not been restarted -------------------------- */

test('a bridge with no /outbox is a quiet no-op, and stops being asked', async () => {
  outboxStatus = 404
  const before = seen.outboxCalls
  await __drainOutboxesForTests() // must not throw
  assert.equal(seen.outboxCalls, before + 1)
  await __drainOutboxesForTests()
  await __drainOutboxesForTests()
  assert.equal(seen.outboxCalls, before + 1, 'backed off instead of asking every tick')
})

/* --- 4. the container half (source assertions) ------------------------ *
 * The bridge server can't be imported (it binds a port and exits without a
 * token), so assert the two things a silent regression would take out: the
 * wrapper is the SHARED source (not a drifting copy) and the scoped token
 * actually reaches the agent's launch env. */

test('the bridge writes the shared wrapper and launches with the scoped token', async () => {
  const src = fs.readFileSync(new URL('../../agent-bridge/server.mjs', import.meta.url), 'utf-8')
  assert.match(src, /import \{ MSG_WRAPPER_SRC \} from '\.\.\/api\/src\/agent-msg-wrapper\.mjs'/, 'one wrapper source, not a copy')
  assert.match(src, /await writeMsgWrapper\(container\)/)
  // The prompt travels by file (promptFileCommand), so the launch command is
  // built AROUND that — but msgEnv must still prefix the command the session
  // actually runs, or the token would be an unexported shell variable.
  assert.match(src, /promptFileCommand\(\s*msgEnv\(session\) \+\s*LAUNCH_CMD/)
  const { MSG_WRAPPER_SRC } = await import('../src/agent-msg-wrapper.mjs')
  assert.match(MSG_WRAPPER_SRC, /ATLAS_AGENT_TOKEN/)
  assert.match(MSG_WRAPPER_SRC, /\/api\/agents\/message/)
})
