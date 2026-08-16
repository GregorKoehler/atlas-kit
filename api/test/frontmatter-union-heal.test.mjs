/* ------------------------------------------------------------------ *
 * Project cards must stop vanishing after a multi-writer merge.
 *
 * THE FAILURE: two writers each rewrite one frontmatter line on a project page
 * (a paired worker's recap rewriting `related_prs:`, a dev agent's `ATLAS:NOW`
 * line rewriting `now:`), git's `*.md merge=union` — the setting that makes the
 * append-only logs merge-safe — keeps BOTH lines, `js-yaml` THROWS on the
 * duplicate mapping key, every reader swallows the throw and returns `{}`, and
 * the page drops out of `listProjects()` and every other typed consumer with no
 * error anywhere. Repairing it by hand is the only recovery there was.
 *
 * ⚠️ WRITER IDEMPOTENCY CANNOT PREVENT IT — the MERGE creates the duplicate,
 * from two individually-correct single-line writes. That is why the union merge
 * is REPRODUCED HERE WITH REAL GIT rather than hand-written into a fixture: a
 * test that types `now:` twice by hand proves the parser throws, not that the
 * thing we ship actually happens.
 *
 * So three layers, and this file guards all three against the same merge:
 *   1. SELF-HEAL — after any pull/rebase/merge in the vault write path
 *      (atlas-commit-queue.mjs, the SINGLE serialization point every writer on
 *      the box funnels through) the touched .md files are validated and a
 *      duplicated key is auto-resolved and committed: scalar live state keeps
 *      the NEWEST occurrence, arrays take the order-preserving set UNION
 *      (dropping either side would lose a writer's work).
 *   2. READER — the card membership read survives the window between the merge
 *      and the repair, so a card is never missing while the page is broken.
 *   3. The `*.md merge=union` strategy itself is UNCHANGED and must stay so —
 *      the append-only logs need it.
 *
 * Run: node --test api/test/frontmatter-union-heal.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import yaml from 'js-yaml'

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV }).trim()
}
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p))

/* Everything env-derived is frozen at import time by the modules under test —
 * the vault registry, the reader's vault, the Atlas branch, the merge worktree,
 * the audit log — so it is all set BEFORE the first dynamic import below. */
const root = tmp('atlas-kit-fm-heal-')
process.env.AGENT_LOCAL_DIR = path.join(root, 'agent-local') // audit log → throwaway
process.env.ATLAS_MERGE_WORKTREE = path.join(root, 'merge-wt')
process.env.ATLAS_BRANCH = 'main'
// vaults.mjs freezes the registry PATH at import but re-reads the file per call,
// so each write-path test below can point the queue at its own throwaway vault.
const registry = path.join(root, 'vaults.json')
process.env.VAULTS_FILE = registry

/* A REAL union merge. Two writers change the same frontmatter line on two
 * branches of a repo carrying the vault's own `.gitattributes`; git merges them
 * with the built-in union driver. Returns the merged file's text — the exact
 * bytes the dashboard then has to survive. */
function unionMerged(fmA, fmB, body = '\n# Page\n\nSome prose.\n') {
  const repo = tmp('atlas-kit-fm-union-')
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'test@example.com')
  git(repo, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.md merge=union\n')
  fs.writeFileSync(path.join(repo, 'page.md'), `---\ntype: project\n---\n${body}`)
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'base')
  git(repo, 'checkout', '-q', '-b', 'writer-b')
  fs.writeFileSync(path.join(repo, 'page.md'), `---\n${fmB}\n---\n${body}`)
  git(repo, 'commit', '-q', '-am', 'writer B')
  git(repo, 'checkout', '-q', 'main')
  fs.writeFileSync(path.join(repo, 'page.md'), `---\n${fmA}\n---\n${body}`)
  git(repo, 'commit', '-q', '-am', 'writer A')
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge writer B', 'writer-b')
  return fs.readFileSync(path.join(repo, 'page.md'), 'utf-8')
}

const CARD = 'type: project\ngoal: "does a thing"\nagent_repo: demo-kit\ntag: demo'
const parses = (text) => {
  try {
    yaml.load(text.slice(3, text.indexOf('\n---', 3)))
    return true
  } catch {
    return false
  }
}
const fmOf = (text) => yaml.load(text.slice(3, text.indexOf('\n---', 3)))

const { healFrontmatter, duplicateFrontmatterKeys, loadFrontmatter, healTouchedFrontmatter } = await import('../src/frontmatter-heal.mjs')

/* ------------------------------------------------------------------ *
 * 1. The merge really does this — the premise, not an assumption
 * ------------------------------------------------------------------ */

test('a real union merge doubles the key both writers touched, and js-yaml throws', () => {
  const merged = unionMerged(`${CARD}\nnow: writer A's line`, `${CARD}\nnow: writer B's line`)
  assert.deepEqual(duplicateFrontmatterKeys(merged), ['now'])
  assert.equal(parses(merged), false)
  // Both writers' lines survived the merge — nothing here is a lost write.
  assert.match(merged, /writer A's line/)
  assert.match(merged, /writer B's line/)
})

/* ------------------------------------------------------------------ *
 * 2. Resolution policy
 * ------------------------------------------------------------------ */

test('a healthy page is left alone entirely — no churn, no rewrite', () => {
  assert.equal(healFrontmatter(`---\n${CARD}\nnow: one line\n---\n\n# Body\n`), null)
  assert.deepEqual(duplicateFrontmatterKeys(`---\n${CARD}\n---\n`), [])
  assert.equal(healFrontmatter('no frontmatter at all\n'), null)
})

test('scalar live state keeps the NEWEST occurrence — the incoming side, last after a union merge', () => {
  const merged = unionMerged(`${CARD}\nnow: the old state`, `${CARD}\nnow: the recap's new state`)
  const healed = healFrontmatter(merged)
  assert.deepEqual(healed.repairs, [{ key: 'now', policy: 'newest', dropped: 1 }])
  assert.equal(parses(healed.text), true)
  assert.equal(fmOf(healed.text).now, "the recap's new state")
  assert.deepEqual(duplicateFrontmatterKeys(healed.text), [])
})

test('a date-shaped scalar resolves to the LATEST date, not to file order', () => {
  // `updated:` is the one live-state key where "newest" is knowable rather than
  // positional — and union merge does not order the sides by date.
  const merged = unionMerged(`${CARD}\nupdated: 2026-08-15`, `${CARD}\nupdated: 2026-08-04`)
  const healed = healFrontmatter(merged)
  assert.match(healed.text, /^updated: 2026-08-15$/m)
  assert.doesNotMatch(healed.text, /2026-08-04/)
})

test('array keys take the ORDER-PRESERVING SET UNION — neither writer loses a PR', () => {
  const merged = unionMerged(`${CARD}\nrelated_prs: ["demo#1", "demo#2"]`, `${CARD}\nrelated_prs: ["demo#1", "demo#3"]`)
  const healed = healFrontmatter(merged)
  assert.deepEqual(healed.repairs, [{ key: 'related_prs', policy: 'union', dropped: 1 }])
  assert.deepEqual(fmOf(healed.text).related_prs, ['demo#1', 'demo#2', 'demo#3'])
})

test('when one side already IS the union its line is kept verbatim — a minimal diff', () => {
  const superset = `${CARD}\nrelated: ["[[Atlas]]", "[[Atlas Kit]]", "[[Demo Project]]"]`
  const merged = unionMerged(superset, `${CARD}\nrelated: ["[[Atlas]]", "[[Atlas Kit]]"]`)
  const healed = healFrontmatter(merged)
  assert.match(healed.text, /^related: \["\[\[Atlas\]\]", "\[\[Atlas Kit\]\]", "\[\[Demo Project\]\]"\]$/m)
})

test('a BLOCK list needs no repair — union merge already unions it correctly', () => {
  // Worth pinning: the damage is specific to a value written on the KEY's own
  // line. Two sides adding items under one `tags:` key merge into one valid
  // list, because the key line itself never conflicts. Nothing to heal.
  const merged = unionMerged(`${CARD}\ntags:\n  - dashboard\n  - agents`, `${CARD}\ntags:\n  - dashboard\n  - kanban`)
  assert.deepEqual(duplicateFrontmatterKeys(merged), [])
  assert.equal(healFrontmatter(merged), null)
  assert.deepEqual(fmOf(merged).tags, ['dashboard', 'agents', 'kanban'])
})

test('a duplicated multi-line key is resolved as ONE unit, not line by line', () => {
  // The block form CAN still double when a whole entry is re-added rather than
  // edited in place. Its continuation lines must move and drop with their key.
  const doubled = `---\n${CARD}\ntags:\n  - dashboard\n  - agents\nstatus: active\ntags:\n  - dashboard\n  - kanban\n---\n\n# Page\n`
  assert.deepEqual(duplicateFrontmatterKeys(doubled), ['tags'])
  const healed = healFrontmatter(doubled)
  assert.deepEqual(fmOf(healed.text).tags, ['dashboard', 'agents', 'kanban'])
  assert.equal(fmOf(healed.text).status, 'active')
  assert.equal((healed.text.match(/^tags:/gm) || []).length, 1)
})

test('the body and every undamaged key are untouched', () => {
  const merged = unionMerged(`${CARD}\nnow: A`, `${CARD}\nnow: B`)
  const healed = healFrontmatter(merged)
  assert.match(healed.text, /\n# Page\n\nSome prose\.\n$/)
  const fm = fmOf(healed.text)
  assert.equal(fm.goal, 'does a thing')
  assert.equal(fm.agent_repo, 'demo-kit')
  assert.equal(fm.tag, 'demo')
})

test('healing is idempotent — a repaired page repairs to nothing', () => {
  const healed = healFrontmatter(unionMerged(`${CARD}\nnow: A`, `${CARD}\nnow: B`))
  assert.equal(healFrontmatter(healed.text), null)
})

/* ------------------------------------------------------------------ *
 * 3. The reader survives the window between the merge and the repair
 * ------------------------------------------------------------------ */

// listProjects() reads read-routes' own VAULT (projectsVaultPath()), which is
// VAULT_PATH frozen at import — a plain directory, no git needed for the read.
const readVault = path.join(root, 'read-vault')
fs.mkdirSync(path.join(readVault, 'Wiki', 'Projects'), { recursive: true })
const projectPage = (file, text) => fs.writeFileSync(path.join(readVault, 'Wiki', 'Projects', file), text)

projectPage(
  'Demo-Project.md',
  unionMerged(
    `${CARD}\nnow: the old state\nrelated_prs: ["demo#1", "demo#2"]`,
    `${CARD}\nnow: the recap's new state\nrelated_prs: ["demo#1", "demo#3"]`,
  ),
)
projectPage('Healthy.md', `---\ntype: project\ngoal: "ship the kit"\nagent_repo: healthy-kit\nnow: healthy\n---\n\n# Healthy\n`)
// Damage the self-heal cannot resolve (a duplicate key is not the only way to
// break YAML): the page must still not invent a card, and must say so.
projectPage('Broken.md', `---\ntype: project\ngoal: "unparseable"\n  bad: [indent\n---\n\n# Broken\n`)

process.env.VAULT_PATH = readVault
const { listProjects } = await import('../src/read-routes.mjs')

test('the card stays rendered while its page is doubled — with the resolved values', () => {
  const page = fs.readFileSync(path.join(readVault, 'Wiki', 'Projects', 'Demo-Project.md'), 'utf-8')
  assert.equal(parses(page), false) // the page on disk is genuinely broken…
  const card = listProjects().find((p) => p.agentRepo === 'demo-kit')
  assert.ok(card, 'the doubled page must still produce a card — this is the bug')
  assert.equal(card.now, "the recap's new state") // …and reads what the repair will write
  assert.equal(card.goal, 'does a thing')
})

test('a healthy page and an unrecoverable one are both unchanged in behaviour', () => {
  assert.ok(listProjects().some((p) => p.agentRepo === 'healthy-kit'))
  assert.equal(
    listProjects().find((p) => p.goal === 'unparseable'),
    undefined,
    'unrecoverable damage must not be papered over into a half-read card',
  )
})

test('loadFrontmatter reports what it did — repaired vs unrecoverable', () => {
  const doubled = fs.readFileSync(path.join(readVault, 'Wiki', 'Projects', 'Demo-Project.md'), 'utf-8')
  assert.deepEqual(
    loadFrontmatter(doubled, 'Demo-Project.md').repairs.map((r) => r.key),
    ['now', 'related_prs'],
  )
  assert.deepEqual(loadFrontmatter(`---\ntype: project\n---\n`).repairs, [])
  assert.deepEqual(loadFrontmatter(`---\nbad: [indent\n  worse\n---\n`).data, {})
})

/* ------------------------------------------------------------------ *
 * 4. The self-heal, end to end through the real vault write path
 *
 * Every writer in the kit — the Kanban move, the done-clear cron, prospects
 * approve, the `ATLAS:NOW` card rewrite, seed-self-card, the paired-worker
 * ingest merge — funnels through atlas-commit-queue.mjs, so guarding its two
 * job shapes guards all of them.
 * ------------------------------------------------------------------ */

// A throwaway vault: bare origin + clone, as in atlas-prospects-routes.test.mjs.
function makeVault(name, fm) {
  const dir = tmp(`atlas-kit-fm-vault-${name}-`)
  const remote = path.join(dir, 'remote.git')
  const vault = path.join(dir, 'vault')
  git(dir, 'init', '--bare', '-q', '-b', 'main', remote)
  git(dir, 'clone', '-q', remote, vault)
  git(vault, 'config', 'user.email', 'test@example.com')
  git(vault, 'config', 'user.name', 'Test')
  fs.mkdirSync(path.join(vault, 'Wiki', 'Projects'), { recursive: true })
  // The `.gitattributes` that makes the append-only logs merge-safe — and that
  // produces the damage. It is deliberately NOT changed by any of this.
  fs.writeFileSync(path.join(vault, '.gitattributes'), '*.md merge=union\n')
  fs.writeFileSync(path.join(vault, REL), `---\n${fm}\n---\n\n# Demo Project\n`)
  git(vault, 'add', '.')
  git(vault, 'commit', '-q', '-m', 'init')
  git(vault, 'push', '-q', 'origin', 'main')
  return { dir, remote, vault }
}
const REL = 'Wiki/Projects/Demo-Project.md'
const readPage = (vault) => fs.readFileSync(path.join(vault, REL), 'utf-8')
const useVault = (vault) => fs.writeFileSync(registry, JSON.stringify({ atlas: { path: vault, label: 'Atlas', default: true } }))

const { enqueueAtlasCommit, enqueueAtlasMerge } = await import('../src/atlas-commit-queue.mjs')

/** A second checkout that pushes its own rewrite of the same two lines first —
 *  the other writer (a phone's Obsidian Git sync, a second box). */
function otherWriterPushes(dir, remote, fm) {
  const other = path.join(dir, 'other')
  git(dir, 'clone', '-q', remote, other)
  git(other, 'config', 'user.email', 'test@example.com')
  git(other, 'config', 'user.name', 'Test')
  fs.writeFileSync(path.join(other, REL), `---\n${fm}\n---\n\n# Demo Project\n`)
  git(other, 'commit', '-q', '-am', 'recap')
  git(other, 'push', '-q', 'origin', 'main')
}

test("enqueueAtlasMerge: a paired worker's recap branch is healed BEFORE it reaches main", async () => {
  const { vault, remote } = makeVault('merge', `${CARD}\nnow: the old state\nrelated_prs: ["demo#1"]`)
  useVault(vault)

  // The recap worker's branch: it rewrote its two lines correctly, once each.
  git(vault, 'checkout', '-q', '-b', 'atlas/recap-1')
  fs.writeFileSync(path.join(vault, REL), `---\n${CARD}\nnow: the recap's new state\nrelated_prs: ["demo#1", "demo#2"]\n---\n\n# Demo Project\n`)
  git(vault, 'commit', '-q', '-am', 'recap')
  git(vault, 'push', '-q', 'origin', 'atlas/recap-1')
  git(vault, 'checkout', '-q', 'main')
  // …and main moved on meanwhile, rewriting the same two lines its own way.
  fs.writeFileSync(path.join(vault, REL), `---\n${CARD}\nnow: a later state\nrelated_prs: ["demo#1", "demo#3"]\n---\n\n# Demo Project\n`)
  git(vault, 'commit', '-q', '-am', 'now')
  git(vault, 'push', '-q', 'origin', 'main')

  const r = await enqueueAtlasMerge({ branch: 'atlas/recap-1', message: 'atlas: merge recap' })
  assert.equal(r.ok, true, r.warning)

  git(vault, 'fetch', '-q', 'origin')
  git(vault, 'reset', '-q', '--hard', 'origin/main')
  const page = readPage(vault)
  assert.equal(parses(page), true, 'main must never carry a page that does not parse')
  assert.deepEqual(duplicateFrontmatterKeys(page), [])
  const fm = fmOf(page)
  assert.deepEqual(fm.related_prs, ['demo#1', 'demo#3', 'demo#2'], "both writers' PRs survive")
  assert.ok(fm.now, 'a `now:` line survives')
  assert.equal(git(remote, 'rev-parse', 'main'), git(vault, 'rev-parse', 'HEAD'))
})

test('enqueueAtlasCommit: a pull that doubles a page is repaired, committed and pushed', async () => {
  const { dir, remote, vault } = makeVault('pull', `${CARD}\nnow: the old state\nrelated_prs: ["demo#1"]`)
  useVault(vault)

  otherWriterPushes(dir, remote, `${CARD}\nnow: the recap's new state\nrelated_prs: ["demo#1", "demo#2"]`)
  // …while this box committed its own rewrite of the same two lines.
  fs.writeFileSync(path.join(vault, REL), `---\n${CARD}\nnow: a later state\nrelated_prs: ["demo#1", "demo#3"]\n---\n\n# Demo Project\n`)
  git(vault, 'commit', '-q', '-am', 'now')

  // An UNRELATED write (a Kanban status flip) is what triggers the pull.
  fs.mkdirSync(path.join(vault, 'Tasks'), { recursive: true })
  const r = await enqueueAtlasCommit({
    message: 'tasks: a task → done',
    paths: 'Tasks/t.md',
    mutate: async (p) => fs.writeFileSync(path.join(p, 'Tasks', 't.md'), '---\ntype: task\nstatus: done\n---\n'),
  })
  assert.equal(r.ok, true, r.warning)
  assert.equal(r.repaired, true)

  const page = readPage(vault)
  assert.equal(parses(page), true)
  assert.deepEqual(duplicateFrontmatterKeys(page), [])
  assert.deepEqual(fmOf(page).related_prs.sort(), ['demo#1', 'demo#2', 'demo#3'])
  // The repair must be PUSHED — an unpushed one leaves every other checkout broken.
  assert.equal(git(remote, 'rev-parse', 'main'), git(vault, 'rev-parse', 'HEAD'))
  assert.match(git(vault, 'log', '-3', '--format=%s'), /heal 1 page\(s\) with union-merged duplicate frontmatter keys/)
})

test("enqueueAtlasCommit: the repair is pushed even when the caller's own edit was a no-op", async () => {
  const { dir, remote, vault } = makeVault('noop', `${CARD}\nnow: the old state\nrelated_prs: ["demo#1"]`)
  useVault(vault)

  otherWriterPushes(dir, remote, `${CARD}\nnow: the recap's new state\nrelated_prs: ["demo#1", "demo#2"]`)
  fs.writeFileSync(path.join(vault, REL), `---\n${CARD}\nnow: a later state\nrelated_prs: ["demo#1", "demo#3"]\n---\n\n# Demo Project\n`)
  git(vault, 'commit', '-q', '-am', 'now')

  // Nothing of OUR own to commit (the `ATLAS:NOW` rewrite found the value
  // already current, the cron found no done tasks). The repair must still go
  // out on its own — that is the whole point of `repaired`.
  const r = await enqueueAtlasCommit({ message: 'projects: Demo now (dev agent)', paths: REL })
  assert.equal(r.ok, true, r.warning)
  assert.equal(r.committed, false)
  assert.equal(r.repaired, true)

  const page = readPage(vault)
  assert.equal(parses(page), true)
  assert.deepEqual(duplicateFrontmatterKeys(page), [])
  assert.equal(git(remote, 'rev-parse', 'main'), git(vault, 'rev-parse', 'HEAD'))
})

test('healTouchedFrontmatter: nothing to heal makes no commit at all', async () => {
  const { vault } = makeVault('clean', `${CARD}\nnow: fine`)
  const head = git(vault, 'rev-parse', 'HEAD')
  const out = await healTouchedFrontmatter({
    dir: vault,
    run: async (args) => ({ stdout: execFileSync('git', args, { cwd: vault, encoding: 'utf-8', env: GIT_ENV }) }),
    from: 'HEAD~0',
    author: { name: 'Test', email: 'test@example.com' },
    label: 'test',
  })
  assert.deepEqual(out.repaired, [])
  assert.equal(out.committed, false)
  assert.equal(git(vault, 'rev-parse', 'HEAD'), head)
})

test('healTouchedFrontmatter never throws — a git failure is reported, not raised', async () => {
  const out = await healTouchedFrontmatter({
    dir: root,
    run: async () => {
      throw new Error('fatal: not a git repository')
    },
    from: 'HEAD^',
    label: 'test',
  })
  assert.equal(out.committed, false)
  assert.match(out.warning, /not a git repository/)
})
