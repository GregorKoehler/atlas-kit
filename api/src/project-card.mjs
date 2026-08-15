/* ------------------------------------------------------------------ *
 * The project-card "Now" signal — a dev agent's end-of-run line, applied to its
 * project's card.
 *
 * A BOX-LOCAL dev agent ends a reply with `ATLAS:NOW <one line>` when its run
 * changed what the project is about (CARD_PREAMBLE, agent-routes.mjs).
 * scanNowMarker (subagent-scan.mjs) lifts the LATEST such line out of the
 * transcript and the executor (agent-local.mjs) calls updateProjectNow, which
 * rewrites `now:` on the matching Wiki/Projects/*.md page and commits it through
 * the SERIAL vault commit queue (atlas-commit-queue.mjs) — the one serialization
 * point every vault writer on this box shares. The mutation runs INSIDE the
 * queue's lock, after its pull --rebase, so no other writer can interleave
 * between the read and the commit.
 *
 * Only `now` is agent-writable. `goal:` stays operator-owned — it is also the
 * card's membership opt-in (listProjects), so an agent able to write it could
 * invent cards. The page is matched by its `agent_repo` frontmatter, the SAME
 * key the agent was spawned with, so the agent never names a file path.
 *
 * READ AND WRITE MUST NAME THE SAME VAULT. The card is READ by listProjects()
 * out of read-routes' VAULT (projectsVaultPath()); the write resolves the
 * registry KEY whose path IS that vault and hands that key to the queue. If no
 * registered vault matches we skip rather than guess — a card read from one file
 * and written to another loses every update in silence.
 *
 * ⚠️ THE `now:` REWRITE MUST BE IDEMPOTENT — EXACTLY ONE KEY, ALWAYS.
 * The vault carries `*.md merge=union` (README, docs/SETUP.md) so its
 * append-only files merge without conflicts. Union merge does not understand
 * YAML: when two sides carry a DIFFERENT `now:` line for the same page — a
 * paired-worker `atlas/*` branch merged by enqueueAtlasMerge, or a phone's
 * Obsidian Git sync racing the queue's rebase — union keeps BOTH lines. A page
 * with two `now:` keys no longer round-trips through js-yaml, so every
 * frontmatter reader in the kit (listProjects, the typed query engine, the type
 * registry) sees a broken page and the card UNTYPES off the dashboard. So
 * rewriteNow REPLACES the first `now:` in place and DROPS every later one —
 * repairing a page a previous union merge already doubled — and never appends.
 * Pinned by api/test/project-card-now.test.mjs.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { listVaults } from './vaults.mjs'
import { listProjects, projectsVaultPath } from './read-routes.mjs'
import { enqueueAtlasCommit } from './atlas-commit-queue.mjs'

// First `--- … ---` frontmatter block of a markdown file → { body, start, end }.
function frontmatterBlock(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  return m ? { body: m[1], start: m.index, end: m.index + m[0].length } : null
}

function stripQuotes(s) {
  const t = String(s).trim()
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1)
  return t
}

// Render a one-line value as a YAML scalar: plain when safe (matching the
// hand-written style of the project pages), double-quoted when a plain scalar
// could be mis-parsed (a leading indicator, an embedded ": ", a trailing ":"/"#").
// A JSON string literal is a valid YAML double-quoted scalar.
function yamlScalar(v) {
  const s = String(v).trim()
  if (s === '' || /^[-!&*?|>%@`"'#,[\]{}]/.test(s) || /:\s/.test(s) || /\s#/.test(s) || /[:#]$/.test(s)) return JSON.stringify(s)
  return s
}

const keyRe = (k) => new RegExp(`^[ \\t]*${k}[ \\t]*:`)

// Set `key` to EXACTLY ONE line in a frontmatter line array: the first
// occurrence is replaced in place, every later one is DROPPED (the union-merge
// repair — see the header). `after` names the key to insert below when the key
// is absent; `insert: false` means replace-only, never introduce the key.
function setSingle(lines, key, value, { after, insert = true } = {}) {
  const re = keyRe(key)
  const out = []
  let seen = false
  for (const l of lines) {
    if (!re.test(l)) {
      out.push(l)
      continue
    }
    if (seen) continue // a duplicate key a union merge left behind → dropped
    seen = true
    out.push(`${key}: ${value}`)
  }
  if (seen || !insert) return out
  const at = after ? out.findIndex((l) => keyRe(after).test(l)) : -1
  const i = at === -1 ? out.length : at + 1
  return [...out.slice(0, i), `${key}: ${value}`, ...out.slice(i)]
}

// What the page currently says: { count, value } over its `now:` lines.
function readNow(lines) {
  const hits = lines.filter((l) => keyRe('now').test(l))
  return { count: hits.length, value: hits.length ? stripQuotes(hits[0].replace(/^[ \t]*now[ \t]*:/, '')) : null }
}

/** Rewrite a project page's `now:` (and bump `updated:` when the page has one).
 *  Returns the new file text, or null when there is nothing to do: no
 *  frontmatter, or the page already carries exactly this value on exactly ONE
 *  `now:` line. A page with the right value on TWO lines is NOT "nothing to do"
 *  — it is damage to repair. Exported for the test; the idempotence contract
 *  lives here. */
export function rewriteNow(text, value) {
  const fm = frontmatterBlock(text)
  if (!fm) return null
  const want = String(value).trim()
  let lines = fm.body.split('\n')
  const cur = readNow(lines)
  if (cur.count === 1 && cur.value === want) return null
  lines = setSingle(lines, 'now', yamlScalar(want), { after: 'goal' })
  // `updated:` is BUMPED, never introduced — a page that does not date itself
  // stays that way. Same single-key rule (a doubled `updated:` untypes a page
  // exactly as badly). The unchanged-value short-circuit above is what keeps
  // this from churning the date on every poll.
  lines = setSingle(lines, 'updated', new Date().toISOString().slice(0, 10), { insert: false })
  return text.slice(0, fm.start) + '---\n' + lines.join('\n') + '\n---' + text.slice(fm.end)
}

// The registry KEY whose vault IS the one listProjects() reads from — the pin
// that keeps the read and write halves on the same file. null when nothing
// matches, and then we skip rather than write into some other vault.
function projectsVaultKey() {
  const want = path.resolve(projectsVaultPath())
  return listVaults().find((v) => v.path && path.resolve(v.path) === want)?.key || null
}

/* Find the card page for a spawn repo key.
 *
 * PRIMARY: listProjects(). Resolving through it means the write can only ever
 * target a page the dashboard actually renders as a card (`type: project` +
 * a non-empty `goal:`), and there is no second copy of that membership rule.
 *
 * ⚠️ FALLBACK, and it is the whole point of the idempotence contract above: a
 * page a union merge already DOUBLED does not parse as YAML, so listProjects
 * skips it — the card is off the dashboard, which is exactly when it most needs
 * repairing, and resolving only through listProjects would make the repair
 * unreachable forever. So when the primary misses we scan the same directory on
 * the RAW frontmatter text, which duplicate keys cannot break, and re-check the
 * same two membership facts by line. Deliberately last-resort: it runs only when
 * the parsed pass found nothing, so a healthy vault never reaches it. */
function findProjectPage(repoKey) {
  const hit = listProjects().find((p) => p.agentRepo && p.agentRepo === repoKey)
  if (hit) return { rel: hit.path, name: hit.name }
  const dir = path.join(projectsVaultPath(), 'Wiki', 'Projects')
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'))
  } catch {
    return null
  }
  for (const f of files.sort()) {
    const abs = path.join(dir, f)
    let fm
    try {
      fm = frontmatterBlock(fs.readFileSync(abs, 'utf-8'))
    } catch {
      continue
    }
    if (!fm) continue
    const lines = fm.body.split('\n')
    const val = (k) => lines.find((l) => keyRe(k).test(l))?.replace(keyRe(k), '') ?? ''
    if (stripQuotes(val('type')) !== 'project') continue
    if (!stripQuotes(val('goal'))) continue
    if (stripQuotes(val('agent_repo')) !== repoKey) continue
    return { rel: path.relative(projectsVaultPath(), abs), name: path.basename(f, '.md') }
  }
  return null
}

/**
 * Apply a dev agent's `ATLAS:NOW` signal to its project card. `repoKey` is the
 * spawn repo key, `value` the one-line state. Best-effort — never throws (the
 * queue folds git failures into a `warning`); returns a small status object the
 * caller logs.
 */
export async function updateProjectNow(repoKey, value) {
  const text = String(value || '').trim()
  if (!repoKey || !text) return { ok: false, skipped: 'empty' }
  const vault = projectsVaultKey()
  if (!vault) return { ok: false, skipped: 'no projects vault' }
  const project = findProjectPage(repoKey)
  if (!project) return { ok: false, skipped: 'no project page' }
  const rel = project.rel
  let changed = false
  const r = await enqueueAtlasCommit({
    vault,
    message: `projects: ${project.name} now (dev agent)`,
    paths: rel,
    mutate: async (vaultPath) => {
      const abs = path.join(vaultPath, rel)
      const before = fs.readFileSync(abs, 'utf-8')
      const next = rewriteNow(before, text)
      if (next == null || next === before) return
      fs.writeFileSync(abs, next)
      changed = true
    },
  })
  if (r.ok && !changed) return { ok: true, skipped: 'unchanged' }
  return r
}
