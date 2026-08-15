/* ------------------------------------------------------------------ *
 * Tests for scripts/seed-self-card.mjs — the kit seeding its OWN project card
 * into a fresh vault (docs/SETUP.md step 8 / docs/SETUP-AGENT.md).
 *
 * What it guards:
 *   • IDEMPOTENCE — the contract. An existing page is never overwritten, so a
 *     re-run after the operator rewrote the goal (or an agent's ATLAS:NOW moved
 *     `now:`) changes nothing.
 *   • Placeholder fill — the box-specific values land, and a line whose value is
 *     EMPTY is dropped rather than left as a hollow frontmatter key.
 *   • The page the template produces is a real card: `type: project` + a
 *     non-empty `goal:` (what listProjects requires) + the redeploy pair.
 *   • The write goes through the serial commit queue — a commit lands on the
 *     vault's branch, not a bare file drop.
 *
 * Hermetic: a temp bare "origin" + a temp vault clone, run with VAULT_PATH
 * pointed at it. Local git only — no network, no real vault.
 *
 * Run: node --test api/test/seed-self-card.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import yaml from 'js-yaml'
import { fillTemplate, normalizeGithub, agentRepoKeyFor, parseArgs } from '../../scripts/seed-self-card.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'seed-self-card.mjs')
const TEMPLATE = join(REPO_ROOT, 'infra', 'atlas-kit-card.template.md')
const PAGE = 'Wiki/Projects/Atlas-Kit.md'
const GIT_ISO = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8', env: { ...process.env, ...GIT_ISO } })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}

/** A vault clone with Wiki/ + Tasks/, tracking a local bare origin. */
function makeVault() {
  const root = mkdtempSync(join(tmpdir(), 'atlas-kit-seed-'))
  const origin = join(root, 'origin.git')
  const vault = join(root, 'vault')
  git(root, 'init', '--bare', '-b', 'main', origin)
  git(root, 'clone', '--quiet', origin, vault)
  git(vault, 'config', 'user.email', 'test@example.com')
  git(vault, 'config', 'user.name', 'Test')
  mkdirSync(join(vault, 'Wiki', 'Projects'), { recursive: true })
  mkdirSync(join(vault, 'Tasks'), { recursive: true })
  writeFileSync(join(vault, 'Wiki', 'index.md'), '# Index\n')
  git(vault, 'add', '-A')
  git(vault, 'commit', '--quiet', '-m', 'vault base')
  git(vault, 'push', '--quiet', 'origin', 'main')
  return { root, vault, git: (...a) => git(vault, ...a) }
}

function seed(vault, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      ...GIT_ISO,
      VAULT_PATH: vault,
      // Pin the registry away from any operator-local vaults.json.
      VAULTS_FILE: join(vault, '.no-such-registry.json'),
      // No spawn allowlist on this box → the AGENT_REPO line must drop out.
      AGENT_LOCAL_REPOS: join(vault, '.no-such-repos.json'),
    },
  })
}

const frontmatter = (md) => yaml.load(/^---\n([\s\S]*?)\n---/.exec(md)[1])

test('seeds a real card: type + goal + the redeploy pair, committed through the queue', () => {
  const v = makeVault()
  const r = seed(v.vault, ['--repo-path=/srv/atlas-kit', '--github=git@github.com:someone/atlas-kit.git'])
  assert.equal(r.status, 0, r.stderr)
  const abs = join(v.vault, PAGE)
  assert.ok(existsSync(abs), 'the page exists in the working tree')
  const fm = frontmatter(readFileSync(abs, 'utf-8'))
  // listProjects' membership rule — without BOTH of these nothing renders.
  assert.equal(fm.type, 'project')
  assert.ok(String(fm.goal || '').trim(), 'a non-empty goal is what makes it a card')
  assert.equal(fm.self_deploy, true)
  assert.equal(fm.repo_path, '/srv/atlas-kit')
  assert.equal(fm.github, 'https://github.com/someone/atlas-kit', 'ssh remote normalized to a browsable URL')
  assert.ok(String(fm.now || '').trim(), 'seeds an initial now: line for the card')
  // Through the commit queue, not a bare write: the vault has a commit for it.
  assert.match(v.git('log', '-1', '--format=%s'), /seed the Atlas Kit card/)
  assert.equal(v.git('status', '--porcelain'), '', 'nothing left uncommitted')
})

test('re-running never overwrites — the operator’s edits survive', () => {
  const v = makeVault()
  assert.equal(seed(v.vault, ['--repo-path=/srv/atlas-kit']).status, 0)
  const abs = join(v.vault, PAGE)
  const edited = readFileSync(abs, 'utf-8').replace(/^goal:.*$/m, 'goal: My own goal, thanks')
  writeFileSync(abs, edited)
  v.git('commit', '--quiet', '-am', 'operator edits the goal')

  const again = seed(v.vault, ['--repo-path=/srv/somewhere-else'])
  assert.equal(again.status, 0, 'a re-run is a success, not an error')
  assert.match(again.stdout, /already exists/)
  assert.equal(readFileSync(abs, 'utf-8'), edited, 'the page is byte-identical')
  assert.equal(v.git('log', '-1', '--format=%s'), 'operator edits the goal', 'no second commit')
})

test('no vault configured / no Wiki/ → refuses loudly instead of writing somewhere odd', () => {
  const empty = mkdtempSync(join(tmpdir(), 'atlas-kit-novault-'))
  const r = seed(empty)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /Wiki\//)
})

test('an empty placeholder drops its whole line (no hollow frontmatter key)', () => {
  const filled = fillTemplate('type: project\nagent_repo: {{AGENT_REPO}}\nrepo_path: {{REPO_PATH}}\n# {{REPO_PATH}} body', {
    AGENT_REPO: '',
    REPO_PATH: '/srv/kit',
  })
  assert.equal(filled, 'type: project\nrepo_path: /srv/kit\n# /srv/kit body')
})

test('the shipped template fills cleanly and yields parseable YAML both ways', () => {
  const raw = readFileSync(TEMPLATE, 'utf-8')
  const values = { TODAY: '2026-08-15', REPO_PATH: '/srv/atlas-kit', GITHUB: 'https://example.com/kit', AGENT_REPO: 'atlas-kit' }
  const withKey = fillTemplate(raw, values)
  assert.doesNotMatch(withKey, /\{\{/, 'every placeholder was substituted')
  assert.equal(frontmatter(withKey).agent_repo, 'atlas-kit')
  const withoutKey = fillTemplate(raw, { ...values, AGENT_REPO: '' })
  const fm = frontmatter(withoutKey)
  assert.equal(fm.agent_repo, undefined, 'no spawn key registered → the key is absent, not empty')
  assert.equal(fm.type, 'project')
  assert.equal(fm.self_deploy, true)
})

test('normalizeGithub: ssh/https/none', () => {
  assert.equal(normalizeGithub('git@github.com:someone/kit.git'), 'https://github.com/someone/kit')
  assert.equal(normalizeGithub('ssh://git@github.com/someone/kit.git'), 'https://github.com/someone/kit')
  assert.equal(normalizeGithub('https://github.com/someone/kit.git'), 'https://github.com/someone/kit')
  assert.equal(normalizeGithub(''), '')
})

test('agentRepoKeyFor: matches a key by checkout path, ignores the example comment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-kit-repos-'))
  const file = join(dir, 'repos.json')
  writeFileSync(file, JSON.stringify({ _comment: 'not a repo', other: { path: '/srv/other' }, kit: { path: '/srv/kit/' } }))
  assert.equal(agentRepoKeyFor('/srv/kit', file), 'kit', 'trailing slash still matches')
  assert.equal(agentRepoKeyFor('/srv/nothing', file), '')
  assert.equal(agentRepoKeyFor('/srv/kit', join(dir, 'missing.json')), '', 'no allowlist yet → no key, not a crash')
})

test('parseArgs takes --key=value and --key value', () => {
  assert.deepEqual(parseArgs(['--repo-path=/a', '--vault', 'atlas', 'noise']), { 'repo-path': '/a', vault: 'atlas' })
})
