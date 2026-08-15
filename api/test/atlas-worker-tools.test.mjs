/* ------------------------------------------------------------------ *
 * The paired Atlas worker's launch contract — what it is EQUIPPED with, and how
 * big its launch line may get.
 *
 * The worker used to launch with no --mcp-config at all, so it hand-grepped the
 * Atlas for every relational lookup. It now loads worker.mcp.json. Three things
 * must hold, and none of them is visible in a diff once the files drift apart:
 *   1. it gets query_atlas/query_vault (else "PREFER them over grep" is a lie),
 *   2. it NEVER gets the agent-control tools — it is a dashboard-driven worker,
 *      not an orchestrator — nor any write tool,
 *   3. its launch line stays far under tmux's command ceiling whatever the first
 *      turn weighs, because the prompt travels by FILE.
 *
 * No tmux is driven: the launch line comes from atlasWorkerLaunch() (whose only
 * side effect is writing the session's prompt file under the sandboxed
 * STATE_DIR), and the tool list from an in-memory MCP client against
 * buildServer().
 *
 * Run: node --test api/test/atlas-worker-tools.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-worker-local-'))
process.env.AGENT_LOCAL_DIR = STATE_DIR
process.env.AGENT_LOCAL_RECONCILE = '0'
const WORKSPACE = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-worker-ws-')) // not a git repo
process.env.WORKSPACE_DIR = WORKSPACE

const HERE = path.dirname(new URL(import.meta.url).pathname)
const WORKER_CONFIG = path.join(HERE, '..', 'src', 'mcp', 'worker.mcp.json')

const { atlasWorkerLaunch, ATLAS_WORKER_STANDBY, TMUX_MAX_COMMAND_BYTES } = await import('../src/agent-local.mjs')
const launch = atlasWorkerLaunch({ id: 'atlas-t1', sid: 'sid-1', head: ATLAS_WORKER_STANDBY })

test('the worker launches with the read-only worker MCP config, never the control one', () => {
  assert.match(launch, new RegExp(`--mcp-config ${WORKSPACE}/api/src/mcp/worker\\.mcp\\.json `))
  assert.match(launch, /--strict-mcp-config/) // no other MCP server can slip in
  assert.doesNotMatch(launch, /control\.mcp\.json/)
  assert.doesNotMatch(launch, /ATLAS_AGENT_CONTROL/)
  assert.match(launch, /--session-id 'sid-1'/) // pinned id kept (the transcript reader needs it)
})

test('worker.mcp.json asks for the knowledge-only profile and no agent control', () => {
  const cfg = JSON.parse(fs.readFileSync(WORKER_CONFIG, 'utf-8'))
  const env = cfg.mcpServers['atlas-kit'].env
  assert.equal(env.ATLAS_MCP_KNOWLEDGE_ONLY, '1')
  // Propose-only write: the worker may PROPOSE follow-up work, never file it.
  assert.equal(env.ATLAS_MCP_PROPOSE, '1')
  assert.equal(env.ATLAS_AGENT_CONTROL, undefined)
})

/* The launch line must not grow with the first turn. A worker's head is the
 * standing preamble plus its first turn — kilobytes today, and the ingest path
 * hands it a whole session recap. It travels by FILE, so the command carries
 * only a path; this is what keeps a `command too long` from silently killing
 * every paired spawn. */
test('the launch line stays far under the tmux ceiling however big the first turn is', () => {
  const head = 'P'.repeat(30000)
  const l = atlasWorkerLaunch({ id: 'atlas-huge', sid: 'sid-2', head })
  assert.ok(Buffer.byteLength(l) < TMUX_MAX_COMMAND_BYTES / 4, `launch line was ${Buffer.byteLength(l)} B`)
  assert.ok(!l.includes('P'.repeat(200)), 'the first turn must not be in the tmux command')
  assert.equal(fs.readFileSync(path.join(STATE_DIR, 'prompts', 'atlas-huge.txt'), 'utf-8'), head)
})

/* ---- the tool surface the worker actually ends up with ------------- */

async function toolNames() {
  const { buildServer } = await import('../src/mcp/tools.mjs')
  const server = buildServer()
  const [clientT, serverT] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'atlas-worker-tools-test', version: '0' })
  await Promise.all([server.connect(serverT), client.connect(clientT)])
  const { tools } = await client.listTools()
  await client.close()
  await server.close()
  return tools.map((t) => t.name).sort()
}

test('KNOWLEDGE_ONLY yields exactly the vault/Atlas read tools', async () => {
  process.env.ATLAS_MCP_KNOWLEDGE_ONLY = '1'
  try {
    assert.deepEqual(await toolNames(), [
      'get_note', 'query_atlas', 'query_vault', 'recent_activity', 'wiki_graph', 'wiki_index', 'wiki_pages',
    ])
  } finally {
    delete process.env.ATLAS_MCP_KNOWLEDGE_ONLY
  }
})

test('KNOWLEDGE_ONLY drops agent control even if the control flag is somehow also set', async () => {
  process.env.ATLAS_MCP_KNOWLEDGE_ONLY = '1'
  process.env.ATLAS_AGENT_CONTROL = '1'
  try {
    const names = await toolNames()
    for (const t of ['spawn_agent', 'kill_agent', 'prompt_agent', 'ship_agent']) {
      assert.ok(!names.includes(t), `${t} must never reach the worker`)
    }
  } finally {
    delete process.env.ATLAS_MCP_KNOWLEDGE_ONLY
    delete process.env.ATLAS_AGENT_CONTROL
  }
})
