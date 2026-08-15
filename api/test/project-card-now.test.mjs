/* ------------------------------------------------------------------ *
 * The project-card "NOW" protocol, both halves of the marker pair.
 *
 *   producer — CARD_PREAMBLE (agent-routes.mjs), pinned in ship-prompt.test.mjs
 *   consumer — scanNowMarker (subagent-scan.mjs): assistant text only, own line
 *              only, LATEST marker wins
 *   write    — updateProjectNow (project-card.mjs): the matching card's `now:`,
 *              rewritten through the SERIAL vault commit queue
 *
 * ⚠️ THE HAZARD THIS FILE EXISTS FOR. The vault carries `*.md merge=union`, so
 * two sides that each write a DIFFERENT `now:` line for one page (a paired-worker
 * branch merged by enqueueAtlasMerge, a phone sync racing the queue's rebase) end
 * up with BOTH lines. A page with two `now:` keys no longer round-trips through
 * js-yaml — every frontmatter reader in the kit (listProjects, the typed query
 * engine, the type registry) then sees a broken page and the card UNTYPES off the
 * dashboard. So the rewrite must be idempotent: exactly one `now:` key, always,
 * however many times it runs and whatever damage it finds. Writing twice must not
 * append, and an already-doubled page must be repaired.
 *
 * The write half runs against a REAL throwaway vault (bare origin + clone), so
 * the queue's pull --rebase → mutate → commit → push path is exercised rather
 * than mocked.
 *
 * Run: node --test api/test/project-card-now.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { execFileSync } from 'node:child_process'
import { scanNowMarker } from '../src/subagent-scan.mjs'

/* --- the CONSUMER half: scanNowMarker ---------------------------------- */

const asst = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const user = (text) => JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] } })

test('the LATEST marker wins — a later reply supersedes an earlier one', () => {
  const lines = [asst('ATLAS:NOW an early state'), asst('shipped it\nATLAS:NOW the state after my change')]
  assert.equal(scanNowMarker(lines), 'the state after my change')
})

test('the latest marker WITHIN one reply wins too', () => {
  assert.equal(scanNowMarker([asst('ATLAS:NOW first\nsome prose\nATLAS:NOW second')]), 'second')
})

test('no marker → null, and a bare marker carries no state', () => {
  assert.equal(scanNowMarker([asst('just a normal reply')]), null)
  assert.equal(scanNowMarker([asst('ATLAS:NOW   ')]), null)
})

test('only ASSISTANT text counts — the preamble echoing it must never match', () => {
  // CARD_PREAMBLE rides in user-side events; a self-match would rewrite every
  // card with the instruction text.
  assert.equal(scanNowMarker([user('end a reply with ATLAS:NOW <one concise line>')]), null)
})

test('the marker must be alone on its line — mid-sentence does not match', () => {
  assert.equal(scanNowMarker([asst('the project is ATLAS:NOW shipping daily')]), null)
})

test('a partial first line (the tail slice cutting JSON) is skipped harmlessly', () => {
  assert.equal(scanNowMarker(['…truncated mid-json{"broke', asst('ATLAS:NOW a clean state')]), 'a clean state')
})

/* --- the WRITE half: a real vault behind the serial commit queue -------- */

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV }).trim()
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-card-now-'))
const remote = path.join(root, 'remote.git')
const vault = path.join(root, 'vault')
git(root, 'init', '--bare', '-q', '-b', 'main', remote)
git(root, 'clone', '-q', remote, vault)
git(vault, 'config', 'user.email', 'test@example.com')
git(vault, 'config', 'user.name', 'Test')

const projects = path.join(vault, 'Wiki', 'Projects')
fs.mkdirSync(projects, { recursive: true })

// The filename deliberately does NOT match the agent_repo key: every caller
// resolves a project by `agent_repo`, never by filename.
const pagePath = path.join(projects, 'Demo-Project.md')
fs.writeFileSync(
  pagePath,
  '---\ntype: project\ngoal: "does a thing"\nagent_repo: demo\ntag: demo\nupdated: 2026-01-01\nnow: "the old line"\n---\n\n# Demo\n\nbody text\n',
)
// A page a previous union merge already DOUBLED — the write must repair it.
const dupePath = path.join(projects, 'Doubled.md')
fs.writeFileSync(
  dupePath,
  '---\ntype: project\ngoal: "does another thing"\nagent_repo: doubled\nnow: "left side"\nnow: "right side"\n---\n\n# Doubled\n',
)
git(vault, 'add', '.')
git(vault, 'commit', '-q', '-m', 'init')
git(vault, 'push', '-q', 'origin', 'main')

// vaults.mjs / read-routes.mjs / atlas-commit-queue.mjs freeze env-derived
// constants at import time — set these BEFORE the first (dynamic) import. The
// registry names the SAME path VAULT_PATH does: read and write must pin to one
// vault, which is exactly what projectsVaultKey() resolves.
process.env.VAULT_PATH = vault
process.env.VAULT_DIR = vault
process.env.VAULTS_FILE = path.join(root, 'vaults.json')
fs.writeFileSync(process.env.VAULTS_FILE, JSON.stringify({ atlas: { path: vault, label: 'Test Atlas', default: true } }))
process.env.ATLAS_BRANCH = 'main'
process.env.ATLAS_AUTHOR_NAME = 'Test'
process.env.ATLAS_AUTHOR_EMAIL = 'test@example.com'

const { updateProjectNow, rewriteNow } = await import('../src/project-card.mjs')

const read = (p) => fs.readFileSync(p, 'utf-8')
const nowLines = (p) =>
  read(p)
    .split('\n')
    .filter((l) => /^[ \t]*now[ \t]*:/.test(l))
const frontmatter = (text) => yaml.load(text.split('\n---')[0].replace(/^---\n/, ''))
const fmOf = (p) => frontmatter(read(p))
const today = new Date().toISOString().slice(0, 10)

test('the card is rewritten in place: one `now:`, goal untouched, `updated:` bumped', async () => {
  const r = await updateProjectNow('demo', 'a brand new state')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(nowLines(pagePath), ['now: a brand new state'])
  const fm = fmOf(pagePath)
  assert.equal(fm.type, 'project') // still typed — the card still exists
  assert.equal(fm.goal, 'does a thing') // operator-owned, never touched
  assert.equal(fm.now, 'a brand new state')
  assert.match(read(pagePath), new RegExp(`^updated: ${today}$`, 'm'))
  assert.match(read(pagePath), /\n# Demo\n\nbody text\n/) // body untouched
})

test('THE HAZARD: writing again NEVER appends a second `now:` key', async () => {
  await updateProjectNow('demo', 'a second state')
  await updateProjectNow('demo', 'a third state')
  assert.deepEqual(nowLines(pagePath), ['now: a third state'])
  const fm = fmOf(pagePath)
  assert.equal(fm.now, 'a third state')
  assert.equal(fm.type, 'project') // a duplicated key would have untyped it
  assert.equal(fm.goal, 'does a thing')
})

test('a page a union merge already doubled is REPAIRED to a single key', async () => {
  assert.equal(nowLines(dupePath).length, 2) // the damage the fixture starts with
  const r = await updateProjectNow('doubled', 'one line again')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(nowLines(dupePath), ['now: one line again'])
  assert.equal(fmOf(dupePath).now, 'one line again')
  assert.equal(fmOf(dupePath).type, 'project')
})

test('an unchanged value is a no-op, not a rewrite (no `updated:` churn)', async () => {
  const before = read(pagePath)
  assert.deepEqual(await updateProjectNow('demo', 'a third state'), { ok: true, skipped: 'unchanged' })
  assert.equal(read(pagePath), before)
})

test('an unknown repo key finds no page — nothing is written', async () => {
  assert.deepEqual(await updateProjectNow('not-a-repo', 'x'), { ok: false, skipped: 'no project page' })
})

test('an empty signal is refused before anything is resolved', async () => {
  assert.deepEqual(await updateProjectNow('demo', '   '), { ok: false, skipped: 'empty' })
})

test('the write really went through the serial queue — committed and pushed', () => {
  assert.equal(git(vault, 'status', '--porcelain'), '') // nothing left dirty
  assert.equal(git(vault, 'rev-parse', 'HEAD'), git(vault, 'rev-parse', 'origin/main'))
  assert.match(git(vault, 'log', '-1', '--pretty=%s'), /now \(dev agent\)/)
})

/* --- rewriteNow in isolation: the idempotence contract ----------------- */

test('a page with no `now:` key gets exactly ONE, right below `goal:`', () => {
  const out = rewriteNow('---\ntype: project\ngoal: "g"\nagent_repo: x\n---\n\n# X\n', 'fresh')
  assert.equal(out.split('\n').filter((l) => /^now:/.test(l)).length, 1)
  assert.match(out, /^goal: "g"\nnow: fresh$/m)
  assert.equal(frontmatter(out).type, 'project')
})

test('a value that could be mis-parsed as YAML is quoted, not left bare', () => {
  const src = '---\ntype: project\ngoal: "g"\nnow: old\n---\n\n# X\n'
  assert.match(rewriteNow(src, 'shipping: the API rewrite'), /^now: "shipping: the API rewrite"$/m)
  assert.match(rewriteNow(src, '- a leading dash'), /^now: "- a leading dash"$/m)
  // …and the page still parses, with the value intact.
  assert.equal(frontmatter(rewriteNow(src, 'shipping: the API rewrite')).now, 'shipping: the API rewrite')
  assert.equal(frontmatter(rewriteNow(src, '- a leading dash')).now, '- a leading dash')
})

test('no frontmatter → null (nothing is invented on a bare page)', () => {
  assert.equal(rewriteNow('# just a heading\n', 'x'), null)
})
