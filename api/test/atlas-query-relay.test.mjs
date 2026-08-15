/* ------------------------------------------------------------------ *
 * Atlas queries for REMOTE (bridge) dev agents, over the relay that already
 * exists — the box half (api/src/atlas-query-relay.mjs) plus the two ends a
 * silent regression would take out.
 *
 * Exposing the HTTP MCP server was deliberately NOT the answer here, so this
 * feature's whole defensibility rests on four properties, none of them visible
 * in a diff once the files drift:
 *   1. the reachable surface is EXACTLY the seven knowledge-only READ tools —
 *      a write / propose / agent-control tool name is refused and never even
 *      reaches the API,
 *   2. it is BOUNDED — per-session query budget and a hard cap on the answer
 *      (which travels back through the relay), both readable by the agent,
 *   3. every query AND every rejection is LOGGED (the operator's record of what
 *      left the box),
 *   4. identity comes from the box's own view of the bridge's sessions, never
 *      from anything the agent typed — and an un-restarted bridge degrades to
 *      "the command isn't there", not a crash or a silent empty result.
 *
 * A fake read API stands in for the dashboard's own read routes (the tool
 * handlers' target) and a fake bridge for the workstation; no docker, no tmux,
 * no MCP subprocess — the query surface is built in-process, which is how it
 * runs in production too.
 *
 * Run: node --test api/test/atlas-query-relay.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-atlas-query-'))
process.env.AGENT_LOCAL_DIR = DIR
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.AGENT_LOCAL_DRIVE = '0'
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-atlas-query-ws-'))
// The remote poll would drain the fake bridge underneath the tests — park it far
// away and drive one drain cycle per test explicitly.
process.env.AGENT_REMOTE_PHASE_POLL_MS = String(60 * 60 * 1000)
// Small bounds so the budget and the response cap are exercised cheaply.
process.env.ATLAS_QUERY_MAX = '3'
process.env.ATLAS_QUERY_RESULT_MAX = '400'
// Deliberately ON: `propose_task` is the one write the dev/worker MCP configs do
// enable (ATLAS_MCP_PROPOSE), so it is registered on a knowledgeOnly server. The
// relay's allowlist is KNOWLEDGE_TOOLS — not "whatever happens to be registered"
// — and the refusal test below proves the flag cannot widen the relay's surface.
process.env.ATLAS_MCP_PROPOSE = '1'

// A two-vault registry, so the "an unqualified query reads the ATLAS" default is
// a real choice rather than the only option.
const VAULTS_FILE = path.join(DIR, 'vaults.json')
fs.writeFileSync(
  VAULTS_FILE,
  JSON.stringify({ work: { path: '/vault', label: 'Work', default: true }, atlas: { path: '/vault-atlas', label: 'Atlas' } }),
)
process.env.VAULTS_FILE = VAULTS_FILE

// delta is a live session on the workstation bridge; zeta belongs to another one.
fs.writeFileSync(
  path.join(DIR, 'remote-timings.json'),
  JSON.stringify({
    delta: { id: 'delta', bridge: 'workstation', repo: 'my-app', kind: 'dev', task: 'a remote agent' },
    zeta: { id: 'zeta', bridge: 'lab-box', repo: 'lab-app', kind: 'dev', task: 'on a different bridge' },
  }),
)

/* --- the fake read API (what the MCP tool handlers call) --------------- */
const hits = []
const readApi = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const url = new URL(req.url, 'http://api')
    hits.push({ method: req.method, path: url.pathname, vault: url.searchParams.get('vault'), search: url.search, body: raw })
    const json = (o) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(o))
    }
    const text = (s) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(s)
    }
    if (url.pathname === '/api/search')
      return json({ items: url.searchParams.get('q') === 'huge' ? Array.from({ length: 200 }, (_, i) => ({ path: `Wiki/p${i}.md`, snippet: 'x'.repeat(40) })) : [{ path: 'Wiki/Projects/My Project.md', snippet: 'a hit' }] })
    if (url.pathname === '/api/atlas/query') return json({ items: [{ title: 'ship the relay', status: 'next' }] })
    if (url.pathname === '/api/note') return text('# My Project\n\nnotes')
    if (url.pathname === '/api/wiki/log') return text('## [2026-07-29] ingest | something')
    if (url.pathname === '/api/wiki/index') return text('- [[My Project]]')
    if (url.pathname === '/api/wiki/pages') return json({ items: [{ title: 'My Project', path: 'Wiki/Projects/My Project.md' }] })
    if (url.pathname === '/api/wiki/graph') return json({ nodes: [], links: [] })
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
})
await new Promise((r) => readApi.listen(0, '127.0.0.1', r))
process.env.ATLAS_API_BASE = `http://127.0.0.1:${readApi.address().port}`
test.after(() => readApi.close())

/* --- the fake bridge -------------------------------------------------- */
const seen = { outboxCalls: 0, verdicts: [] }
let outboxPending = []
let outboxStatus = 200
const bridge = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    const reply = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (req.url === '/outbox') {
      seen.outboxCalls++
      if (outboxStatus === 404) return reply(404, { ok: false, error: 'not found' })
      if (Array.isArray(body.verdicts) && body.verdicts.length) seen.verdicts.push(...body.verdicts)
      const messages = outboxPending
      outboxPending = []
      return reply(200, { ok: true, messages })
    }
    if (req.url === '/queue') return reply(200, { ok: true })
    return reply(404, { ok: false, error: 'not found' })
  })
})
await new Promise((r) => bridge.listen(0, '127.0.0.1', r))
process.env.AGENT_BRIDGE_URL = `http://127.0.0.1:${bridge.address().port}`
process.env.AGENT_BRIDGE_TOKEN = 'bridge-token'
test.after(() => bridge.close())

const { runAtlasQuery, readQueries, __resetForTests } = await import('../src/atlas-query-relay.mjs')
const { __drainOutboxesForTests, ATLAS_REMOTE_SEARCH_PREAMBLE } = await import('../src/agent-routes.mjs')
const { ATLAS_QUERY_WRAPPER_SRC } = await import('../src/atlas-query-wrapper.mjs')

const READ_TOOLS = ['query_atlas', 'query_vault', 'get_note', 'wiki_index', 'wiki_pages', 'wiki_graph', 'recent_activity']
const query = (over = {}) => runAtlasQuery({ from: 'delta', bridge: 'workstation', tool: 'query_vault', args: { query: 'tunnel' }, ...over })
const fresh = () => {
  __resetForTests()
  hits.length = 0
}

/* --- 1. the reachable surface ----------------------------------------- */

test('all seven knowledge READ tools answer, each off the route it wraps', async () => {
  const paths = {
    query_vault: '/api/search',
    query_atlas: '/api/atlas/query',
    get_note: '/api/note',
    wiki_index: '/api/wiki/index',
    wiki_pages: '/api/wiki/pages',
    wiki_graph: '/api/wiki/graph',
    recent_activity: '/api/wiki/log',
  }
  for (const tool of READ_TOOLS) {
    fresh()
    const args = tool === 'query_vault' ? { query: 'tunnel' } : tool === 'get_note' ? { path: 'Wiki/Projects/My Project.md' } : {}
    const r = await query({ tool, args })
    assert.equal(r.ok, true, `${tool}: ${r.error || ''}`)
    assert.ok(r.result.length, `${tool} returned nothing`)
    assert.equal(hits.at(-1).path, paths[tool], `${tool} hit the wrong route`)
  }
})

test('nothing that writes, proposes or steers is reachable — refused by name, never called', async () => {
  // `propose_task` is the sharp one: it IS registered on a knowledgeOnly server
  // when ATLAS_MCP_PROPOSE is set (set above), and it writes into the operator's
  // review queue. The relay gates on KNOWLEDGE_TOOLS, so it is still refused.
  for (const tool of ['propose_task', 'spawn_agent', 'prompt_agent', 'queue_agent', 'interrupt_agent', 'ship_agent', 'merge_pr', 'kill_agent', 'cleanup_agent', 'list_agents', 'agent_transcript', 'not_a_tool']) {
    fresh()
    const r = await query({ tool, args: {} })
    assert.equal(r.status, 403, `${tool} was not refused`)
    assert.match(r.error, /read-only/)
    for (const t of READ_TOOLS) assert.match(r.error, new RegExp(t), 'the refusal names what IS allowed')
    assert.equal(hits.length, 0, `${tool} reached the API`)
    assert.equal(readQueries().at(-1).reason, 'not-allowed')
  }
})

test('an unqualified query reads the ATLAS; an explicit vault wins', async () => {
  fresh()
  await query()
  assert.equal(hits.at(-1).vault, 'atlas')
  fresh()
  await query({ args: { query: 'tunnel', vault: 'work' } })
  assert.equal(hits.at(-1).vault, 'work')
})

/* --- 2. the bounds ---------------------------------------------------- */

test('the per-session budget is a readable error, and stops the work', async () => {
  fresh()
  const max = Number(process.env.ATLAS_QUERY_MAX)
  for (let i = 0; i < max; i++) assert.equal((await query()).ok, true)
  const calls = hits.length
  const r = await query()
  assert.equal(r.status, 429)
  assert.match(r.error, /budget exhausted \(3 per 30 min\)/)
  assert.match(r.error, /retry in \d+ min/)
  assert.equal(hits.length, calls, 'an over-budget query never ran')
  assert.equal(readQueries().at(-1).reason, 'budget')
  // …and it binds THIS session only.
  assert.equal((await query({ from: 'zeta' })).ok, true)
})

test('a big answer is truncated predictably, and says how to narrow it', async () => {
  fresh()
  const r = await query({ args: { query: 'huge' } })
  const cap = Number(process.env.ATLAS_QUERY_RESULT_MAX)
  assert.equal(r.ok, true)
  assert.equal(r.truncated, true)
  assert.ok(r.bytes > cap, 'the fixture must overflow the cap')
  assert.match(r.result, /^[\s\S]{400}\n… \[truncated: 400 of \d+ chars — narrow the query/)
  const log = readQueries().at(-1)
  assert.deepEqual({ truncated: log.truncated, bytes: log.bytes }, { truncated: true, bytes: r.bytes })
})

/* --- 3. the log ------------------------------------------------------- */

test('every query is logged — who asked, what they asked, how big the answer was', async () => {
  fresh()
  const before = readQueries().length
  await query({ args: { query: 'cloudflare tunnel', limit: 3 } })
  const l = readQueries().at(-1)
  assert.equal(readQueries().length, before + 1)
  assert.equal(l.from, 'delta')
  assert.equal(l.bridge, 'workstation')
  assert.equal(l.tool, 'query_vault')
  assert.match(l.args, /cloudflare tunnel/)
  assert.equal(l.ok, true)
  assert.ok(l.bytes > 0 && typeof l.ms === 'number')
  assert.ok(l.at)
})

test('a failing query is logged as a failure, not lost', async () => {
  fresh()
  const r = await query({ tool: 'get_note', args: {} }) // `path` is required by the schema
  assert.equal(r.ok, false)
  assert.equal(r.status, 400)
  assert.match(r.error, /path/, 'the schema violation comes back readable')
  assert.equal(readQueries().at(-1).reason, 'query-error')
})

/* --- 4. the relay: identity, drain, degradation ----------------------- */

test('a relayed query is answered back as the verdict the blocking CLI prints', async () => {
  fresh()
  outboxPending = [{ seq: 11, kind: 'atlas-query', from: 'delta', tool: 'query_atlas', args: { type: 'task', status: 'next' } }]
  seen.verdicts = []
  await __drainOutboxesForTests()
  const v = seen.verdicts.at(-1)
  assert.deepEqual({ seq: v.seq, status: v.status, ok: v.ok }, { seq: 11, status: 200, ok: true })
  assert.match(v.result, /ship the relay/)
  assert.equal(hits.at(-1).path, '/api/atlas/query')
  assert.equal(readQueries().at(-1).from, 'delta')
})

test('identity comes from the box’s own view of the bridge, not the relay', async () => {
  fresh()
  outboxPending = [
    { seq: 12, kind: 'atlas-query', from: 'nobody', tool: 'query_vault', args: { query: 'let me in' } },
    { seq: 13, kind: 'atlas-query', from: 'zeta', tool: 'query_vault', args: { query: 'wrong bridge' } },
  ]
  seen.verdicts = []
  await __drainOutboxesForTests()
  assert.deepEqual(seen.verdicts.map((v) => [v.seq, v.status]), [[12, 401], [13, 401]])
  assert.equal(hits.length, 0, 'no query ran for an unattributable sender')
  const log = readQueries().slice(-2)
  assert.ok(log.every((l) => l.ok === false && l.reason === 'unknown-sender'))
})

test('a kind-less parked item is still mail — the two policies do not cross', async () => {
  fresh()
  const logged = readQueries().length
  outboxPending = [{ seq: 14, from: 'delta', to: 'nobody', text: 'plain mail' }]
  seen.verdicts = []
  await __drainOutboxesForTests()
  assert.equal(seen.verdicts.at(-1).result, undefined, 'mail never returns a query result')
  assert.equal(readQueries().length, logged, 'and it is not in the query log')
})

test('a bridge with no /outbox stays a quiet no-op (an un-restarted bridge)', async () => {
  outboxStatus = 404
  const before = seen.outboxCalls
  await __drainOutboxesForTests() // must not throw
  outboxStatus = 200
  assert.equal(seen.outboxCalls, before + 1)
})

/* --- 5. the container end -------------------------------------------- */

test('the bridge writes the shared wrapper, on the same channel as mail', () => {
  const src = fs.readFileSync(new URL('../../agent-bridge/server.mjs', import.meta.url), 'utf-8')
  assert.match(src, /import \{ ATLAS_QUERY_WRAPPER_SRC \} from '\.\.\/api\/src\/atlas-query-wrapper\.mjs'/, 'one wrapper source, not a copy')
  assert.match(src, /await writeAtlasWrapper\(container\)/)
  // The query route is authed by the SESSION token, so it must sit BEFORE the
  // bridge-bearer gate — an agent must never hold the bridge bearer.
  const route = src.indexOf("p === '/api/atlas/query'")
  const gate = src.indexOf('if (!authed(req))')
  assert.ok(route > 0 && route < gate, 'the query route must precede the bearer gate')
  assert.match(src, /kind: 'atlas-query'/)
  // A verdict carrying an ANSWER needs both the pass-through and the roomier body cap.
  assert.match(src, /typeof v\.result === 'string' \? \{ result: v\.result \}/)
  assert.match(src, /p === '\/outbox'\n/)
})

test('the CLI blocks and prints — and degrades readably on an un-restarted bridge', () => {
  assert.match(ATLAS_QUERY_WRAPPER_SRC, /\/api\/atlas\/query/)
  assert.match(ATLAS_QUERY_WRAPPER_SRC, /ATLAS_AGENT_TOKEN/)
  assert.doesNotMatch(ATLAS_QUERY_WRAPPER_SRC, /setInterval|setTimeout/, 'no client-side polling for its own answer')
  assert.match(ATLAS_QUERY_WRAPPER_SRC, /console\.log\(j\.result\)/)
  assert.match(ATLAS_QUERY_WRAPPER_SRC, /r\.status === 404/)
  assert.match(ATLAS_QUERY_WRAPPER_SRC, /restart-agent-bridge\.sh/)
  for (const t of READ_TOOLS) assert.match(ATLAS_QUERY_WRAPPER_SRC, new RegExp(`'${t}'`), `${t} missing from the CLI's tool list`)
})

test('the remote dev preamble names the command, the tools, and the guard', () => {
  assert.match(ATLAS_REMOTE_SEARCH_PREAMBLE, /atlas-query/)
  for (const t of READ_TOOLS) assert.match(ATLAS_REMOTE_SEARCH_PREAMBLE, new RegExp(t), `${t} unnamed in the preamble`)
  assert.match(ATLAS_REMOTE_SEARCH_PREAMBLE, /not evidence of absence/i)
  assert.match(ATLAS_REMOTE_SEARCH_PREAMBLE, /READING THE CODE/)
  // It ships to bridge agents (the box-local ones have the MCP tools), and it
  // sits INSIDE `remotePreamble` — the string remoteEvidence() sizes its evidence
  // budget against, so this section can't push the bridge's tmux command over its
  // silent ~16 KB ceiling.
  const routes = fs.readFileSync(new URL('../src/agent-routes.mjs', import.meta.url), 'utf-8')
  assert.match(routes, /const remotePreamble = `[^`]*\$\{ATLAS_REMOTE_SEARCH_PREAMBLE\}[^`]*`/)
  assert.match(routes, /preamble: `\$\{remotePreamble\}/)
})
