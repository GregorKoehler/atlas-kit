/* ------------------------------------------------------------------ *
 * The spawn-time model/effort DEFAULTS, and — the point — their SCOPING:
 *   - knowledge/Atlas chats           → Opus at xhigh
 *   - dev agents spawned via the MCP `spawn_agent` tool (i.e. BY an Atlas
 *     orchestrator)                   → Sonnet at high
 *   - the dashboard's OWN dev spawn   → Sonnet at xhigh (the regression guard
 *     that proves the scoping held; the dev dropdown stays on the cheaper,
 *     faster model).
 *
 * The real resolvers are under test — spawnPicks (agent-routes.mjs: the route's
 * kind-aware default) and spawnBody (mcp/tools.mjs: the MCP tool's explicit dev
 * default, passed because the route can't tell its two dev callers apart).
 *
 * Hermetic: AGENT_LOCAL_DIR/WORKSPACE_DIR point agent-local.mjs (imported
 * transitively by agent-routes.mjs) at throwaway temp dirs, and
 * AGENT_LOCAL_RECONCILE=0 keeps the boot reconciler from touching tmux or git.
 * No vault, no repo, no network.
 *
 * Run: node --test api/test/agent-model-default.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.AGENT_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-model-default-local-'))
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-model-default-ws-')) // not a git repo

const { spawnPicks } = await import('../src/agent-routes.mjs')
const { spawnBody } = await import('../src/mcp/tools.mjs')

// agent-routes.mjs froze AGENT_EXTENDED_CONTEXT at import; recompute the suffix
// the same way so these assertions hold with the kill-switch either way.
const CTX = /^(0|false|no|off)$/i.test(process.env.AGENT_EXTENDED_CONTEXT || '') ? '' : '[1m]'

test('knowledge/Atlas spawn with no model/effort → Opus at xhigh', () => {
  assert.deepEqual(spawnPicks({ kind: 'knowledge' }), {
    modelId: `claude-opus-5${CTX}`,
    effortLevel: 'xhigh',
  })
})

test('REGRESSION: the dashboard dev spawn (no model/effort) still resolves Sonnet', () => {
  // The dashboard's own dev-agent dropdown is deliberately NOT part of the Opus
  // default — this is the guard that the scoping held. Both the route fallback…
  assert.deepEqual(spawnPicks({}), { modelId: `claude-sonnet-5${CTX}`, effortLevel: 'xhigh' })
  assert.deepEqual(spawnPicks({ kind: 'dev' }), { modelId: `claude-sonnet-5${CTX}`, effortLevel: 'xhigh' })
  // …and the dropdown's own default, which is what the card actually sends.
  const list = fs.readFileSync(new URL('../../web/src/components/cards/AgentList.tsx', import.meta.url), 'utf8')
  assert.match(list, /const \[model, setModel\] = useState\('sonnet'\)/)
})

test('MCP spawn_agent (dev) with no model/effort → Sonnet at high', () => {
  const body = spawnBody({ task: 'fix the thing', repo: 'demo-repo' })
  assert.equal(body.model, 'sonnet') // passed EXPLICITLY, not left to the route
  assert.equal(body.effort, 'high')
  assert.deepEqual(spawnPicks(body), { modelId: `claude-sonnet-5${CTX}`, effortLevel: 'high' })
})

test('MCP spawn_agent (knowledge) sends no model/effort — it inherits the route default', () => {
  const body = spawnBody({ task: 'what do we know about X', kind: 'knowledge', vault: 'atlas' })
  assert.equal(body.model, undefined)
  assert.equal(body.effort, undefined)
  assert.equal(body.vault, 'atlas')
  assert.deepEqual(spawnPicks(body), { modelId: `claude-opus-5${CTX}`, effortLevel: 'xhigh' })
})

test('explicit picks still override in every path', () => {
  assert.equal(spawnPicks({ model: 'sonnet', kind: 'knowledge' }).modelId, `claude-sonnet-5${CTX}`)
  assert.equal(spawnPicks({ model: 'fable', kind: 'knowledge' }).modelId, `claude-fable-5${CTX}`)
  assert.equal(spawnPicks({ model: 'fable' }).modelId, `claude-fable-5${CTX}`)
  assert.equal(spawnPicks({ effort: 'max', kind: 'knowledge' }).effortLevel, 'max')
  // …and through the MCP tool, for a dev agent and a knowledge agent alike.
  assert.equal(spawnPicks(spawnBody({ task: 't', repo: 'demo-repo', model: 'sonnet', effort: 'max' })).modelId, `claude-sonnet-5${CTX}`)
  assert.equal(spawnPicks(spawnBody({ task: 't', repo: 'demo-repo', model: 'sonnet', effort: 'max' })).effortLevel, 'max')
  assert.equal(spawnPicks(spawnBody({ task: 't', kind: 'knowledge', model: 'fable' })).modelId, `claude-fable-5${CTX}`)
})

test('the spawn lineage parent is stamped only when the orchestrator env is set', () => {
  assert.equal(spawnBody({ task: 't', repo: 'demo-repo' }).parent, undefined)
  assert.equal(spawnBody({ task: 't', repo: 'demo-repo', parent: 'atlas-sid' }).parent, 'atlas-sid')
})

test('AGENT_EXTENDED_CONTEXT=0 is the [1m] kill-switch — on every model', async () => {
  const prev = process.env.AGENT_EXTENDED_CONTEXT
  process.env.AGENT_EXTENDED_CONTEXT = '0'
  // The suffix is frozen at module init, so re-import with a cache-busting query
  // to get a fresh instance under the flag (its own imports stay cached).
  const off = await import('../src/agent-routes.mjs?extended-context=off')
  assert.equal(off.spawnPicks({ kind: 'knowledge' }).modelId, 'claude-opus-5')
  assert.equal(off.spawnPicks({}).modelId, 'claude-sonnet-5')
  assert.equal(off.spawnPicks({ model: 'fable' }).modelId, 'claude-fable-5')
  if (prev === undefined) delete process.env.AGENT_EXTENDED_CONTEXT
  else process.env.AGENT_EXTENDED_CONTEXT = prev
})
