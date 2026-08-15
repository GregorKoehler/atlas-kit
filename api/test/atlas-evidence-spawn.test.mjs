/* ------------------------------------------------------------------ *
 * Atlas EVIDENCE at spawn — the retrieval reaches the dev agent's opening
 * prompt, and nothing about it can ever cost a spawn.
 *
 * It replaces a paired-worker LLM brief that reached a small minority of
 * sessions (the synthesis on top of this same retrieval took tens of seconds and
 * timed out), and the late ones landed minutes-to-hours in. The retrieval
 * underneath it is sub-second. So the value of this change lives entirely in it
 * being UNCONDITIONAL, which is what these tests pin:
 *
 *   1. the evidence is in the prompt, and with none the prompt is BYTE-IDENTICAL
 *      to an unbriefed spawn (no regression on the common path);
 *   2. every failure mode — no atlas, no project, unknown repo, a retrieval that
 *      throws — yields '' and spawns cleanly, never an exception;
 *   3. the byte cap is honoured and the audit line is written (the design this
 *      replaces failed invisibly for weeks for exactly the want of that line);
 *   4. the REMOTE clipped path fits the bridge's tmux ceiling. A bridge without
 *      the prompt-file transport shquotes the whole prompt into its tmux command,
 *      and overflowing that is a silent `command too long`.
 *
 * Run: node --test api/test/atlas-evidence-spawn.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-evidence-local-'))
process.env.AGENT_LOCAL_DIR = STATE_DIR
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-evidence-ws-'))
// "No Atlas is configured" must be a FACT THIS TEST SETS, never an accident of
// the machine. `atlasEvidence()` with no explicit root falls back to the vault
// registry, so the case below would otherwise mean "no atlas" only where
// `api/src/vaults.json` happens to be absent — true on a CI runner, false on a
// box, where it would retrieve the real Atlas and fail the assertion. Point the
// registry at a path that does not exist and the case holds identically in both.
// Must precede the import: vaults.mjs reads VAULTS_FILE at module load.
process.env.VAULTS_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-evidence-reg-')), 'no-vaults.json')
// …and with the registry pointed at nothing, the single-vault fallback would
// still resolve `atlas` to VAULT_PATH. Point that at nothing too.
process.env.VAULT_PATH = path.join(os.tmpdir(), 'atlas-kit-evidence-no-such-vault')

const { devPrompt, atlasEvidence, TMUX_MAX_COMMAND_BYTES } = await import('../src/agent-local.mjs')
const { EVIDENCE_MAX_BYTES, EVIDENCE_FRAMING_BYTES } = await import('../src/atlas-candidates.mjs')
const { remoteEvidenceBudget } = await import('../src/agent-routes.mjs')

/* --- fixture Atlas -------------------------------------------------- */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-evidence-atlas-'))
const write = (rel, body) => {
  const abs = path.join(ROOT, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}
write('Wiki/Projects/Widget-Dashboard.md', `---\ntype: project\nagent_repo: widget\n---\n\n# Widget Dashboard\n\nIt already emits \`contextTokens\`.\n`)
write('Wiki/Concepts/Context-Meter.md', `---\ntype: concept\n---\n\n# Context meter\n\nThe \`contextTokens\` field is emitted by scanContextTokens.\n`)
// Bulk filler: IDF needs a corpus, and below ~1/DF_CEILING pages every term is
// "common" and scores zero — a two-page fixture retrieves nothing at all.
for (let i = 0; i < 40; i++) write(`Wiki/Sources/filler-${i}.md`, `---\ntype: source\n---\n\n# Filler ${i}\n\nA page about dashboards and agents and cards.\n`)
const EMPTY = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-evidence-empty-'))

const TASK = 'Render the contextTokens field on the agent card'
const auditLines = () =>
  fs
    .readFileSync(path.join(STATE_DIR, 'audit.log'), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

/* --- 1. the evidence reaches the prompt, and its absence changes nothing --- */
test('the evidence block is folded between the preamble and the task', async () => {
  const block = await atlasEvidence({ task: TASK, repo: 'widget', root: ROOT })
  const prompt = devPrompt({ id: 'a1', task: TASK, repo: 'widget', preamble: 'STANDING RULES', context: block, worktree: '/wt' })
  assert.ok(block.length > 0, 'the fixture Atlas must produce evidence')
  assert.match(prompt, /^STANDING RULES\n\n## Atlas evidence for this task/)
  assert.match(prompt, /Context-Meter\.md/) // a retrieved page, not just the framing
  assert.ok(prompt.indexOf(block) < prompt.indexOf('# Your task'), 'evidence must precede the task')
})

test('with NO evidence the prompt is byte-identical to an unbriefed spawn', () => {
  const args = { id: 'a1', task: TASK, repo: 'widget', preamble: 'STANDING RULES', worktree: '/wt' }
  const unbriefed = devPrompt({ ...args })
  for (const context of ['', null, undefined]) assert.equal(devPrompt({ ...args, context }), unbriefed)
  assert.equal(unbriefed, `STANDING RULES\n\n---\n# Your task\n${TASK}`)
})

/* --- 2. a spawn can never fail because of the Atlas ------------------ */
test('every retrieval failure degrades to no evidence, never to a throw', async () => {
  // A retrieval that throws (a root that is not a path at all), an Atlas with no
  // pages, and — the configured-nowhere case — no atlas root to resolve (the
  // registry and VAULT_PATH are pinned to nonexistent paths at the top of this
  // file, so this is the CODE's fallback being tested, not the machine's).
  assert.equal(await atlasEvidence({ task: TASK, repo: 'widget', root: 42 }), '')
  assert.equal(await atlasEvidence({ task: TASK, repo: 'widget', root: EMPTY }), '')
  assert.equal(await atlasEvidence({ task: TASK, repo: 'widget' }), '')
  const thrown = auditLines().find((l) => l.action === 'atlas-evidence' && l.ok === false)
  assert.ok(thrown && thrown.error, 'a retrieval that throws must still be audited, with its reason')
})

/* THE CONTRACT for a repo with no project page: the evidence block is still
 * returned, minus its `## Project —` section. A repo the Atlas has never heard of
 * is the common case for a new project, and the catalog/full-text hits are exactly
 * as useful there as anywhere — it is "no project page", not "no knowledge". The
 * block is self-describing (`Project: none matched for repo X`), so a reader is
 * never misled. Asserted against the FIXTURE Atlas above, so it is a real
 * assertion on every machine rather than one the absence of a vault can satisfy. */
test('an unknown repo (no project page) still retrieves the full-text half', async () => {
  const block = await atlasEvidence({ task: TASK, repo: 'no-such-repo', root: ROOT })
  assert.ok(block.length > 0)
  assert.doesNotMatch(block, /## Project —/)
  assert.match(block, /Context-Meter\.md/)
  assert.equal(auditLines().findLast((l) => l.action === 'atlas-evidence' && l.ok).project, null)
})

test('an empty task cannot produce a block (nothing to retrieve on)', async () => {
  assert.equal(await atlasEvidence({ task: '', repo: 'widget', root: ROOT }), '')
})

/* --- 3. capped, and measurable -------------------------------------- */
test('the cap is enforced, and the framing is budgeted on top of it', async () => {
  const full = await atlasEvidence({ task: TASK, repo: 'widget', root: ROOT })
  assert.ok(full.length - EVIDENCE_FRAMING_BYTES <= EVIDENCE_MAX_BYTES)
  const small = await atlasEvidence({ task: TASK, repo: 'widget', root: ROOT, maxBytes: 900 })
  assert.ok(small.length > 0 && small.length - EVIDENCE_FRAMING_BYTES <= 900, `capped block was ${small.length} B`)
  // EVIDENCE_FRAMING_BYTES is derived from the framing itself, so it can't drift.
  assert.equal(EVIDENCE_FRAMING_BYTES, full.length - full.slice(full.indexOf('# Atlas evidence (retrieved')).length)
})

test('every spawn writes ONE audit line carrying bytes, ms, sections and the project', async () => {
  const before = auditLines().length
  await atlasEvidence({ task: TASK, repo: 'widget', root: ROOT, slug: 'render-the-contexttokens-field' })
  const lines = auditLines().slice(before).filter((l) => l.action === 'atlas-evidence')
  assert.equal(lines.length, 1)
  const l = lines[0]
  assert.equal(l.kind, 'dev')
  assert.equal(l.id, 'render-the-contexttokens-field')
  assert.equal(l.repo, 'widget')
  assert.equal(l.project, 'Widget-Dashboard')
  assert.ok(l.ok && l.block > 0 && l.bytes > 0 && l.sections > 0 && typeof l.ms === 'number')
})

/* --- 4. the remote clipped path fits the bridge's tmux command ------- */
test('the remote budget keeps a full-size prompt under the bridge tmux ceiling', () => {
  // The real remote preamble is a large share of the ~16 KB ceiling; whatever is
  // left is what the evidence may weigh, AFTER shell-quoting growth.
  const quoted = (s) => Buffer.byteLength(s) + 3 * (s.match(/'/g)?.length || 0)
  const preamble = "STANDING RULES — the operator's own wording, with apostrophes. ".repeat(140)
  const base = quoted(`${preamble}\n\n---\n# Your task\n${TASK}`)
  const budget = remoteEvidenceBudget(base)
  assert.ok(budget > 0 && budget < EVIDENCE_MAX_BYTES, `budget ${budget} must be positive and below the box cap`)
  // Worst case: every budgeted byte spent, and pathologically quote-heavy.
  const worst = "'".repeat(Math.floor(budget / 4)) + 'x'.repeat(budget - Math.floor(budget / 4))
  assert.ok(base + quoted(worst) < TMUX_MAX_COMMAND_BYTES, 'a fully-spent budget must still fit the tmux command')
})

test('a prompt already at the ceiling gets no evidence rather than a failed spawn', () => {
  assert.equal(remoteEvidenceBudget(TMUX_MAX_COMMAND_BYTES), 0)
  assert.equal(remoteEvidenceBudget(TMUX_MAX_COMMAND_BYTES - 2000), 0) // below the useful minimum
  assert.ok(remoteEvidenceBudget(9000) > 1200)
})
