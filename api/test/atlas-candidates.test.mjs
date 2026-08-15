/* ------------------------------------------------------------------ *
 * Server-side Atlas retrieval at spawn (api/src/atlas-candidates.mjs).
 *
 * The evidence a dev agent opens with used to be 7-14 model-driven discovery
 * turns, starting with a hand-read of a several-hundred-KB `Wiki/index.md`. The
 * dashboard now does the retrieval itself and hands the agent a candidate set.
 * Four things have to hold, and none of them shows up as a failure at runtime —
 * a bad candidate set just produces a confidently thin start:
 *
 *   1. the candidate set is BUILT (project, its open tasks, hits, index lines)
 *      and CAPPED (a 200 KB prompt would move the cost from turns into tokens);
 *   2. ranking is driven by the SELECTIVE terms — a function word that happens to
 *      be rare in a technical corpus must not decide what the agent reads;
 *   3. nothing still sends the agent to `Wiki/index.md`;
 *   4. closed work is DEMOTED, not hidden.
 *
 * Runs against a throwaway fixture Atlas, so no box state and no real vault.
 * Run: node --test api/test/atlas-candidates.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.AGENT_LOCAL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-cand-local-'))
process.env.AGENT_LOCAL_RECONCILE = '0'
process.env.WORKSPACE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-cand-ws-'))

const { buildCandidates, taskTerms, resolveProject, evidencePrompt, isClosedTask, EVIDENCE_MAX_BYTES, DONE_WEIGHT, SECTION_LEVERS } = await import('../src/atlas-candidates.mjs')

/* --- fixture Atlas -------------------------------------------------- */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-cand-atlas-'))
const write = (rel, body) => {
  const abs = path.join(ROOT, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

write(
  'Wiki/Projects/Widget-Dashboard.md',
  `---\ntype: project\ntags: [widget, dashboard]\nstatus: doing\nagent_repo: widget\ndepends_on: ["[[Sprocket]]"]\n---\n\n# Widget Dashboard\n\nThe widget dashboard. It already emits \`contextTokens\` from the scanner.\n`,
)
// A decoy that merely carries `widget` among its tags: it must never outrank the
// page whose `agent_repo` IS the repo key (this exact shape beat the right page
// when the resolver was first-match-wins).
write('Wiki/Projects/Aardvark-Kit.md', `---\ntype: project\ntags: [aardvark, widget]\n---\n\n# Aardvark Kit\n\nUnrelated.\n`)
write(
  'Tasks/render-the-context-meter.md',
  `---\ntype: task\nstatus: next\nfor_project: "[[Widget-Dashboard]]"\ndue: 2026-08-01\n---\n\nRender the contextTokens meter on the card.\n`,
)
write(
  'Tasks/already-shipped-thing.md',
  `---\ntype: task\nstatus: done\nfor_project: "[[Widget-Dashboard]]"\n---\n\nShipped contextTokens plumbing.\n`,
)
// In flight, no due date, and blocked on something: sorting by `due` alone put it
// last, which is where the "another agent is live in these files" signal died.
write(
  'Tasks/live-refactor.md',
  `---\ntype: task\nstatus: doing\nfor_project: "[[Widget-Dashboard]]"\ndepends_on: ["[[Sprocket]]"]\n---\n\nsomeone else is in these files right now.\n`,
)
write(
  'Wiki/Concepts/Context-Meter.md',
  `---\ntype: concept\nfor_project: "[[Widget-Dashboard]]"\n---\n\n# Context meter\n\nThe \`contextTokens\` field is emitted by scanContextTokens and already wired through GET /api/agents.\n`,
)
write(
  'Wiki/index.md',
  `---\ntype: index\n---\n\n# Index\n\n- [[Context-Meter]] — the contextTokens meter and where it comes from.\n- [[Unrelated-Page]] — nothing to do with this.\n` +
    // Enough MATCHING catalog lines for a cap to be measurable — keyed on a term
    // only the section-cut fixture task uses (§6), so every test above sees the
    // same two matching lines it always did.
    Array.from({ length: 30 }, (_, i) => `- [[Sprocket-${i}]] — a sprocket throttle catalog line, number ${i}.\n`).join('') +
    '- [[Filler]] — filler line.\n'.repeat(200),
)
write(
  'Wiki/log.md',
  `---\ntype: log\n---\n\n## [2026-07-01] ingest | something else\n\nUnrelated work.\n\n` +
    `## [2026-07-02] ingest | contextTokens meter\n\nWired the contextTokens field through the agents API.\n\n` +
    // Hazard ops: one on this project (selected), one on another (not), plus a
    // routine `ingest` naming this project (not a hazard).
    `## [2026-07-03] regression | [[Widget-Dashboard]] the meter broke\n\nbody text of the regression, which must not be quoted.\n\n` +
    `## [2026-07-04] regression | [[Aardvark-Kit]] unrelated breakage\n\nNot this project.\n\n` +
    `## [2026-07-05] ingest | [[Widget-Dashboard]] routine note\n\nNot a hazard op.\n`,
)
// Bulk filler so IDF has a corpus to work against.
for (let i = 0; i < 60; i++) write(`Wiki/Sources/filler-${i}.md`, `---\ntype: source\n---\n\n# Filler ${i}\n\nA page about dashboards and agents and cards, beside many other things.\n`)
/* --- the closed-work corner of the fixture ---------------------------- *
 * Three shapes with the score ratios a LIVE vault actually shows, because the
 * toll is a ratio and a fixture that ignores that would prove nothing:
 *   live page          the baseline the others have to beat
 *   templated ×3       `deploy-verify-*` checklists — closed, and ahead of the
 *                      live page on GENERIC vocabulary alone (~1.25×, in the
 *                      0.88-1.42× band real closed hits sit in)
 *   canonical record   closed, but ~2× the live page: it carries the task's
 *                      rare terms AND how the thing was actually solved */
const OVERLAY_TASK = 'Make the sprocket throttle render the jitter overlay on the widget card without the wobble clamp'
write('Wiki/Concepts/Jitter-Overlay.md', `---\ntype: concept\n---\n\n# Jitter overlay\n\nThe jitter overlay is rendered by the widget compositor.\n`)
for (let i = 0; i < 3; i++)
  write(
    `Tasks/deploy-verify-overlay-pr-${400 + i}.md`,
    `---\ntype: task\nstatus: done\nfor_project: "[[Widget-Dashboard]]"\n---\n\nDeploy-verify: the jitter overlay renders on the widget card. Overlay renders, card renders, throttle shows.\n`,
  )
write(
  'Tasks/how-the-sprocket-throttle-was-fixed.md',
  `---\ntype: task\nstatus: done\nfor_project: "[[Widget-Dashboard]]"\n---\n\nThe sprocket throttle jitter was fixed by clamping the overlay render in the widget compositor — the wobble came from the clamp running a frame late.\n`,
)

const TASK = 'Render the contextTokens field beside the phase chip on the agent card'

/* --- 1. the candidate set is built and capped ----------------------- */
test('the candidate set carries the project, its OPEN tasks, hits and index lines', async () => {
  const { text, stats } = await buildCandidates({ task: TASK, repo: 'widget', root: ROOT })
  assert.equal(stats.project, 'Widget-Dashboard')
  assert.match(text, /## Project — \[\[Widget-Dashboard\]\]/)
  assert.match(text, /agent_repo: widget/) // the page's typed frontmatter, verbatim
  // Typed lookup (queryAtlas, `for_project`) — open tasks only, done ones dropped.
  const openTasks = text.slice(text.indexOf('## Open Tasks/'), text.indexOf('## `Wiki/index.md`'))
  assert.match(openTasks, /Render the contextTokens meter on the card/)
  assert.doesNotMatch(openTasks, /already-shipped-thing/)
  // Full-text half: the concept page, excerpted — not just named.
  assert.match(text, /Wiki\/Concepts\/Context-Meter\.md/)
  assert.match(text, /emitted by scanContextTokens/)
  // index.md by LINE, never whole: its relevant line is in, its 200 filler lines are not.
  assert.match(text, /the contextTokens meter and where it comes from/)
  assert.ok(!/Filler\]\] — filler line/.test(text), 'index.md filler lines must not be pasted in')
})

test('the injected evidence is capped in bytes', async () => {
  const { text } = await buildCandidates({ task: TASK, repo: 'widget', root: ROOT })
  assert.ok(text.length <= EVIDENCE_MAX_BYTES, `evidence ${text.length} B over the ${EVIDENCE_MAX_BYTES} B cap`)
  const small = await buildCandidates({ task: TASK, repo: 'widget', root: ROOT, maxBytes: 1500 })
  assert.ok(small.text.length <= 1500, `evidence ${small.text.length} B over the explicit 1500 B cap`)
  assert.ok(small.text.length > 0, 'a small budget still yields the highest-priority section')
})

test('an unknown repo still retrieves — it just has no project section', async () => {
  const { text, stats } = await buildCandidates({ task: TASK, repo: 'no-such-repo', root: ROOT })
  assert.equal(stats.project, null)
  assert.doesNotMatch(text, /## Project —/)
  assert.match(text, /Wiki\/Concepts\/Context-Meter\.md/) // the full-text half is unaffected
})

/* --- 2. selectivity ------------------------------------------------- */
test('function words are dropped, including ones that are RARE in a technical corpus', () => {
  const terms = taskTerms('Render the contextTokens field beside the phase chip, whether or not it already exists')
  assert.ok(terms.includes('contexttokens'))
  assert.ok(terms.includes('render'))
  // "beside" is rare enough in a technical corpus to score like an identifier,
  // and on its own it pulled an unrelated task to the top of the ranking.
  for (const w of ['beside', 'whether', 'already', 'the', 'not', 'it', 'or'])
    assert.ok(!terms.includes(w), `"${w}" is a function word and must not be a search term`)
})

test('GERMAN function words are dropped too — a vault is routinely mixed-language', () => {
  // A pasted German mail. The scorer is IDF-based, so a German function word is
  // RARE in a mostly-English corpus and scores like an identifier: measured on
  // this shape of input, 15 of 32 term slots went to words like these.
  const terms = taskTerms(
    'Hallo, wir haben besprochen dass die Vorschau-Umgebungen für jeden Pull Request noch nicht laufen. Kannst du bitte nachschauen ob die Datenbank angelegt wird? Wäre gut wenn du mir bis Freitag Bescheid gibst.',
  )
  for (const w of ['wir', 'haben', 'dass', 'die', 'für', 'jeden', 'noch', 'nicht', 'kannst', 'wird', 'wäre', 'wenn', 'bis'])
    assert.ok(!terms.includes(w), `"${w}" is a German function word and must not be a search term`)
  // …and the CONTENT words survive. A stoplist that guesses at content words is
  // worse than no stoplist at all.
  for (const w of ['vorschau', 'umgebungen', 'datenbank', 'nachschauen', 'freitag', 'bescheid'])
    assert.ok(terms.includes(w), `"${w}" is a content word and must stay a search term`)
})

test('umlauts are letters, not separators — the fragments were scoring as identifiers', () => {
  const terms = taskTerms('Bitte prüfe die Gebäudegeometrie und ob die Nebenkostenabrechnung betroffen ist')
  assert.ok(terms.includes('prüfe'))
  assert.ok(terms.includes('gebäudegeometrie'))
  assert.ok(terms.includes('nebenkostenabrechnung'))
  // Splitting on [^A-Za-z0-9_] turned `Gebäudegeometrie` into `geb` +
  // `udegeometrie` and `prüfe` into nothing at all — and those fragments are
  // unique in the corpus, so IDF ranked them like a product name and let them
  // anchor the excerpts.
  for (const frag of ['geb', 'udegeometrie', 'ufe', 'fe']) assert.ok(!terms.includes(frag), frag)
})

/* The METACOGNITIVE class — the third stoplist bug family. These words describe
 * the ASKER's memory state, not the subject, and they are RARE in a corpus of
 * logs and specs for exactly the reason they are common in questions ("nobody
 * writes 'I tried' in a changelog"), so the rarest-first ordering PROMOTES them.
 * Measured on a real question of this shape: `tried`, `remember` and `finished`
 * were all rarer than its subject words, and most of the keyword excerpts came
 * back unusable. */
test('metacognitive words are dropped — they outranked the subject of the question', () => {
  const terms = taskTerms(
    'I want to create a forwarding mailbox under my own domain which my partner can use. ' +
      'How do I create one that forwards to her? I think I tried doing so in the past but don’t remember if we finished setting it up',
  )
  for (const w of ['think', 'tried', 'remember', 'finished', 'past'])
    assert.ok(!terms.includes(w), `"${w}" describes the asker's memory, not the subject, and must not be a search term`)
  // …and the SUBJECT of the question survives, which is the whole point.
  for (const w of ['forwarding', 'mailbox', 'domain', 'partner', 'forwards'])
    assert.ok(terms.includes(w), `"${w}" is what the question is ABOUT and must stay a search term`)
})

test('German metacognitive words too — a rare German word scores like an identifier here', () => {
  const terms = taskTerms('Ich glaube ich habe vielleicht vergessen die Nebenkostenabrechnung zu prüfen, vermutlich ist das irgendwie liegengeblieben')
  for (const w of ['glaube', 'vielleicht', 'vergessen', 'vermutlich', 'irgendwie']) assert.ok(!terms.includes(w), `"${w}" must not be a search term`)
  for (const w of ['nebenkostenabrechnung', 'prüfe', 'liegengeblieben']) assert.ok(terms.some((t) => t.startsWith(w.slice(0, 6))), `content word lost: ${w}`)
})

/* ⚠️ THE COMPLEMENT, and it guards the more expensive mistake. Every word here
 * LOOKS metacognitive and has a live CONTENT sense in a dev vault, so stoplisting
 * it would make a real topic unreachable — the matcher is a substring test, so
 * there is no second route to it. Someone "completing" the list later is the
 * exact failure this pins. See the ⚠️ block beside STOP for each word's evidence. */
test('look-alike words with a live content sense are deliberately NOT stoplisted', () => {
  const kept = {
    recall: 'What is the recall of the reranker on the blessed set?', // a retrieval metric
    forget: 'Make the ingest step fire-and-forget so the request returns early', // fire-and-forget, LSTM forget gate
    thought: 'Log the chain-of-thought tokens separately from the answer tokens', // chain-of-thought
    finish: 'Wire the finish button so the trip flushes to the vault', // a live route/button name
    setting: 'Expose the idle-eviction setting so the operator can raise it', // a noun, not the verb
  }
  for (const [word, task] of Object.entries(kept))
    assert.ok(taskTerms(task).includes(word), `"${word}" has a live content sense in a dev vault and must stay searchable`)
})

test('an ENGLISH task is byte-identical — the German list must not touch it', () => {
  const before = ['render', 'contexttokens', 'field', 'phase', 'chip', 'exists']
  const terms = taskTerms('Render the contextTokens field beside the phase chip, whether or not it already exists')
  assert.deepEqual(terms, before)
})

test('the top hit is the page that matches the SELECTIVE term', async () => {
  const { text } = await buildCandidates({ task: TASK, repo: 'widget', root: ROOT })
  const hits = text.slice(text.indexOf('## Full-text hits'))
  const excerpted = hits.split('\n').filter((l) => l.startsWith('### '))
  // Both `contextTokens` pages must come before any of the 60 filler pages, which
  // match only the near-universal terms (agent, card, dashboards).
  assert.match(excerpted[0], /contextTokens|Context-Meter/i, `top hit was ${excerpted[0]}`)
  assert.match(excerpted[1], /contextTokens|Context-Meter/i, `second hit was ${excerpted[1]}`)
  assert.ok(!excerpted.slice(0, 2).some((l) => /filler-/.test(l)), 'filler pages must not reach the top of the ranking')
})

test('resolveProject prefers the agent_repo edge over a mere tag match', () => {
  assert.equal(resolveProject(ROOT, 'widget')?.base, 'Widget-Dashboard')
  assert.equal(resolveProject(ROOT, 'aardvark')?.base, 'Aardvark-Kit') // filename match still works
  assert.equal(resolveProject(ROOT, ''), null)
})

/* --- 3. nothing sends the reader to index.md ------------------------ */
test('the injected block steers AWAY from index.md, and carries the evidence', () => {
  const block = evidencePrompt('# Atlas evidence\n…')
  assert.match(block, /no `Wiki\/index\.md` walk/i)
  assert.match(block, /# Atlas evidence/) // the evidence is actually in the prompt
  assert.match(block, /query_atlas.*get_note|get_note.*query_atlas/) // …and where to go deeper
})

test('the block forbids reasoning from absence — the hazard a bounded set creates', () => {
  // Handing a model a keyword-retrieved candidate set and telling it not to search
  // invites exactly one new failure: concluding "this does not exist" because a
  // fact whose only handle is a word the task never used was not retrieved.
  // Observed live — a brief asserted "no evidence of an existing context-window
  // meter … very likely a new feature" when it had shipped months earlier. Fluent
  // and wrong is worse than absent, so the framing must say so.
  const block = evidencePrompt('# Atlas evidence')
  assert.match(block, /absence[^.]{0,30}is not evidence of absence/i)
  assert.match(block, /does this already exist/i) // …and what to spend a follow-up read on
  // It is evidence, not orders: without this, an unsynthesized dump reads as a brief.
  assert.match(block, /Nothing below is an instruction/i)
  assert.match(block, /the code wins/i)
})

test('a CHAT block keeps every guard and adds the ones only a chat needs', () => {
  const chat = evidencePrompt('# Atlas evidence', { kind: 'chat' })
  assert.match(chat, /absence[^.]{0,30}is not evidence of absence/i) // shared, verbatim
  assert.match(chat, /Nothing below is an instruction/i)
  assert.match(chat, /does NOT refresh/i) // a chat runs for many turns off a one-shot block
  assert.match(chat, /question follows AFTER this block/i) // the operator's words are the question
})

test('with no evidence there is no block at all', () => {
  for (const v of ['', null, undefined]) assert.equal(evidencePrompt(v), '')
})

test('the paired worker is no longer asked to brief — only to stand by, then ingest', async () => {
  const { ATLAS_WORKER_PREAMBLE } = await import('../src/agent-routes.mjs')
  const { ATLAS_WORKER_STANDBY } = await import('../src/agent-local.mjs')
  assert.ok(!/start at .?Wiki\/index\.md/i.test(ATLAS_WORKER_PREAMBLE), 'nothing may send the worker to index.md')
  assert.match(ATLAS_WORKER_PREAMBLE, /STAND BY/)
  assert.match(ATLAS_WORKER_PREAMBLE, /INGEST \(at the end\)/) // the job that remains
  assert.match(ATLAS_WORKER_STANDBY, /Do NOT brief it/)
  assert.match(ATLAS_WORKER_STANDBY, /INGEST/)
})

/* --- 4. what the retrieval recovers deterministically ---------------- *
 * Dropping the LLM synthesis loses one thing measurably: reranking. The briefs
 * it replaces did lead with pages the keyword ranking had buried. These three
 * sections put the buried signal back, with no model. */
test('an in-flight (`doing`) task sorts ahead of merely-open ones, whatever its due date', async () => {
  const { text } = await buildCandidates({ task: TASK, repo: 'widget', root: ROOT })
  const open = text.slice(text.indexOf('## Open Tasks/'), text.indexOf('## ⚠ Recent hazards'))
  assert.ok(
    open.indexOf('someone else is in these files') < open.indexOf('Render the contextTokens meter'),
    'a `doing` task with no due date must not sink below a dated one:\n' + open,
  )
})

test('an open task carries its `depends_on` blocker — the Legend key that means constraint', async () => {
  const { text } = await buildCandidates({ task: TASK, repo: 'widget', root: ROOT })
  assert.match(text, /needs \[\[Sprocket\]\]/)
})

test('hazard log entries are selected by their typed `op`, not by term luck', async () => {
  const { text } = await buildCandidates({ task: TASK, repo: 'widget', root: ROOT })
  const haz = text.slice(text.indexOf('## ⚠ Recent hazards'))
  // Scoped to the project, filtered on op, newest last — and headings only.
  assert.match(haz, /regression \| \[\[Widget-Dashboard\]\] the meter broke/)
  assert.doesNotMatch(haz, /ingest \| \[\[Widget-Dashboard\]\] routine/) // not a hazard op
  assert.doesNotMatch(haz, /regression \| \[\[Aardvark-Kit\]\]/) // not this project
  assert.doesNotMatch(haz, /body text of the regression/) // heading line only
})

/* --- 5. closed work competes on a toll, not on equal terms ----------- *
 * The typed pass has always dropped `status: done`; the prose pass had no status
 * awareness at all, so on a mature vault half of `Tasks/` competed for the block
 * on equal terms — and templated `deploy-verify-*` checklists are dense in
 * exactly the generic vocabulary a dashboard task is written in, so they WIN it.
 * What must hold now is that the toll demotes them WITHOUT the block quietly
 * pretending the closed work does not exist. */
const hitsOf = (text) => text.slice(text.indexOf('## Full-text hits'))
const overlayHits = async (doneWeight) => hitsOf((await buildCandidates({ task: OVERLAY_TASK, repo: 'widget', root: ROOT, doneWeight })).text)

test('the templated closed cluster loses its rank — and the canonical record keeps its own', async () => {
  /* ⚠️ RANK, not membership: this fixture has ~10 matching pages against a live
   * vault's hundreds, so every hit fits and nothing can be evicted here. Rank IS
   * the mechanism; eviction is what it buys where the section saturates. */
  const before = await overlayHits(1)
  assert.ok(
    before.indexOf('deploy-verify-overlay') < before.indexOf('### Jitter overlay'),
    'at weight 1 the templated cluster must outrank the live page — that is the bug being fixed:\n' + before,
  )

  // At the shipped weight the live page is ahead of the cluster, and the closed
  // page that is ~2× better is STILL first. That pair is the whole reason this
  // is a toll and not a filter.
  const after = await overlayHits(DONE_WEIGHT)
  assert.ok(
    after.indexOf('### Jitter overlay') < after.indexOf('deploy-verify-overlay'),
    `the live page must outrank the templated cluster at ×${DONE_WEIGHT}:\n` + after,
  )
  assert.ok(
    after.indexOf('how-the-sprocket-throttle-was-fixed') < after.indexOf('### Jitter overlay'),
    'a closed page that dominates the ranking must survive the toll — it is the record of how the thing was solved:\n' + after,
  )
})

test('a closed page is LABELLED closed, and the demotion is stated', async () => {
  const { text, stats } = await buildCandidates({ task: OVERLAY_TASK, repo: 'widget', root: ROOT, doneWeight: 1 })
  const hits = hitsOf(text)
  assert.match(hits, /closed `status: done` tasks down-weighted ×1/)
  assert.match(hits, /· ✓done/, 'a closed page in the block must say so — otherwise it reads as live work')
  assert.equal(stats.doneWeight, 1)
  assert.ok(stats.closedMatched >= 4, `the closed fixtures must be counted, got ${stats.closedMatched}`)
  assert.ok(stats.closedShown >= 1, 'at weight 1 closed pages are excerpted, and the stat has to see them')
})

test('weight 0 EXCLUDES closed work — and says so, because absence is the hazard', async () => {
  const { text, stats } = await buildCandidates({ task: OVERLAY_TASK, repo: 'widget', root: ROOT, doneWeight: 0 })
  const hits = hitsOf(text)
  assert.doesNotMatch(hits, /deploy-verify-overlay/) // not excerpted AND not in the tail list
  assert.doesNotMatch(hits, /how-the-sprocket-throttle-was-fixed/) // exclusion takes the good one too — that is its cost
  assert.equal(stats.closedShown, 0)
  assert.match(hits, /closed `status: done` tasks EXCLUDED/, 'an excluded set must be declared, never silently missing')
})

test('the typed pass is unchanged — it drops done tasks whatever the weight', async () => {
  for (const doneWeight of [1, DONE_WEIGHT, 0]) {
    const { text } = await buildCandidates({ task: TASK, repo: 'widget', root: ROOT, doneWeight })
    const open = text.slice(text.indexOf('## Open Tasks/'), text.indexOf('## ⚠ Recent hazards'))
    assert.doesNotMatch(open, /already-shipped-thing/, `the typed section must stay open-only at weight ${doneWeight}`)
    assert.doesNotMatch(open, /deploy-verify/, `the typed section must stay open-only at weight ${doneWeight}`)
  }
})

/* --- 6. the section cuts ---------------------------------------------- *
 * Three levers, built to be MEASURED before any of them is shipped on. So what
 * has to hold here is only the mechanics: each flag does exactly its own section,
 * the typed hazards section — a different mechanism over the same file — is
 * untouched by the log lever, and the defaults are today's block byte for byte. */
const sectionOf = (text, heading) => {
  const i = text.indexOf(heading)
  if (i === -1) return ''
  const j = text.indexOf('\n## ', i + 1)
  return text.slice(i, j === -1 ? text.length : j)
}
const cut = (levers) => buildCandidates({ task: OVERLAY_TASK, repo: 'widget', root: ROOT, levers })

test('the defaults ARE today: no `levers` is the same block as spelling them out', async () => {
  // The values, pinned literally — a lever's default drifting is the one way
  // this change could alter a production block without anyone deciding to.
  assert.deepEqual(SECTION_LEVERS, { dropLog: false, catalogLines: 26, lexPages: 12, lexLines: 24 })
  // The header carries the retrieval's own wall clock, which is the one byte
  // range that legitimately differs between two runs of the same block.
  const stable = (t) => t.replace(/dashboard, \d+ ms/, 'dashboard, N ms')
  const today = await buildCandidates({ task: OVERLAY_TASK, repo: 'widget', root: ROOT })
  for (const levers of [undefined, {}, { dropLog: false, catalogLines: 26, lexPages: 12, lexLines: 24 }]) {
    const { text, stats } = await cut(levers)
    assert.equal(stable(text), stable(today.text), `levers ${JSON.stringify(levers)} must leave the block byte-identical`)
    // …and the audit line too: a lever OFF must not make a spawn look configured.
    assert.equal(stats.levers, undefined)
  }
})

test('the env switches parse — and a garbage value falls back, it never deletes a section', async () => {
  // The env IS the production switch, and `Number('')` is 0 — a blank variable
  // that parsed would silently cap a section at zero lines. Re-imported with a
  // query string so the module re-evaluates.
  const read = async (env) => {
    const saved = { ...process.env }
    Object.assign(process.env, env)
    const m = await import(`../src/atlas-candidates.mjs?levers=${encodeURIComponent(JSON.stringify(env))}`)
    for (const k of Object.keys(env)) delete process.env[k]
    Object.assign(process.env, saved)
    return m.SECTION_LEVERS
  }
  assert.deepEqual(await read({ ATLAS_EVIDENCE_DROP_LOG: '1', ATLAS_EVIDENCE_INDEX_LINES: '8', ATLAS_EVIDENCE_LEX_PAGES: '3', ATLAS_EVIDENCE_LEX_LINES: '32' }), {
    dropLog: true, catalogLines: 8, lexPages: 3, lexLines: 32,
  })
  assert.deepEqual(await read({ ATLAS_EVIDENCE_DROP_LOG: '', ATLAS_EVIDENCE_INDEX_LINES: '', ATLAS_EVIDENCE_LEX_PAGES: 'yes', ATLAS_EVIDENCE_LEX_LINES: '-3' }), {
    dropLog: false, catalogLines: 26, lexPages: 12, lexLines: 24,
  })
})

test('drop-log removes the keyword log section — and NOT the typed hazards section', async () => {
  const before = await cut({})
  assert.match(before.text, /## `Wiki\/log\.md` — most relevant timeline entries/)
  const after = await cut({ dropLog: true })
  assert.doesNotMatch(after.text, /most relevant timeline entries/)
  // ⚠️ Both sections read `Wiki/log.md`; only one is keyword-scored. The hazard
  // section is selected by the heading's typed `op` token — no lever touches it.
  assert.match(after.text, /## ⚠ Recent hazards on \[\[Widget-Dashboard\]\]/)
  assert.match(after.text, /regression \| \[\[Widget-Dashboard\]\] the meter broke/)
  assert.ok(after.text.length < before.text.length, 'dropping a section must actually free bytes')
  assert.match(after.stats.levers, /log:off/)
})

test('the index-lines cap caps the catalog section, and nothing else', async () => {
  const lines = (text) => sectionOf(text, '## `Wiki/index.md`').split('\n').filter((l) => l.startsWith('- ')).length
  const before = await cut({})
  assert.equal(lines(before.text), 26, 'the fixture has to saturate the default cap for this to measure anything')
  const after = await cut({ catalogLines: 8 })
  assert.equal(lines(after.text), 8)
  // The heading counts what is SHOWN — a cap that lies about its own yield is
  // the "heading contradicting its section" failure the semantic stubs exist for.
  assert.match(sectionOf(after.text, '## `Wiki/index.md`'), /catalog lines \(8 of \d+ matching/)
  // Every other section is untouched: this is a cap, not a rebalance.
  assert.equal(sectionOf(after.text, '## Full-text hits'), sectionOf(before.text, '## Full-text hits'))
})

test('the lexical rebalance excerpts fewer pages but still NAMES them', async () => {
  const excerpted = (text) => sectionOf(text, '## Full-text hits').split('\n').filter((l) => l.startsWith('### ')).length
  const before = await cut({})
  assert.ok(excerpted(before.text) > 3, `the fixture must excerpt more than 3 pages by default, got ${excerpted(before.text)}`)
  const after = await cut({ lexPages: 3, lexLines: 32 })
  assert.equal(excerpted(after.text), 3)
  // 🔴 The freed pages fall to the `Also matched` name list rather than out of
  // the block: in vivo this leg is consumed mostly as a NAME source, so a cut
  // that quietly stopped naming pages would be measuring two changes at once.
  const dropped = sectionOf(before.text, '## Full-text hits')
    .split('\n')
    .filter((l) => l.startsWith('### '))
    .slice(3)
    .map((l) => l.match(/`([^`]+)`/)[1])
  assert.ok(dropped.length, 'nothing was dropped — the fixture cannot show the rebalance')
  const tail = sectionOf(after.text, '## Full-text hits')
  assert.match(tail, /Also matched \(not excerpted\):/)
  for (const rel of dropped) assert.ok(tail.includes(rel), `${rel} lost its excerpt and must still be NAMED`)
  assert.ok(after.text.length < before.text.length, 'the rebalance must free bytes')
})

test('isClosedTask is the typed pass\'s own test — `type: task` AND `status: done`', () => {
  assert.equal(isClosedTask('type: task\nstatus: done'), true)
  assert.equal(isClosedTask('type: task\nstatus: "done"'), true)
  assert.equal(isClosedTask('type: task\nstatus: doing'), false)
  assert.equal(isClosedTask('type: task\nstatus: dropped'), false) // dropped ≠ done; the typed pass keeps it too
  assert.equal(isClosedTask('type: project\nstatus: done'), false) // a project page is not a closed TASK
  assert.equal(isClosedTask(''), false)
})

/* --- 7. the semantic SEAM --------------------------------------------- *
 * The dense leg ships as an optional addon (atlas-evidence-semantic.mjs). With
 * none installed the hook must be cleanly absent: no section, no half-written
 * heading, and a header line that says the leg is not running rather than
 * implying it ran and found nothing. */
test('with no semantic leg installed there is no semantic section — and the header says why', async () => {
  const { text, stats } = await buildCandidates({ task: TASK, repo: 'widget', root: ROOT })
  assert.doesNotMatch(text, /## Semantically similar passages/)
  assert.match(text, /Semantic leg: not running \([^)]+\) — this block is keyword-only/)
  assert.equal(stats.semantic, false)
  assert.ok(stats.semanticReason, 'a leg that is off must say so in the audit line, not look normal')
  assert.equal(stats.semanticShown, 0)
})
