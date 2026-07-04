/* ------------------------------------------------------------------ *
 * Atlas Kit MCP tools — the transport-agnostic core.
 *
 * `buildServer()` returns a fully-configured McpServer whose tools are
 * thin wrappers over the running Express API: the vault reads (search,
 * wiki, typed query) plus, for the Atlas orchestrator only, the agent-
 * control tools. Both entry points reuse it:
 *   - server.mjs  → stdio   (local Claude Code)
 *   - http.mjs    → HTTP    (remote Claude.ai connector)
 *
 * Config (env):
 *   ATLAS_API_BASE          default http://127.0.0.1:3001 (Express, direct)
 *   DASHBOARD_BEARER_TOKEN  sent on write calls (server-side only)
 *   ATLAS_AGENT_CONTROL     when set, adds the agent-control tools (orchestrator)
 * ------------------------------------------------------------------ */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { listVaults, defaultVaultKey } from '../vaults.mjs'

const API_BASE = (process.env.ATLAS_API_BASE || 'http://127.0.0.1:3001').replace(/\/$/, '')
const BEARER = process.env.DASHBOARD_BEARER_TOKEN || ''

async function apiGet(path) {
  const res = await fetch(API_BASE + path)
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}`)
  const ct = res.headers.get('content-type') || ''
  return ct.includes('json') ? res.json() : res.text()
}

// Append ?vault=<key> (or &vault=) to a read path when a vault is named — the
// read routes resolve it to that knowledge base; absent → the default vault.
function withVault(apiPath, vault) {
  if (!vault) return apiPath
  return apiPath + (apiPath.includes('?') ? '&' : '?') + `vault=${encodeURIComponent(vault)}`
}

async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(BEARER ? { Authorization: `Bearer ${BEARER}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${JSON.stringify(data)}`)
  return data
}

const asText = (data) => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
})

// Wrap a handler so thrown errors come back as readable, non-fatal tool errors.
const tool = (fn) => async (args) => {
  try {
    return asText(await fn(args || {}))
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e?.message || String(e)}` }], isError: true }
  }
}

export function buildServer() {
  const server = new McpServer({ name: 'atlas-kit', version: '0.1.0' })

  // Optional `vault` on the write tools — route ingest/research/amend to a
  // specific knowledge base. Only added when more than one vault is configured;
  // listed so the model picks correctly, and the API validates/rejects unknowns.
  const vaults = listVaults()
  const vaultList = vaults.map((v) => `"${v.key}" = ${v.label}`).join('; ')
  const vaultParam =
    vaults.length > 1
      ? { vault: z.string().optional().describe(`which vault to write to (default "${defaultVaultKey()}"): ${vaultList}`) }
      : {}
  // ingest_url can also auto-detect the vault from the captured content.
  const vaultParamAuto =
    vaults.length > 1
      ? { vault: z.string().optional().describe(`which vault (default "${defaultVaultKey()}", or "auto" to detect from the content): ${vaultList}`) }
      : {}
  // Same optional `vault` for the READ tools — which knowledge base to read from.
  const vaultReadParam =
    vaults.length > 1
      ? { vault: z.string().optional().describe(`which vault to read from (default "${defaultVaultKey()}"): ${vaultList}`) }
      : {}

  /* ---- READ tools (open GET routes) ------------------------------- */

  server.registerTool(
    'query_vault',
    {
      description:
        'Full-text (fuzzy, prose) search across the knowledge vault (Wiki + notes) — keyword ranking over page CONTENT. For EXACT relational/temporal questions over the typed layer (owes/for_project/area edges, node type, status, due/last_contact dates), use query_atlas instead.',
      inputSchema: { query: z.string().describe('search terms'), limit: z.number().int().positive().max(50).optional(), ...vaultReadParam },
    },
    tool(async ({ query, limit, vault }) => {
      const r = await apiGet(withVault(`/api/search?q=${encodeURIComponent(query)}`, vault))
      const items = r?.items ?? r
      return limit && Array.isArray(items) ? { items: items.slice(0, limit) } : r
    }),
  )

  // The relational/temporal counterpart of query_vault: filters and traverses the
  // Atlas's TYPED frontmatter (edges, node types, status, dates) for exact,
  // complete answers — the payoff of the typed layer (Guide §7). Maps friendly
  // flat params onto the structured query spec the engine takes.
  server.registerTool(
    'query_atlas',
    {
      description:
        'Relational + temporal query over the Atlas\'s TYPED layer — the exact counterpart of query_vault\'s fuzzy search. Filters/traverses typed fields for complete answers: "what do I owe X" (edge_key=owes, edge_target=X), "tasks due this week" (type=task, due_within=this_week), "overdue tasks" (due_within=overdue), "tasks in area Health" (type=task, area=Health), "contacts past their cadence" (past_cadence=true), "everything linked to a project" (linked_to=...). Typed edge keys are snake_case — see the Legend (owes, owed_by, area, depends_on, for_project, stakeholders, mentor, works_with).',
      inputSchema: {
        type: z.string().optional().describe('node type(s), comma-separated (e.g. "task", "person", "project", "concept")'),
        status: z.string().optional().describe('task lifecycle, comma-separated (inbox|next|doing|waiting|done)'),
        area: z.string().optional().describe('PARA area — matches the `area` typed edge target (e.g. "Health", "Finance")'),
        edge_key: z.string().optional().describe('a typed edge key to filter on, snake_case (e.g. "owes", "for_project", "depends_on", "stakeholders")'),
        edge_target: z.string().optional().describe('the [[page]] the edge points to (partial match ok); use with edge_key'),
        linked_to: z.string().optional().describe('pages with ANY typed edge pointing at this target'),
        due_within: z.enum(['overdue', 'today', 'next_7d', 'this_week', 'this_month', 'past_7d']).optional().describe('relative window for the `due` date'),
        due_before: z.string().optional().describe('due on/before this date (YYYY-MM-DD)'),
        due_after: z.string().optional().describe('due on/after this date (YYYY-MM-DD)'),
        past_cadence: z.boolean().optional().describe('personal contacts overdue for contact (last_contact + cadence_days < today)'),
        text: z.string().optional().describe('full-text filter applied WITHIN the typed-filtered set (hybrid search)'),
        sort: z.string().optional().describe('sort field; "-" prefix = descending (e.g. "due", "-updated", "title")'),
        limit: z.number().int().positive().max(200).optional(),
        ...vaultReadParam,
      },
    },
    tool(({ type, status, area, edge_key, edge_target, linked_to, due_within, due_before, due_after, past_cadence, text, sort, limit, vault }) => {
      const spec = {}
      if (type) spec.type = type.split(',').map((s) => s.trim()).filter(Boolean)
      if (status) spec.status = status.split(',').map((s) => s.trim()).filter(Boolean)
      const edges = []
      if (edge_key) edges.push({ key: edge_key, target: edge_target })
      if (area) edges.push({ key: 'area', target: area })
      if (edges.length) spec.edges = edges
      if (linked_to) spec.linkedTo = linked_to
      if (due_within || due_before || due_after) spec.due = { window: due_within, before: due_before, after: due_after }
      if (past_cadence) spec.past_cadence = true
      if (text) spec.text = text
      if (sort) spec.sort = sort
      if (limit) spec.limit = limit
      return apiPost(withVault('/api/atlas/query', vault), spec)
    }),
  )

  server.registerTool(
    'get_note',
    {
      description: 'Read a single note/page by its vault-relative path (e.g. "Wiki/Organizations/Cloudflare.md").',
      inputSchema: { path: z.string().describe('vault-relative path to the note'), ...vaultReadParam },
    },
    tool(({ path, vault }) => apiGet(withVault(`/api/note?path=${encodeURIComponent(path)}`, vault))),
  )

  server.registerTool(
    'recent_activity',
    { description: 'The wiki change log — what was recently ingested/edited.', inputSchema: { ...vaultReadParam } },
    tool(({ vault }) => apiGet(withVault('/api/wiki/log', vault))),
  )

  server.registerTool(
    'wiki_index',
    { description: 'The wiki index (table of contents of the knowledge base).', inputSchema: { ...vaultReadParam } },
    tool(({ vault }) => apiGet(withVault('/api/wiki/index', vault))),
  )

  server.registerTool(
    'wiki_pages',
    { description: 'List all wiki pages (titles + paths).', inputSchema: { ...vaultReadParam } },
    tool(({ vault }) => apiGet(withVault('/api/wiki/pages', vault))),
  )

  server.registerTool(
    'wiki_graph',
    { description: 'The wiki link graph — nodes and backlinks between pages.', inputSchema: { ...vaultReadParam } },
    tool(({ vault }) => apiGet(withVault('/api/wiki/graph', vault))),
  )


  // Opt-in: only the Atlas ORCHESTRATOR launches the MCP server with this flag
  // set (its control.mcp.json sets ATLAS_AGENT_CONTROL=1), so a normal vault
  // chat / dev-agent session never sees the agent-control tools.
  if (process.env.ATLAS_AGENT_CONTROL) registerAgentControl(server)

  return server
}

/* ---- AGENT-CONTROL tools (opt-in: ATLAS_AGENT_CONTROL) -------------
 * Let the Atlas agent SPAWN / MONITOR / STEER the operator's other agents.
 * Each tool is a thin wrapper over the dashboard's existing /api/agents/*
 * routes — so the same box-local↔bridge routing, repo allowlist, and audit log
 * the dashboard buttons use apply unchanged. The exec routes are bearer-gated;
 * apiPost injects DASHBOARD_BEARER_TOKEN server-side (the agent never holds it),
 * exactly like the write tools above. */
function registerAgentControl(server) {
  // Stamp the calling Atlas orchestrator onto a steer (prompt/queue/interrupt), so
  // the target agent's chat view can color an agent-injected prompt apart from the
  // operator's own input — it lands in the transcript as an ordinary user turn and
  // is otherwise indistinguishable. Same ATLAS_SESSION the spawn lineage
  // uses; absent (→ untagged) for anything but the orchestrator's MCP child.
  const steerBody = (id, text) => {
    const body = { id, text }
    if (process.env.ATLAS_SESSION) body.steeredBy = process.env.ATLAS_SESSION
    return body
  }

  // Compact one-row-per-agent projection for the monitoring feed — the full
  // session objects carry sub-agent/job/transcript detail that would flood the
  // model; keep the fields an orchestrator reasons over.
  const slim = (s) => ({
    id: s.id,
    kind: s.kind || 'dev',
    repo: s.repo,
    vault: s.vault,
    status: s.status,
    phase: s.phase,
    task: s.task,
    branch: s.branch,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    context: s.contextTokens ? { tokens: s.contextTokens, window: s.contextWindow } : undefined,
    subAgents: Array.isArray(s.subAgents) && s.subAgents.length ? s.subAgents.length : undefined,
    bgJobs: Array.isArray(s.bgJobs) ? s.bgJobs.filter((j) => j && j.status === 'running').length || undefined : undefined,
    queued: Array.isArray(s.queued) && s.queued.length ? s.queued.length : undefined,
    ship: s.shipState ? { state: s.shipState, info: s.shipInfo } : undefined,
    closing: s.closing || undefined,
    atlasWorker: s.atlasWorker,
    pairedDev: s.pairedDev,
    lastSeen: s.lastSeen,
    error: s.error,
  })

  server.registerTool(
    'list_agents',
    {
      description:
        'List every agent the dashboard knows about (dev + knowledge, box-local AND remote bridges) with live status — your monitoring feed. Returns `localRepos` (box-local repo keys you may spawn a DEV agent on), `bridges` (remote hosts, each `{label, repos}` — a bridge\'s `repos` are ALSO spawnable dev-repo keys, e.g. a remote repo like `my-app`), and `sessions` (each with id, kind, repo/vault, status, phase, task, context usage, sub-agent/bg-job/queued counts, ship state). To spawn a DEV agent, pass any key from `localRepos` OR any `bridges[].repos` entry as `repo`. Use a session `id` with agent_transcript to read its work, or with prompt_agent/queue_agent/interrupt_agent/kill_agent to steer it.',
      inputSchema: {},
    },
    tool(async () => {
      const r = await apiGet('/api/agents')
      return {
        localRepos: r?.localRepos ?? [],
        // Surface each bridge's spawnable dev-repo keys (`spawnRepos`), not just
        // the label — so an orchestrator can discover + spawn on remote repos
        // (a remote bridge's repos) the same as box-local ones.
        bridges: (r?.bridges ?? [])
          .map((b) => (typeof b === 'string' ? { label: b, repos: [] } : { label: b?.label, repos: b?.spawnRepos ?? b?.repos ?? [] }))
          .filter((b) => b.label),
        sessions: (r?.sessions ?? []).map(slim),
      }
    }),
  )

  server.registerTool(
    'agent_transcript',
    {
      description:
        "Read the tail of one agent's live transcript (its terminal output) by session id — how you check on what an agent is actually doing before you judge or steer it. `lines` defaults to 200 (max 2000).",
      inputSchema: {
        id: z.string().describe('the agent session id (from list_agents)'),
        lines: z.number().int().positive().max(2000).optional().describe('how many trailing lines (default 200)'),
      },
    },
    tool(({ id, lines }) => apiGet(`/api/agents/output?id=${encodeURIComponent(id)}${lines ? `&lines=${lines}` : ''}`)),
  )

  server.registerTool(
    'spawn_agent',
    {
      description:
        'Start a NEW agent. A DEV agent (default) works in a git worktree of a repo and opens a PR — pass `repo` (a spawnable key from list_agents: a `localRepos` key OR any `bridges[].repos` entry, e.g. a remote repo like `my-app`) and a sharp, self-contained `task`. A KNOWLEDGE agent chats over a vault — pass kind:"knowledge" and optionally `vault`. Returns the new session id immediately; the agent then runs on its own. Spawning is allowlist-bounded and audited. NEVER spawn another Atlas orchestrator (a knowledge agent on vault "atlas").',
      inputSchema: {
        task: z.string().describe('the task (dev agent) or opening question (knowledge agent)'),
        repo: z.string().optional().describe('repo key for a DEV agent (a localRepos key or a bridges[].repos entry from list_agents); omit for a knowledge agent'),
        kind: z.enum(['dev', 'knowledge']).optional().describe('default "dev"'),
        vault: z.string().optional().describe('for a knowledge agent: which vault (e.g. "atlas")'),
        model: z.enum(['opus', 'fable', 'sonnet']).optional().describe('default opus'),
        effort: z.enum(['high', 'xhigh', 'max']).optional().describe('default xhigh'),
      },
    },
    tool(({ task, repo, kind, vault, model, effort }) => {
      const body = { task }
      if (model) body.model = model
      if (effort) body.effort = effort
      // Stamp this orchestrator as the parent so the dashboard can draw the spawn
      // lineage (ATLAS_SESSION is injected into the MCP child's env by the
      // Atlas launch — agent-local.mjs's ATLAS_CONTROL_LAUNCH_CMD).
      if (process.env.ATLAS_SESSION) body.parent = process.env.ATLAS_SESSION
      if (kind === 'knowledge') {
        body.kind = 'knowledge'
        if (vault) body.vault = vault
      } else {
        body.repo = repo
      }
      return apiPost('/api/agents/spawn', body)
    }),
  )

  server.registerTool(
    'prompt_agent',
    {
      description:
        'Send a message to an IDLE agent (its next turn) — give it more work, or answer its question once it has finished its current turn. For an agent that is mid-run, use queue_agent (delivered at its next idle) or interrupt_agent (stops it now).',
      inputSchema: { id: z.string(), text: z.string().describe('the message to deliver') },
    },
    tool(({ id, text }) => apiPost('/api/agents/prompt', steerBody(id, text))),
  )

  server.registerTool(
    'queue_agent',
    {
      description:
        "Park a message for an agent; the dashboard delivers it automatically at the agent's next idle (never mid-turn). The GENTLE way to add context or instructions to a busy agent without disrupting its current turn — prefer this over interrupt_agent.",
      inputSchema: { id: z.string(), text: z.string() },
    },
    tool(({ id, text }) => apiPost('/api/agents/queue', steerBody(id, text))),
  )

  server.registerTool(
    'interrupt_agent',
    {
      description:
        "Stop an agent's in-flight turn (Escape) and immediately steer it with new instructions — disruptive; use ONLY when the agent is going wrong or must change course now. To add context without interrupting, use queue_agent.",
      inputSchema: { id: z.string(), text: z.string() },
    },
    tool(({ id, text }) => apiPost('/api/agents/interrupt', steerBody(id, text))),
  )

  server.registerTool(
    'kill_agent',
    {
      description:
        "Close an agent session. A dev agent's worktree/branch are kept for review (clean up from the dashboard); a knowledge agent closes gracefully (flushing insights), which may take a turn — call again to force. Use when an agent's work is done or it was started in error.",
      inputSchema: { id: z.string() },
    },
    tool(({ id }) => apiPost('/api/agents/kill', { id })),
  )

  server.registerTool(
    'cleanup_agent',
    {
      description:
        "Fully tear down a DEV agent whose work is DONE or already merged — the dashboard's ⌦ button. Closes gracefully like kill_agent (a paired dev agent recaps → its Atlas worker logs the session), but ALSO removes the git worktree and deletes the agent's branch afterward, where a plain kill_agent keeps them for review. Destructive of the local branch — use once the agent's PR is merged/abandoned, NOT while it still has unpushed work. Call again to force if the graceful recap stalls.",
      inputSchema: { id: z.string() },
    },
    tool(({ id }) => apiPost('/api/agents/cleanup', { id })),
  )
}
