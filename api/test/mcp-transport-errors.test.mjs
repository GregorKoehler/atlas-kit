/* ------------------------------------------------------------------ *
 * An MCP tool call that fails must say WHETHER THE WRITE HAPPENED.
 *
 * The failure this pins: when the API process dies mid-request — a watchdog
 * restart, an OOM kill, a redeploy — `apiPost` had no timeout and no error
 * classification, so an Atlas orchestrator that had just called `spawn_agent`
 * got the bare string `fetch failed` back. That is indistinguishable between
 * "the spawn never happened" and "the spawn happened and I lost the answer",
 * and the natural retry then produces a SECOND agent doing the same job.
 *
 * So the property under test is not "errors are pretty". It is that the three
 * classes stay TOLD APART, because the caller is a model choosing whether to
 * retry:
 *   1. the API ANSWERED and refused (a status)      → nothing happened, retry safe
 *   2. the connection was NEVER ESTABLISHED         → nothing happened, retry safe
 *   3. the request died ON THE WIRE (reset/timeout) → it MAY have happened, check first
 * Class 3 collapsing into class 2's wording is the dangerous regression: it tells
 * a model to retry a write that already ran.
 *
 * Driven over the real in-memory MCP transport against a stub API that fails in
 * each way on purpose — every mode is a real socket-level event, because undici's
 * `cause.code` is what the classification reads and only a real socket makes one.
 *
 * Run: node --test api/test/mcp-transport-errors.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// One vault, so no `vault` param is registered and the calls stay minimal.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-mcp-transport-'))
const VAULTS_FILE = path.join(DIR, 'vaults.json')
fs.writeFileSync(VAULTS_FILE, JSON.stringify({ atlas: { path: '/vault-atlas', label: 'Atlas', default: true } }))
process.env.VAULTS_FILE = VAULTS_FILE

/* --- a stub API that fails on demand ----------------------------------- */
let mode = 'ok'
const api = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    if (mode === 'reset') return req.socket.destroy() // killed mid-request
    if (mode === 'hang') return // never answers — the timeout must fire
    if (mode === 'refused-status') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end('{"ok":false,"error":"unknown filter"}')
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{"count":0,"pages":[],"items":[]}')
  })
})
await new Promise((r) => api.listen(0, '127.0.0.1', r))
process.env.ATLAS_API_BASE = `http://127.0.0.1:${api.address().port}`
// Short enough that the 'hang' case does not stall the suite. Set BEFORE the
// import: tools.mjs reads it into a module-level const.
process.env.ATLAS_MCP_TIMEOUT_MS = '500'

const { buildServer } = await import('../src/mcp/tools.mjs')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')

const server = buildServer({ knowledgeOnly: true })
const [clientT, serverT] = InMemoryTransport.createLinkedPair()
const client = new Client({ name: 'mcp-transport-test', version: '0' })
await Promise.all([server.connect(serverT), client.connect(clientT)])
test.after(() => client.close())

// Call a tool the way an agent does and return the error text it would read.
async function errorOf(name, args = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 20000 })
  const text = (r.content || []).map((c) => c.text || '').join('\n')
  assert.ok(r.isError, `expected a tool error, got: ${text.slice(0, 200)}`)
  return text
}

// `query_atlas` is the POST (a write-shaped call), `query_vault` the GET.
const postError = () => errorOf('query_atlas', { type: 'task' })
const getError = () => errorOf('query_vault', { query: 'anything' })

/* --- 1. the API answered and refused ----------------------------------- */

test('a STATUS is reported as a refusal — the API decided, so nothing was carried out', async () => {
  mode = 'refused-status'
  const e = await postError()
  assert.match(e, /refused with 400/)
  assert.match(e, /nothing was carried out/)
  // It must NOT read as a lost answer — that is the class it is not.
  assert.doesNotMatch(e, /NO ANSWER/)
  assert.doesNotMatch(e, /may already have been carried out/)
})

/* --- 2. the request died on the wire ----------------------------------- */

test('a socket killed MID-REQUEST says the write may already have happened', async () => {
  mode = 'reset'
  const e = await postError()
  assert.match(e, /NO ANSWER/)
  assert.match(e, /may already have been carried out/)
  assert.match(e, /before retrying/)
  // ⚠️ The regression that would matter: telling the caller this is safe.
  assert.doesNotMatch(e, /Safe to retry/)
  assert.doesNotMatch(e, /NOT SENT/)
})

test('a request that never gets an answer TIMES OUT rather than hanging forever', async () => {
  mode = 'hang'
  const t0 = Date.now()
  const e = await postError()
  const ms = Date.now() - t0
  // Bounded by ATLAS_MCP_TIMEOUT_MS above, not by the caller giving up.
  assert.ok(ms < 10000, `took ${ms} ms — the timeout did not fire`)
  assert.match(e, /no response within 500 ms/)
  // A timeout on a POST is also class 3: the request DID reach the API.
  assert.match(e, /may already have been carried out/)
})

test('a GET says the opposite — a read changes nothing, so retrying is always safe', async () => {
  mode = 'reset'
  const e = await getError()
  assert.match(e, /NO ANSWER/)
  assert.match(e, /safe to retry/i)
  assert.doesNotMatch(e, /may already have been carried out/)
})

/* --- 3. the connection was never established --------------------------- *
 * LAST, because these need the stub gone. A closed port is the state an
 * orchestrator meets on the tick AFTER the API process died. */

test('a POST onto a POOLED DEAD socket stays in the cautious class', async () => {
  api.closeAllConnections?.()
  await new Promise((r) => api.close(r))
  // ⚠️ The FIRST call after the server dies does not necessarily get
  // ECONNREFUSED: undici reuses a keep-alive socket from its pool and only then
  // discovers the far end is gone (`UND_ERR_SOCKET`). At that point "were the
  // bytes transmitted before it died" is genuinely unknowable, so the
  // classification must stay CAUTIOUS. Pinned because the tempting "simplify"
  // here is to fold every socket error into the retry-safe branch.
  const e = await postError()
  assert.match(e, /may already have been carried out|NOT SENT/)
  if (/NOT SENT/.test(e)) return // the pool had already dropped it — class 2, also correct
  assert.doesNotMatch(e, /Safe to retry/)
})

test('a REFUSED CONNECTION says nothing was carried out — the retry-safe case', async () => {
  // Any dead pooled socket is gone by now, so this one really does try to connect.
  const e = await postError()
  assert.match(e, /NOT SENT/)
  assert.match(e, /Safe to retry/)
  assert.doesNotMatch(e, /may already have been carried out/)
})
