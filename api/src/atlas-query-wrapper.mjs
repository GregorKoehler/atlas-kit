/* ------------------------------------------------------------------ *
 * `atlas-query` — the wrapper script a REMOTE (container) dev agent gets on its
 * PATH, so querying the operator's Atlas is an ordinary blocking command.
 *
 * Same shape and same source-of-truth discipline as agent-msg-wrapper.mjs: the
 * bridge writes these exact bytes into each container and launches the agent with
 * `ATLAS_API` pointing at the bridge itself + its per-session `ATLAS_AGENT_TOKEN`.
 * The bridge parks the query, the box drains it on the remote poll it already
 * runs (~3 s), runs it against the knowledge-only tool surface and pushes the
 * answer back — so this command BLOCKS and prints the result. It must not hand
 * back a ticket: an agent polling for its own answer spends a model turn per
 * poll, which costs more than the query saves.
 *
 * Box-local dev agents don't need it — they call the same seven tools as MCP
 * tools (dev.mcp.json).
 *
 * Plain CommonJS (no package.json in the dir it lands in) — hence `.then` rather
 * than top-level await; `fetch` is a node global.
 * ------------------------------------------------------------------ */
export const ATLAS_QUERY_WRAPPER_SRC = `#!/usr/bin/env node
// atlas-kit atlas-query — one READ-ONLY query against the operator's Knowledge
// Atlas, run on the dashboard box. Written by the executor; do not edit.
const TOOLS = ['query_atlas', 'query_vault', 'get_note', 'wiki_index', 'wiki_pages', 'wiki_graph', 'recent_activity']
const [tool, ...rest] = process.argv.slice(2)
const inline = rest.join(' ').trim()
function usage(msg) {
  if (msg) console.error('atlas-query: ' + msg)
  console.error('usage: atlas-query <tool> [json-args]      (json-args "-" reads stdin; default {})')
  console.error('tools: ' + TOOLS.join(', '))
  console.error('examples — single-quote the JSON so your shell leaves it alone:')
  console.error('  atlas-query query_vault {"query":"cloudflare tunnel","limit":5}')
  console.error('  atlas-query query_atlas {"type":"task","status":"next","edge_key":"for_project","edge_target":"My Project"}')
  console.error('  atlas-query get_note {"path":"Wiki/Projects/My Project.md"}')
  process.exit(2)
}
if (!tool) usage()
if (!TOOLS.includes(tool)) usage('unknown tool "' + tool + '"')
const read = () =>
  inline === '-'
    ? new Promise((res) => {
        let b = ''
        process.stdin.setEncoding('utf-8')
        process.stdin.on('data', (c) => (b += c))
        process.stdin.on('end', () => res(b))
      })
    : Promise.resolve(inline)
read()
  .then((raw) => {
    let args = {}
    if (raw.trim()) {
      try {
        args = JSON.parse(raw)
      } catch (e) {
        usage('arguments must be JSON — ' + e.message)
      }
    }
    return fetch((process.env.ATLAS_API || 'http://127.0.0.1:3001') + '/api/atlas/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (process.env.ATLAS_AGENT_TOKEN || '') },
      body: JSON.stringify({ tool, args }),
    })
  })
  .then(async (r) => {
    const j = await r.json().catch(() => ({}))
    // A bridge that has not been restarted since this shipped has no such route.
    if (r.status === 404) {
      console.error('atlas-query: not available on this bridge yet (it needs a restart) — carry on without it, or ask the operator to run: sudo scripts/restart-agent-bridge.sh')
      process.exit(1)
    }
    if (!r.ok || j.ok === false || typeof j.result !== 'string') {
      console.error('atlas-query: ' + (j.error || j.note || 'HTTP ' + r.status))
      process.exit(1)
    }
    console.log(j.result)
  })
  .catch((e) => {
    console.error('atlas-query: ' + e.message)
    process.exit(1)
  })
`
