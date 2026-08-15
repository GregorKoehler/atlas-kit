/* ------------------------------------------------------------------ *
 * The contribution-log rule must live in BOTH Atlas preambles, not in the prose
 * of one project page: a dev agent cannot write the vault at all, so its PAIRED
 * Atlas worker is the only automatic path from its work into a project's
 * contribution list, and the operator-chatted Atlas orchestrator is the manual
 * one. The rule keys off the TYPED `contribution_log:` frontmatter field, so it
 * stays generic across projects and vaults.
 *
 * Hermetic: AGENT_LOCAL_DIR/WORKSPACE_DIR sandbox agent-local.mjs (imported
 * transitively by agent-routes.mjs) away from the real box state — the same
 * convention agent-model-default.test.mjs uses.
 *
 * Run: node --test api/test/atlas-contribution-log.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.AGENT_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-contrib-log-local-'))
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-contrib-log-ws-')) // not a git repo

const { ATLAS_KNOWLEDGE_PREAMBLE, ATLAS_WORKER_PREAMBLE } = await import('../src/agent-routes.mjs')

for (const [name, preamble] of [
  ['ATLAS_KNOWLEDGE_PREAMBLE', ATLAS_KNOWLEDGE_PREAMBLE],
  ['ATLAS_WORKER_PREAMBLE', ATLAS_WORKER_PREAMBLE],
]) {
  test(`${name} carries the contribution_log rule`, () => {
    // Assert on the RULE, not on words that appear elsewhere in the preamble:
    // the line keyed to the typed field must itself say append-only + section.
    const rule = preamble.split('\n').find((l) => l.includes('contribution_log:'))
    assert.ok(rule, `${name} never mentions the contribution_log: field`)
    assert.match(rule, /append-only/i) // never rewrite existing lines
    assert.match(rule, /section/i) // append into the fitting section, not end-of-file
  })
}
