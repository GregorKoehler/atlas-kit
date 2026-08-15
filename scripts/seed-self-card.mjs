/* ------------------------------------------------------------------ *
 * Seed the kit's OWN project card into the vault — so a fresh install has a
 * card for Atlas Kit itself on the home tab from the first boot.
 *
 * Writes `Wiki/Projects/Atlas-Kit.md` from `infra/atlas-kit-card.template.md`,
 * filling in what only this box knows (the repo path, the origin URL, the spawn
 * key if one is registered) — through the SAME serial commit queue every other
 * vault writer uses, so it can never race the Kanban or a knowledge agent.
 *
 * IDEMPOTENT, and that is the whole contract: an existing page is NEVER
 * overwritten. Re-running it after the operator has rewritten the goal, logged
 * decisions in the body, or let an agent's `ATLAS:NOW` update it is a no-op.
 * Run by both setup paths (docs/SETUP.md step 8, docs/SETUP-AGENT.md's step 8
 * check) — one script, so neither prose has to restate the logic.
 *
 *   node --env-file=.env scripts/seed-self-card.mjs
 *   node --env-file=.env scripts/seed-self-card.mjs --repo-path=/srv/atlas-kit --agent-repo=atlas-kit
 *
 * Options (all optional — the defaults read this checkout):
 *   --vault=<key>        vaults.json key to write to (default: the default vault)
 *   --repo-path=<abs>    the kit checkout (default: this repo)
 *   --github=<url>       project URL (default: this repo's origin, as https)
 *   --agent-repo=<key>   spawn key for the card's dev agents (default: the
 *                        agent-local-repos.json key pointing at --repo-path)
 *   --page=<rel>         vault-relative target (default: Wiki/Projects/Atlas-Kit.md)
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { resolveVault, defaultVaultKey } from '../api/src/vaults.mjs'
import { enqueueAtlasCommit } from '../api/src/atlas-commit-queue.mjs'

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const TEMPLATE = path.join(ROOT, 'infra', 'atlas-kit-card.template.md')
const DEFAULT_PAGE = 'Wiki/Projects/Atlas-Kit.md'

/** `--key=value` / `--key value` → { key: value }. */
export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i])
    if (!m) continue
    out[m[1]] = m[2] !== undefined ? m[2] : argv[++i] || ''
  }
  return out
}

/** Fill `{{KEY}}` placeholders. A line whose placeholder resolves to EMPTY is
 *  DROPPED entirely — `agent_repo:` with no value would be a frontmatter key
 *  promising an agent surface that isn't configured. */
export function fillTemplate(text, values) {
  const out = []
  for (const line of text.split('\n')) {
    const keys = [...line.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1])
    if (keys.length && keys.some((k) => !String(values[k] ?? '').trim())) continue
    out.push(line.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => String(values[k] ?? '')))
  }
  return out.join('\n')
}

/** A git remote URL as a browsable https URL ('' when there is no remote). */
export function normalizeGithub(url) {
  const s = String(url || '').trim()
  if (!s) return ''
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?$/.exec(s)
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`
  return s.replace(/\.git$/, '')
}

/** The box-local spawn key whose checkout IS this repo, or '' when none is
 *  registered yet (the card then renders without an agent surface, and adding
 *  the key later is a one-line vault edit). Reads the allowlist directly rather
 *  than importing the agent runtime — a setup script should not boot it. */
export function agentRepoKeyFor(repoPath, reposFile) {
  let repos
  try {
    repos = JSON.parse(fs.readFileSync(reposFile, 'utf-8'))
  } catch {
    return ''
  }
  const want = path.resolve(repoPath)
  for (const [key, cfg] of Object.entries(repos)) {
    if (!cfg || typeof cfg !== 'object') continue // the example file's "_comment"
    if (cfg.path && path.resolve(cfg.path) === want) return key
  }
  return ''
}

function gitOrigin(repoPath) {
  try {
    return execFileSync('git', ['-C', repoPath, 'remote', 'get-url', 'origin'], {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()
  } catch {
    return ''
  }
}

/** The page text this box would seed — the placeholder fill, with no I/O of its
 *  own beyond reading the template. Exported for the test. */
export function renderCard(args = {}) {
  const repoPath = path.resolve(args['repo-path'] || ROOT)
  const values = {
    TODAY: new Date().toISOString().slice(0, 10),
    REPO_PATH: repoPath,
    GITHUB: normalizeGithub(args.github || gitOrigin(repoPath)),
    AGENT_REPO:
      args['agent-repo'] ||
      agentRepoKeyFor(
        repoPath,
        process.env.AGENT_LOCAL_REPOS || path.join(ROOT, 'api', 'src', 'agent-local-repos.json'),
      ),
  }
  return { values, text: fillTemplate(fs.readFileSync(args.template || TEMPLATE, 'utf-8'), values) }
}

/* --- run ------------------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const vaultKey = args.vault || defaultVaultKey()
  const vault = resolveVault(vaultKey)
  if (!vault) {
    console.error(`seed-self-card: no "${vaultKey}" vault configured — set VAULT_PATH in .env first`)
    process.exit(1)
  }
  if (!fs.existsSync(path.join(vault.path, 'Wiki'))) {
    console.error(`seed-self-card: ${vault.path} has no Wiki/ — is VAULT_PATH pointing at your vault?`)
    process.exit(1)
  }

  const rel = args.page || DEFAULT_PAGE
  if (fs.existsSync(path.join(vault.path, rel))) {
    console.log(`seed-self-card: ${rel} already exists in ${vault.path} — left untouched`)
    process.exit(0)
  }

  const { values, text } = renderCard(args)
  const r = await enqueueAtlasCommit({
    vault: vaultKey,
    message: 'projects: seed the Atlas Kit card',
    paths: rel,
    mutate: async (root) => {
      const target = path.join(root, rel)
      // Re-check INSIDE the queue's lock: its pull --rebase runs first, so the
      // page may have arrived from another machine since the check above.
      if (fs.existsSync(target)) return
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, text)
    },
  })

  if (!r.ok) {
    console.error(`seed-self-card: ${r.warning}`)
    process.exit(1)
  }
  if (!r.committed) {
    console.log(`seed-self-card: ${rel} already in the vault — nothing to do`)
    process.exit(0)
  }
  console.log(`seed-self-card: wrote ${rel} → ${vault.path} (committed)`)
  console.log(`  repo_path:  ${values.REPO_PATH}`)
  console.log(`  github:     ${values.GITHUB || '(no origin remote — add github: yourself)'}`)
  console.log(
    values.AGENT_REPO
      ? `  agent_repo: ${values.AGENT_REPO} — dev agents spawn on this card`
      : '  agent_repo: (none) — add the key from agent-local-repos.json to spawn dev agents here',
  )
}

// Run only when EXECUTED, not when imported (the test imports the helpers above
// — same rule as scripts/serve.sh's dispatch guard).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  await main()
}
