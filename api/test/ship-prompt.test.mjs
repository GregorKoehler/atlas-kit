/* ------------------------------------------------------------------ *
 * ONE ship instruction, one entry point (ship-prompt.mjs + agent-routes.mjs).
 *
 * The bug this exists for: the good ship wording lived client-side and only the
 * Ship BUTTONS used it. An agent merely TOLD to ship — an orchestrator's
 * queue_agent, the operator typing "ship it" — fell back to the spawn-time
 * "Ship protocol", which never mentioned waiting for the required checks, never
 * deferred to the repo's own rules and carried no delivery tail. So the
 * INVARIANT under test is: the instruction the spawn preamble carries and the
 * one POST /api/agents/ship builds are the SAME STRING. If this test ever needs
 * loosening, the wording has been forked back into two sources of truth.
 *
 * Also pinned: the delivery modes stay DERIVED from the project page's flags, no
 * repo's own merge rules leak into the wording, no ship-related prompt hardcodes
 * a branch name, the spawn preamble still emits both ATLAS markers and the
 * worktree guardrail, and the orchestrator preamble names `ship_agent` — an
 * orchestrator that never hears of it reaches for `merge_pr` and bypasses the
 * whole unified path.
 *
 * Hermetic: AGENT_LOCAL_DIR/WORKSPACE_DIR sandbox agent-local.mjs away from any
 * real state, VAULT_PATH points at an empty dir so listProjects() finds nothing
 * and the resolvers take their documented fallbacks. The only git that runs is
 * against a throwaway repo made here; no path reaches `gh` or the network.
 *
 * Run: node --test api/test/ship-prompt.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

process.env.AGENT_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-ship-prompt-local-'))
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.AGENT_LOCAL_DRIVE = '0'
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-ship-prompt-ws-'))
process.env.VAULT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-ship-prompt-vault-'))
process.env.VAULT_PATH = process.env.VAULT_DIR
process.env.VAULTS_FILE = path.join(process.env.VAULT_DIR, 'no-vaults.json')

const { deliveryMode, buildShipPrompt, shipProtocolSection, resolveDefaultBranch, FALLBACK_BRANCH } =
  await import('../src/ship-prompt.mjs')
const { reconcilePreamble, shipPromptFor, ATLAS_CONTROL_PREAMBLE } = await import('../src/agent-routes.mjs')

const MODES = ['self-deploy', 'manual', 'merge']

/* --- the mode is derived from the project page, never configured twice --- */

test('self_deploy → self-deploy (the dashboard deploys the merge itself)', () => {
  assert.equal(deliveryMode({ selfDeploy: true, deployManual: '' }), 'self-deploy')
})

test('deploy_manual → manual (a selective, not-per-PR redeploy delivers)', () => {
  assert.equal(deliveryMode({ deployManual: 'selective redeploy of the live instance' }), 'manual')
})

test('no flag → merge-is-delivery (the unchanged default)', () => {
  assert.equal(deliveryMode({ selfDeploy: false, deployManual: '' }), 'merge')
  assert.equal(deliveryMode({}), 'merge')
  assert.equal(deliveryMode(undefined), 'merge')
  assert.equal(deliveryMode(null), 'merge')
})

/* --- the wording ------------------------------------------------------- */

test('every mode carries the ship marker + the repo-rules/required-checks guard', () => {
  for (const mode of MODES) {
    const p = buildShipPrompt(mode, 'main')
    // ⚠️ Must stay in lockstep with SHIP_MARKER in subagent-scan.mjs.
    assert.match(p, /ATLAS:SHIPPED PR #<number> <merged SHA>/)
    assert.doesNotMatch(p, /GRAVIS/i)
    assert.match(p, /gh pr merge --merge/)
    // Defers to the repo's own protocol instead of restating any repo's rules…
    assert.match(p, /CLAUDE\.md and \.claude\/rules/)
    // …and never implies a clean rebase is enough to merge.
    assert.match(p, /wait for the required checks/)
    assert.match(p, /red or still pending/)
  }
})

test('the manual prompt says merged ≠ delivered and that the redeploy is not per-PR', () => {
  const p = buildShipPrompt('manual', 'main')
  assert.match(p, /Merging is NOT the delivery/)
  assert.match(p, /redeployed/)
  assert.match(p, /NOT run for every PR/)
  assert.match(p, /note in your reply that the merge still needs a deploy run/)
  assert.doesNotMatch(p, /no separate deploy run/)
})

test('the merge-is-delivery and self-deploy prompts keep their wording', () => {
  assert.match(buildShipPrompt('merge', 'main'), /Merging the PR is the delivery/)
  assert.match(buildShipPrompt('self-deploy', 'main'), /I deploy from the dashboard/)
})

/* --- no ship-related prompt hardcodes a branch name --------------------- */

test('the ship prompt merges into the branch it is given, never a hardcoded one', () => {
  for (const mode of MODES) {
    assert.match(buildShipPrompt(mode, 'trunk'), /rebase onto origin\/trunk/)
    assert.doesNotMatch(buildShipPrompt(mode, 'trunk'), /\bmaster\b|\bmain\b/)
  }
})

test('the spawn preamble (sync + ship protocol) hardcodes no branch either', () => {
  const preamble = reconcilePreamble({ mode: 'merge', branch: 'trunk' })
  assert.match(preamble, /git rebase origin\/trunk/)
  assert.doesNotMatch(preamble, /\bmaster\b/)
  assert.doesNotMatch(preamble, /\{defaultBranch\}|\{shipProtocol\}/) // every token filled in
})

test('the spawn preamble still carries BOTH ship markers, and the worktree guardrail', () => {
  // The producer half of the marker pair — subagent-scan.mjs's SHIP_MARKER is the
  // consumer (api/test/ship-marker.test.mjs). Change one without the other and
  // ship detection breaks silently.
  //
  // Note the READY marker is asserted as a substring, not `^…$`: the preamble
  // introduces it at the end of a bullet ("…end that reply with the line: X").
  // What must hold is that the exact marker TEXT the scanner looks for is the
  // text the agent is told to emit.
  const preamble = reconcilePreamble({ mode: 'merge', branch: 'main' })
  assert.match(preamble, /ATLAS:READY-TO-SHIP/)
  assert.match(preamble, /ATLAS:SHIPPED PR #<number> <merged SHA>/)
  assert.doesNotMatch(preamble, /GRAVIS/i)
  // …and the shared-checkout guardrail, with the executor's token left for it.
  assert.match(preamble, /\{worktree\}/)
  assert.match(preamble, /never edit, commit, or run git in it/)
})

/* --- THE INVARIANT ----------------------------------------------------- */

test('button-ship and told-to-ship are the SAME instruction, per mode', () => {
  for (const mode of MODES) {
    const instruction = buildShipPrompt(mode, 'main')
    // What the spawn preamble tells an agent that is TOLD to ship…
    assert.ok(shipProtocolSection(mode, 'main').endsWith(instruction))
    assert.ok(reconcilePreamble({ mode, branch: 'main' }).includes(instruction))
  }
})

test('the ship ROUTE builds that same instruction (no project → merge/fallback)', async () => {
  // '' is a repo the dashboard knows nothing about: no project page, no local
  // checkout, no GitHub slug — so both resolvers take their fallback and the
  // route's text must still be the canonical one, byte for byte.
  assert.equal(await shipPromptFor(''), buildShipPrompt('merge', FALLBACK_BRANCH))
  assert.ok(reconcilePreamble({ mode: 'merge', branch: FALLBACK_BRANCH }).includes(await shipPromptFor('')))
})

test('the orchestrator preamble points at ship_agent, not at merge_pr, for landing work', () => {
  // The last gap in the unified path: an orchestrator that never hears of
  // ship_agent reaches for merge_pr (or improvises a steer) and bypasses both
  // the canonical wording and the serial ship train.
  assert.match(ATLAS_CONTROL_PREAMBLE, /`ship_agent`/) // in the tool list…
  const ship = ATLAS_CONTROL_PREAMBLE.split('\n').find((l) => l.startsWith('- SHIP'))
  assert.ok(ship, 'no SHIP bullet in ATLAS_CONTROL_PREAMBLE')
  assert.match(ship, /`ship_agent` is the way/)
  assert.match(ship, /`queue_agent`\/`prompt_agent` is the fallback, not the default/)
  assert.match(ship, /refuses a stale\/conflicted\/blocked\/red\/pending one/)
})

/* --- default-branch resolution ----------------------------------------- */

test('an unresolvable repo falls back rather than guessing', async () => {
  assert.equal(await resolveDefaultBranch({}), FALLBACK_BRANCH)
  assert.equal(await resolveDefaultBranch({ repoPath: '/nonexistent-checkout-xyz' }), FALLBACK_BRANCH)
})

test("the checkout's own origin/HEAD wins — whatever it is called", async () => {
  // A repo whose default branch is neither master nor main: nothing may guess.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-ship-prompt-repo-'))
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', ['-C', repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'])
  assert.equal(await resolveDefaultBranch({ repoPath: repo }), 'trunk')
})
