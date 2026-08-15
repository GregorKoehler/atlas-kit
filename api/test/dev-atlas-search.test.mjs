/* ------------------------------------------------------------------ *
 * What a BOX-LOCAL DEV AGENT is equipped with for Atlas search.
 *
 * Before this, tools followed the repo: an agent on a repo that happened to ship
 * a committed `.mcp.json` picked up whatever that server exposed (no
 * `--strict-mcp-config`), while an agent on any other repo got no tools at all.
 * Both halves are wrong: vault WRITES contradict the invariant that a dev agent
 * never writes the Atlas directly, and the repos that had nothing could not
 * search the Atlas at all.
 *
 * Three things must hold, none of them visible in a diff once the files drift:
 *   1. spawn AND resume load dev.mcp.json with --strict-mcp-config (a revived
 *      agent must not come back without the tools its preamble promises),
 *   2. that config's profile yields EXACTLY the seven read tools — no write or
 *      agent-control tool — for every repo alike,
 *   3. the preamble actually NAMES them: installed-but-unannounced tools go
 *      unused, which is the whole reason the block exists.
 *
 * No tmux is driven and no MCP child is spawned: the launch templates are read
 * as strings and the tool list comes from an in-memory client against
 * buildServer() under the env dev.mcp.json asks for.
 *
 * Run: node --test api/test/dev-atlas-search.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

process.env.AGENT_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-dev-search-local-'))
process.env.AGENT_LOCAL_RECONCILE = '0'
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-dev-search-ws-')) // not a git repo
process.env.WORKSPACE_DIR = WORKSPACE

const HERE = path.dirname(new URL(import.meta.url).pathname)
const DEV_CONFIG = path.join(HERE, '..', 'src', 'mcp', 'dev.mcp.json')

const { LAUNCH_CMD, RESUME_CMD } = await import('../src/agent-local.mjs')
const { ATLAS_SEARCH_PREAMBLE } = await import('../src/agent-routes.mjs')

for (const [name, cmd] of [['LAUNCH_CMD', LAUNCH_CMD], ['RESUME_CMD', RESUME_CMD]]) {
  test(`${name} loads the knowledge-only dev MCP config, strictly`, () => {
    assert.match(cmd, new RegExp(`--mcp-config ${WORKSPACE}/api/src/mcp/dev\\.mcp\\.json `))
    assert.match(cmd, /--strict-mcp-config/) // the repo's own .mcp.json can't widen it
    assert.doesNotMatch(cmd, /control\.mcp\.json/)
    assert.doesNotMatch(cmd, /ATLAS_AGENT_CONTROL/)
  })
}

test('dev.mcp.json asks for the knowledge-only profile and no agent control', () => {
  const cfg = JSON.parse(fs.readFileSync(DEV_CONFIG, 'utf-8'))
  const env = cfg.mcpServers['atlas-kit'].env
  assert.equal(env.ATLAS_MCP_KNOWLEDGE_ONLY, '1')
  assert.equal(env.ATLAS_AGENT_CONTROL, undefined)
})

test('that profile yields exactly the seven read tools — nothing that writes or steers', async () => {
  const cfg = JSON.parse(fs.readFileSync(DEV_CONFIG, 'utf-8'))
  Object.assign(process.env, cfg.mcpServers['atlas-kit'].env) // launch the server as the config would
  try {
    const { buildServer } = await import('../src/mcp/tools.mjs')
    const server = buildServer()
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'dev-atlas-search-test', version: '0' })
    await Promise.all([server.connect(serverT), client.connect(clientT)])
    const { tools } = await client.listTools()
    await client.close()
    await server.close()
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      'get_note', 'query_atlas', 'query_vault', 'recent_activity', 'wiki_graph', 'wiki_index', 'wiki_pages',
    ])
  } finally {
    delete process.env.ATLAS_MCP_KNOWLEDGE_ONLY
  }
})

test('the dev preamble names every tool the agent actually gets', () => {
  for (const t of ['query_atlas', 'query_vault', 'get_note', 'wiki_index', 'wiki_pages', 'wiki_graph', 'recent_activity'])
    assert.match(ATLAS_SEARCH_PREAMBLE, new RegExp(`\`${t}\``), `${t} unnamed in the preamble`)
  // The epistemic guard is the load-bearing half: an empty result must not be
  // read as proof, and code questions are answered from code.
  assert.match(ATLAS_SEARCH_PREAMBLE, /not evidence of absence/i)
  assert.match(ATLAS_SEARCH_PREAMBLE, /READING THE CODE/)
})
