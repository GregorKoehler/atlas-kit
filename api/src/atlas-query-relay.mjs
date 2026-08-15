/* ------------------------------------------------------------------ *
 * Atlas queries for REMOTE (bridge) dev agents — the box half.
 *
 * A box-local dev agent gets the Atlas read tools as MCP tools (dev.mcp.json,
 * ATLAS_MCP_KNOWLEDGE_ONLY=1). A container agent behind a bridge can't: the
 * box's Express is loopback-bound, and exposing the HTTP MCP server to reach it
 * is a new ingress nobody asked for. So the query rides the channel agent mail
 * already built — container → its own bridge (its per-session scoped token) →
 * parked → drained by the box on the remote poll it already runs → answered
 * back over the box→bridge direction, which was never blocked. No tunnel
 * ingress, no DNS, no new listening socket, nothing new on MCP_BIND.
 *
 * This module is what the box RUNS when it drains one of those. It executes the
 * query IN-PROCESS through the SAME tool handlers a box-local dev agent calls:
 * buildServer({ knowledgeOnly: true }) over an in-memory MCP transport. That is
 * deliberate rather than a second dispatch table — the reachable surface is then
 * the knowledge-only profile BY CONSTRUCTION (exactly the seven read tools of
 * KNOWLEDGE_TOOLS; no write or agent-control tool is even registered), the zod inputSchema validates the remote agent's arguments at the
 * trust boundary, and query_atlas's flat-param → query-spec mapping can't drift.
 *
 * Bounded three ways, because this is the one path by which Atlas content leaves
 * the box: an allowlist (the tool name), a rolling PER-SESSION query budget
 * (per-session, not per-pair — the counterpart here is the box, not a peer), and
 * a hard cap on the RESULT, which has to travel back through the relay.
 *
 * And LOGGED — every query and every rejection, to atlas-queries.jsonl beside
 * the bus log, with the same rotation discipline (agent-messages.mjs): who
 * asked, what they asked, how big the answer was, why a rejection bounced. That
 * log is the operator's record of what left the box.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listVaults } from './vaults.mjs'

const STATE_DIR = process.env.AGENT_LOCAL_DIR || path.join(os.homedir(), '.atlas-kit')
const LOG_FILE = path.join(STATE_DIR, 'atlas-queries.jsonl')
const MAX_BYTES = Number(process.env.ATLAS_QUERY_LOG_MAX_BYTES || 2 * 1024 * 1024)
// Per-line cap on the logged argument JSON — the log is the record of WHAT was
// asked, not a second copy of the corpus.
const ARGS_MAX = Number(process.env.ATLAS_QUERY_LOG_ARGS_MAX || 1000)
// Hard cap on the answer. wiki_index alone is >200 KB and a broad query_vault
// can be large; the reply travels back through the relay and into a model's
// context, so truncate loudly and tell the agent how to narrow it.
const RESULT_MAX = Number(process.env.ATLAS_QUERY_RESULT_MAX || 20000)
// Rolling per-SESSION query budget. Exhaustion is a readable error the agent
// gets back, never a silent drop.
const QUERY_MAX = Number(process.env.ATLAS_QUERY_MAX || 40)
const QUERY_WINDOW_MS = Number(process.env.ATLAS_QUERY_WINDOW_MS || 30 * 60 * 1000)
// The query itself is local retrieval (0.3–0.6 s measured). A timeout keeps a
// pathological one from holding the serial drain: the SDK cancels the request.
const QUERY_TIMEOUT_MS = Number(process.env.ATLAS_QUERY_TIMEOUT_MS || 20000)
// Which knowledge base an unqualified `atlas-query` reads. The command is named
// for the Atlas and the preamble sells it as the Atlas, so default there rather
// than to any sibling vault — but only when that vault is actually registered on
// this box, else fall through to whatever the caller named.
const DEFAULT_VAULT = process.env.ATLAS_QUERY_VAULT || 'atlas'

const queries = new Map() // session id -> query timestamps inside the window

/* Append one line: { at, from, bridge, tool, args, ok, bytes, truncated, ms,
 * reason? }. Rotates to a single `.1` generation past MAX_BYTES — same
 * discipline as agent-messages.jsonl, for the same reason — the box's own logs
 * grow fast enough without a second unbounded file. */
export function appendQueryLog(rec) {
  const line = {
    at: rec.at || new Date().toISOString(),
    from: rec.from,
    ...(rec.bridge ? { bridge: rec.bridge } : {}),
    tool: rec.tool,
    args: String(rec.args == null ? '' : rec.args).slice(0, ARGS_MAX),
    ok: !!rec.ok,
    ...(rec.bytes == null ? {} : { bytes: rec.bytes }),
    ...(rec.truncated ? { truncated: true } : {}),
    ...(rec.ms == null ? {} : { ms: rec.ms }),
    ...(rec.reason ? { reason: rec.reason } : {}),
  }
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    try {
      if (fs.statSync(LOG_FILE).size > MAX_BYTES) fs.renameSync(LOG_FILE, `${LOG_FILE}.1`)
    } catch {
      /* no log yet */
    }
    fs.appendFileSync(LOG_FILE, `${JSON.stringify(line)}\n`)
  } catch (e) {
    console.error('[atlas-query] log append failed:', e.message)
  }
  return line
}

/* The queries of one session, or the whole recent log. Newest last, capped —
 * mirrors readMessages(); the operator's read surface for this log. */
export function readQueries({ from, limit = 200 } = {}) {
  let text
  try {
    text = fs.readFileSync(LOG_FILE, 'utf-8')
  } catch {
    return []
  }
  const out = []
  for (const l of text.split('\n')) {
    if (!l) continue
    try {
      const r = JSON.parse(l)
      if (!from || r.from === from) out.push(r)
    } catch {
      /* skip a partial line */
    }
  }
  return out.slice(-Math.max(1, Math.min(1000, limit)))
}

/* Has `from` any query budget left? { ok, left } or { ok:false, retryInMs }. */
function checkQueryBudget(from, now = Date.now()) {
  const at = (queries.get(from) || []).filter((t) => now - t < QUERY_WINDOW_MS)
  queries.set(from, at)
  if (at.length < QUERY_MAX) return { ok: true, left: QUERY_MAX - at.length - 1 }
  return { ok: false, retryInMs: QUERY_WINDOW_MS - (now - at[0]), max: QUERY_MAX, windowMs: QUERY_WINDOW_MS }
}

// Charge one query. Charged for every EXECUTED query, including one that errors:
// the budget bounds the work this path does, not the successes.
function noteQuery(from, now = Date.now()) {
  queries.set(from, (queries.get(from) || []).concat(now))
}

/* The knowledge-only MCP surface, built once and reused (the drain is serial).
 * Imported lazily so a box with no bridge never loads the MCP SDK at boot. */
let clientPromise = null
function knowledgeSurface() {
  if (!clientPromise) {
    clientPromise = (async () => {
      const [{ buildServer, KNOWLEDGE_TOOLS }, { Client }, { InMemoryTransport }] = await Promise.all([
        import('./mcp/tools.mjs'),
        import('@modelcontextprotocol/sdk/client/index.js'),
        import('@modelcontextprotocol/sdk/inMemory.js'),
      ])
      const server = buildServer({ knowledgeOnly: true })
      const [clientT, serverT] = InMemoryTransport.createLinkedPair()
      const client = new Client({ name: 'atlas-kit-query-relay', version: '0' })
      await Promise.all([server.connect(serverT), client.connect(clientT)])
      return { client, tools: KNOWLEDGE_TOOLS }
    })().catch((e) => {
      clientPromise = null // a failed build must not poison every later query
      throw e
    })
  }
  return clientPromise
}

// Flatten an MCP tool result's content blocks to the text the agent prints.
const resultText = (r) =>
  (Array.isArray(r?.content) ? r.content : [])
    .map((c) => (typeof c?.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n')

/* Run ONE relayed query. `from` is the session id the CALLER resolved (from the
 * bridge's own view of its sessions — never from anything the agent typed).
 *
 * Returns { status, ok, error? | result?, bytes?, truncated? } — the shape the
 * drain hands back to the bridge as the verdict, which the blocking CLI prints. */
export async function runAtlasQuery({ from, bridge, tool, args }) {
  const argsJson = args == null ? '' : JSON.stringify(args)
  const reject = (status, error, reason) => {
    appendQueryLog({ from, bridge, tool: String(tool || ''), args: argsJson, ok: false, reason })
    return { status, ok: false, error }
  }
  if (!from) return reject(401, 'unknown session', 'no-session')
  if (!tool || typeof tool !== 'string') return reject(400, 'missing "tool"', 'no-tool')
  if (args != null && (typeof args !== 'object' || Array.isArray(args))) return reject(400, '"args" must be a JSON object', 'bad-args')

  let surface
  try {
    surface = await knowledgeSurface()
  } catch (e) {
    return reject(503, `Atlas query engine unavailable: ${e?.message || e}`, 'unavailable')
  }
  // The hard boundary. Only the seven knowledge-only READ tools; anything else —
  // a write tool, an agent-control tool, a typo — is refused by NAME here and
  // isn't registered on that surface anyway.
  if (!surface.tools.has(tool))
    return reject(403, `"${tool}" is not available here — Atlas queries are read-only: ${[...surface.tools].join(', ')}`, 'not-allowed')

  const budget = checkQueryBudget(from)
  if (!budget.ok)
    return reject(
      429,
      `Atlas query budget exhausted (${budget.max} per ${Math.round(budget.windowMs / 60000)} min) — retry in ${Math.ceil(budget.retryInMs / 60000)} min, or ask the operator`,
      'budget',
    )
  noteQuery(from)

  // Default to the Atlas when the agent named no vault and this box has one.
  const callArgs = { ...(args || {}) }
  if (!callArgs.vault && listVaults().some((v) => v.key === DEFAULT_VAULT)) callArgs.vault = DEFAULT_VAULT

  const t0 = Date.now()
  let out
  try {
    out = await surface.client.callTool({ name: tool, arguments: callArgs }, undefined, { timeout: QUERY_TIMEOUT_MS })
  } catch (e) {
    // A timed-out/cancelled call or a transport failure. (A schema violation in
    // the agent's arguments comes back as an isError RESULT, handled below.)
    appendQueryLog({ from, bridge, tool, args: argsJson, ok: false, ms: Date.now() - t0, reason: 'call-failed' })
    return { status: 400, ok: false, error: `${tool} failed: ${e?.message || e}` }
  }
  const ms = Date.now() - t0
  const text = resultText(out)
  if (out?.isError) {
    appendQueryLog({ from, bridge, tool, args: argsJson, ok: false, ms, reason: 'query-error' })
    return { status: 400, ok: false, error: text || `${tool} failed` }
  }
  const truncated = text.length > RESULT_MAX
  const result = truncated
    ? `${text.slice(0, RESULT_MAX)}\n… [truncated: ${RESULT_MAX} of ${text.length} chars — narrow the query (add "limit", or filter with query_atlas) and ask again]`
    : text
  appendQueryLog({ from, bridge, tool, args: argsJson, ok: true, bytes: text.length, truncated, ms })
  return { status: 200, ok: true, result, bytes: text.length, ...(truncated ? { truncated: true } : {}) }
}

/* Test seam: drop in-memory state (module state persists across test() blocks
 * sharing a process) — mirrors agent-messages.mjs's. */
export function __resetForTests() {
  queries.clear()
}
