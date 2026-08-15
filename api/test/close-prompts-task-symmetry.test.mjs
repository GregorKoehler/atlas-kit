/* ------------------------------------------------------------------ *
 * Teardown must be able to CLOSE a task, not only OPEN one.
 *
 * Every prompt that runs when a session is torn down used to be one-way: the
 * Atlas chat's close prompt never mentioned `Tasks/` at all, and both ingest
 * prompts + the paired worker's TASKS bullet said only how to FILE a task. So
 * the teardown path could add cards to the operator's Kanban and never retire
 * the one the work just completed — a structural source of task inflation,
 * independent of any agent forgetting.
 *
 * Two things must hold in all four, and both are prose the model reads:
 *   1. a CLOSE instruction sits next to the file-a-task one, keyed to EVIDENCE
 *      (merged + `status: done`), never to age — untouched is not the same as
 *      finished, and timer/inattention expiry is explicitly rejected;
 *   2. none of them tells an agent to stamp a `pr:` key on a task. It is
 *      provenance the board does not model, and some vault setups treat it as a
 *      live auto-close trigger.
 *
 * Hermetic: AGENT_LOCAL_DIR/WORKSPACE_DIR/VAULT_PATH sandbox the modules away
 * from any real state. No tmux, no git, no network.
 *
 * Run: node --test api/test/close-prompts-task-symmetry.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.AGENT_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-close-prompts-local-'))
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.AGENT_LOCAL_DRIVE = '0'
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-close-prompts-ws-')) // not a git repo
process.env.VAULT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-close-prompts-vault-'))
process.env.VAULT_PATH = process.env.VAULT_DIR
process.env.VAULTS_FILE = path.join(process.env.VAULT_DIR, 'no-vaults.json')

const { ATLAS_KNOWLEDGE_CLOSE_PROMPT, atlasIngestPrompt, atlasIngestPromptRemote } = await import('../src/agent-local.mjs')
const { ATLAS_WORKER_PREAMBLE } = await import('../src/agent-routes.mjs')

const dev = { id: 'dev-1', branch: 'agent/x', worktree: '/tmp/x', task: 'do a thing' }
const SITES = [
  ['ATLAS_KNOWLEDGE_CLOSE_PROMPT', ATLAS_KNOWLEDGE_CLOSE_PROMPT],
  ['atlasIngestPrompt', atlasIngestPrompt('recap', dev)],
  ['atlasIngestPromptRemote', atlasIngestPromptRemote('recap', dev)],
  ['ATLAS_WORKER_PREAMBLE', ATLAS_WORKER_PREAMBLE],
]

// The close prompt announces how many steps it has and then enumerates them. A
// stale count is not cosmetic: told "two things" and handed three, a model skips
// the last one — which here is the whole close-a-task instruction.
test('ATLAS_KNOWLEDGE_CLOSE_PROMPT announces as many steps as it enumerates', () => {
  const WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5 }
  const announced = ATLAS_KNOWLEDGE_CLOSE_PROMPT.match(/— (one|two|three|four|five) things\./)
  assert.ok(announced, 'the prompt no longer announces a step count')
  const ordinals = ['FIRST,', 'SECOND,', 'THIRD,', 'FOURTH,', 'FIFTH,'].filter((o) =>
    ATLAS_KNOWLEDGE_CLOSE_PROMPT.includes(o),
  ).length
  assert.equal(WORDS[announced[1]], ordinals, `announces "${announced[1]} things" but enumerates ${ordinals}`)
})

for (const [name, prompt] of SITES) {
  test(`${name} tells the agent to close a finished task, on evidence`, () => {
    assert.match(prompt, /\bTasks\//, `${name} never mentions Tasks/ at all`)
    assert.match(prompt, /CLOSE(D)? BEFORE YOU FILE|CLOSED an open one/i, `${name} has no close-before-you-file instruction`)
    // Evidence, not age: the close is keyed to a merged PR and a status flip.
    assert.match(prompt, /evidence/i, `${name} does not key the close to evidence`)
    assert.match(prompt, /merged/i, `${name} does not require the work to be merged`)
    assert.match(prompt, /status:? .?done|status.{0,12}not .?done/i, `${name} never names the done status`)
  })

  test(`${name} never tells the agent to age a task out`, () => {
    // Timer/inattention expiry is rejected: untouched ≠ finished.
    assert.doesNotMatch(prompt, /stale|untouched|older than|aged? out/i, `${name} suggests expiring tasks by age`)
  })

  test(`${name} never instructs stamping a pr: key`, () => {
    // Mentioning `pr:` is fine ONLY as a prohibition.
    for (const line of prompt.split(/(?<=[.;])\s+/)) {
      if (!/\bpr:/.test(line)) continue
      assert.match(line, /never|not provenance|do not/i, `${name} mentions pr: outside a prohibition: ${line}`)
    }
  })
}
