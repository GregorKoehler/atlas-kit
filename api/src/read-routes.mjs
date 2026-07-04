/* ------------------------------------------------------------------ *
 * Read-only vault API.
 *
 * Serves the GET /api/* read contract the dashboard uses, live off the
 * vault working tree: notes, the wiki (index/log/pages/graph), full-text
 * search, the typed Atlas query + type registry, the Kanban's Tasks/, and
 * the project cards (Wiki/Projects/). These routes are open (no bearer);
 * in production Cloudflare Access gates the whole origin. All file access
 * is restricted to the vault root + an allowlist; paths reject traversal.
 * ------------------------------------------------------------------ */
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { runInVault, currentVaultPath, currentVaultKey } from './vaults.mjs'
import { loadFlags, flagKey } from './atlas-type-flags.mjs'
import { queryAtlas } from './atlas-query.mjs'

const execFileAsync = promisify(execFile)
// The default vault path. DATA_DIR, /api/data, the dashboard bundle and projects
// read from it. The wiki/note/search/tasks/atlas routes are vault-aware: they read
// currentVaultPath() (set per-request from ?vault=) instead.
const VAULT = process.env.VAULT_PATH || process.env.VAULT_DIR || '/vault'
const DATA_DIR = process.env.DATA_DIR || path.join(VAULT, 'data')
const WORKSPACE = process.env.WORKSPACE_DIR || '/workspace'

// Machine-written scorecard/heatmap JSON (optional; e.g. scripts/refresh-github.mjs).
const DATA_ALLOWLIST = new Set(['scorecard', 'heatmap'])
const NOTE_FOLDERS = new Set(['Wiki', 'Tasks'])

// Image types served by GET /api/asset, restricted to the vault's assets dirs.
const ASSET_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
}

function safeJoin(rel) {
  if (!rel) return null
  const root = currentVaultPath()
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return abs
}

function readMd(abs) {
  try {
    return fs.readFileSync(abs, 'utf-8')
  } catch {
    return null
  }
}

function stripFrontmatter(md) {
  if (md.startsWith('---')) {
    const end = md.indexOf('\n---', 3)
    if (end !== -1) {
      const after = md.indexOf('\n', end + 1)
      return after !== -1 ? md.slice(after + 1) : ''
    }
  }
  return md
}

function firstHeading(md, fallback) {
  for (const line of stripFrontmatter(md).split('\n')) {
    const m = line.match(/^#\s+(.+)$/)
    if (m) return m[1].trim()
  }
  return fallback
}

function listMdRecursive(absDir, out = []) {
  let entries = []
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const abs = path.join(absDir, e.name)
    if (e.isDirectory()) listMdRecursive(abs, out)
    else if (e.name.toLowerCase().endsWith('.md')) out.push(abs)
  }
  return out
}

function toRecord(abs) {
  const rel = path.relative(currentVaultPath(), abs)
  let mtime = 0
  try {
    mtime = fs.statSync(abs).mtimeMs
  } catch {
    /* ignore */
  }
  return { title: path.basename(abs, '.md'), path: rel, folder: path.dirname(rel), mtime }
}

function wikiPages() {
  return listMdRecursive(path.join(currentVaultPath(), 'Wiki')).map(toRecord)
}

// Parsed contents of a data/<name>.json file, or null. (GET /api/data/:name
// sends the raw text; the dashboard bundle needs parsed objects.)
function readData(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name + '.json'), 'utf-8'))
  } catch {
    return null
  }
}

// One bundled payload for the home dashboard's polling cards, so the dashboard
// makes a single request per refresh. Only fast, file-backed data goes here;
// slow / independently-cached things (projects' git lookups, the wiki graph, the
// agent stats) keep their own endpoints. scorecard/heatmap are optional machine-
// written JSON (see scripts/refresh-github.mjs); they read as null when absent.
function dashboardBundle() {
  return {
    scorecard: readData('scorecard'),
    heatmap: readData('heatmap'),
    wikiPages: wikiPages(),
  }
}

// Parse a note's YAML frontmatter into an object ({} if none/invalid).
function frontmatter(md) {
  if (!md.startsWith('---')) return {}
  const end = md.indexOf('\n---', 3)
  if (end === -1) return {}
  try {
    return yaml.load(md.slice(3, end)) || {}
  } catch {
    return {}
  }
}

function noteTags(md) {
  const t = frontmatter(md).tags
  return Array.isArray(t) ? t.map((x) => String(x)) : []
}

// Each Wiki/Projects/<name>.md is a project (type: project). Frontmatter carries
// tag / optional repo / now / goal; the H1 is the display name.
function listProjects() {
  const dir = path.join(VAULT, 'Wiki', 'Projects')
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'))
  } catch {
    return []
  }
  const out = []
  for (const f of files.sort()) {
    const abs = path.join(dir, f)
    const md = readMd(abs)
    if (md == null) continue
    const fm = frontmatter(md)
    out.push({
      name: firstHeading(md, path.basename(f, '.md')),
      tag: String(fm.tag || ''),
      // The agent-repo KEY (a box-local or bridge repo key) this project's dev
      // agents spawn on (empty = no agent card, just a KB card).
      agentRepo: String(fm.agent_repo || ''),
      repo: String(fm.repo || ''),
      github: String(fm.github || ''),
      now: String(fm.now || ''),
      goal: String(fm.goal || ''),
      path: path.relative(VAULT, abs),
    })
  }
  return out
}

// Count notes (excluding the project pages themselves) whose tags include each
// project tag — the "KB footprint" of a project. One vault scan for all tags.
function relatedCounts(tags) {
  const counts = new Map()
  if (!tags.size) return counts
  const projectsDir = path.join(VAULT, 'Wiki', 'Projects') + path.sep
  for (const abs of listMdRecursive(VAULT)) {
    if (abs.startsWith(projectsDir)) continue
    const md = readMd(abs)
    if (md == null) continue
    for (const t of noteTags(md)) if (tags.has(t)) counts.set(t, (counts.get(t) || 0) + 1)
  }
  return counts
}

// Last commit for a repo path: {hash, subject, relative, author, committedAt},
// or null if the path isn't a reachable git repo. execFile (no shell) + a short
// timeout; \x1f field separator so a subject can contain anything.
async function gitLastCommit(repo) {
  if (!repo) return null
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', repo, '-c', `safe.directory=${repo}`, 'log', '-1', '--format=%h%x1f%s%x1f%cr%x1f%an%x1f%cI'],
      { encoding: 'utf-8', timeout: 4000 },
    )
    const [hash, subject, relative, author, committedAt] = stdout.trim().split('\x1f')
    return hash ? { hash, subject, relative, author, committedAt } : null
  } catch {
    return null
  }
}

// "X minutes ago" from an ISO timestamp (GitHub gives ISO, not git's %cr).
function relativeTime(iso) {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  for (const [label, secs] of [
    ['year', 31536000],
    ['month', 2592000],
    ['week', 604800],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
  ]) {
    const n = Math.floor(s / secs)
    if (n >= 1) return `${n} ${label}${n > 1 ? 's' : ''} ago`
  }
  return `${s} second${s === 1 ? '' : 's'} ago`
}

function parseGithubRepo(url) {
  const m = String(url || '').match(/github\.com[/:]([^/\s]+)\/([^/\s.]+)/i)
  return m ? { owner: m[1], repo: m[2] } : null
}

// The operator's PAT. node's --env-file doesn't reliably expose GITHUB_TOKEN to
// process.env, so fall back to reading it straight from .env (same as the
// /api/refresh/github route). This token has access to private repos.
function githubToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN
  try {
    const m = fs.readFileSync(path.join(WORKSPACE, '.env'), 'utf-8').match(/^GITHUB_TOKEN=(.+)$/m)
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  } catch {
    /* ignore */
  }
  return ''
}

// Latest commit for a remote repo via the GitHub API — for projects with a
// `github:` URL but no local checkout. Cached (TTL) so the 30s dashboard poll
// doesn't burn the rate limit; uses GITHUB_TOKEN when present.
const ghCommitCache = new Map() // "owner/repo" → { at, commit }
const GH_COMMIT_TTL_MS = 5 * 60 * 1000
async function githubLastCommit(url) {
  const g = parseGithubRepo(url)
  if (!g) return null
  const key = `${g.owner}/${g.repo}`
  const hit = ghCommitCache.get(key)
  if (hit && Date.now() - hit.at < GH_COMMIT_TTL_MS) return hit.commit
  try {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'atlas-kit' }
    const token = githubToken()
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(`https://api.github.com/repos/${g.owner}/${g.repo}/commits?per_page=1`, {
      headers,
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return null
    const arr = await res.json()
    const c = Array.isArray(arr) ? arr[0] : null
    if (!c) return null
    const when = c.commit?.committer?.date || c.commit?.author?.date || ''
    const commit = {
      hash: String(c.sha || '').slice(0, 7),
      subject: String(c.commit?.message || '').split('\n')[0],
      relative: relativeTime(when),
      author: c.commit?.author?.name || c.author?.login || '',
      committedAt: when,
    }
    ghCommitCache.set(key, { at: Date.now(), commit })
    return commit
  } catch {
    return null
  }
}

// Category for a wiki page = its folder segment under Wiki/ (Topics, People,
// Organizations, Concepts, Sources). Pages directly in Wiki/ → 'Wiki'.
function wikiCategory(rel) {
  const parts = rel.split(path.sep)
  const i = parts.indexOf('Wiki')
  return i !== -1 && parts.length > i + 2 ? parts[i + 1] : 'Wiki'
}

// Build the wiki knowledge graph: one node per page, edges from [[wikilinks]] AND
// from the Atlas's TYPED frontmatter edges — so the graph carries edge *type* and
// *direction*, not just connectivity. index.md and log.md are navigation — excluded.
//
// Each typed edge key maps to a semantic family (drives colour + the lens switcher
// on the client) and whether the relation is directional (gets an arrowhead).
// Plain prose [[links]] fall through as the untyped 'link' family, so a vault with
// no typed frontmatter (the plain LLM-wikis) yields the same all-grey graph as before.
const EDGE_FAMILY = {
  depends_on: { family: 'dependency', directed: true },
  owes: { family: 'obligation', directed: true },
  owed_by: { family: 'obligation', directed: true },
  for_project: { family: 'membership', directed: true },
  for_project_idea: { family: 'membership', directed: true },
  area: { family: 'membership', directed: true },
  stakeholders: { family: 'membership', directed: true },
  works_with: { family: 'social', directed: false },
  mentor: { family: 'social', directed: true },
  related: { family: 'semantic', directed: false },
  extends: { family: 'semantic', directed: true },
  // a sibling vault' recipe edge family (Wiki/Legend.md) — each key its own family so
  // the graph colours + lenses read the ingredient-centric structure. `ingredients`
  // is the core recipe→ingredient join ("what uses X"); the shared core
  // (depends_on/area/related) above already covers a recipe's rarer typed links.
  ingredients: { family: 'ingredients', directed: true },
  uses_technique: { family: 'uses_technique', directed: true },
  variant_of: { family: 'variant_of', directed: true },
  pairs_with: { family: 'pairs_with', directed: false },
  substitute_for: { family: 'substitute_for', directed: true },
  from_source: { family: 'from_source', directed: true },
  recipe: { family: 'recipe', directed: true },
}
const EDGE_KEYS = Object.keys(EDGE_FAMILY)

// [[wikilink]] target basenames (alias/anchor stripped) found anywhere in `text`.
function linkNames(text) {
  const out = []
  for (const m of String(text).matchAll(/\[\[([^\]]+)\]\]/g)) {
    const name = m[1].split('|')[0].split('#')[0].trim()
    if (name) out.push(name)
  }
  return out
}

// The knowledge graph: Wiki/ pages and Tasks/ notes as nodes, joined by their TYPED
// frontmatter edges (EDGE_FAMILY -- carried through with key, family and direction)
// and their prose [[wikilinks]] (untyped, added only where no typed edge already
// joins the pair). A [[link]] to a not-yet-created page becomes a faint "Unresolved"
// hub ONLY when a task points at it -- so project/area names cluster their tasks
// without inflating a Wiki-only vault's graph. index/log are excluded.
function wikiGraph() {
  const root = currentVaultPath()
  const wikiFiles = listMdRecursive(path.join(root, 'Wiki')).filter(
    (abs) => !/^(index|log)$/i.test(path.basename(abs, '.md')),
  )
  const nodes = []
  const byName = new Map() // lowercased basename -> node id
  const records = [] // { id, fm, md, isTask }
  for (const abs of wikiFiles) {
    const md = readMd(abs)
    if (md == null) continue
    const rel = path.relative(root, abs)
    const id = path.basename(abs, '.md')
    nodes.push({ id, title: firstHeading(md, id), path: rel, type: wikiCategory(rel), degree: 0 })
    byName.set(id.toLowerCase(), id)
    records.push({ id, fm: frontmatter(md), md, isTask: false })
  }

  // Tasks/ notes -- first-class nodes carrying their lifecycle status + due date.
  // Skip a typed non-task and never shadow a Wiki page's name.
  for (const abs of listMdRecursive(path.join(root, 'Tasks'))) {
    const md = readMd(abs)
    if (md == null) continue
    const fm = frontmatter(md)
    if (fm.type && fm.type !== 'task') continue
    const id = path.basename(abs, '.md')
    if (byName.has(id.toLowerCase())) continue
    nodes.push({
      id,
      title: taskTitle(md, id),
      path: path.relative(root, abs),
      type: 'Tasks',
      degree: 0,
      status: typeof fm.status === 'string' ? fm.status : null,
      due: dateStr(fm.due),
    })
    byName.set(id.toLowerCase(), id)
    records.push({ id, fm, md, isTask: true })
  }

  // Resolve a [[target]] name to a node id; a task pointing at a missing page mints
  // a faint Unresolved hub (and only a task does -- keeps Wiki-only vaults clean).
  const resolve = (name, fromIsTask) => {
    let to = byName.get(name.toLowerCase())
    if (!to && fromIsTask) {
      nodes.push({ id: name, title: name, path: '', type: 'Unresolved', degree: 0 })
      byName.set(name.toLowerCase(), name)
      to = name
    }
    return to
  }

  const links = []
  const typedPairs = new Set() // unordered pairs already joined by a typed edge
  const pairKey = (a, b) => (a < b ? `${a} ${b}` : `${b} ${a}`)

  // Pass 1 -- typed frontmatter edges (with key, family and direction).
  const seenTyped = new Set()
  for (const rec of records) {
    for (const key of EDGE_KEYS) {
      if (rec.fm[key] == null) continue
      const { family, directed } = EDGE_FAMILY[key]
      for (const name of linkTargets(rec.fm[key])) {
        const to = resolve(name, rec.isTask)
        if (!to || to === rec.id) continue
        const dk = directed ? `${rec.id} >${to} ${key}` : `${pairKey(rec.id, to)} ${key}`
        if (seenTyped.has(dk)) continue
        seenTyped.add(dk)
        links.push({ source: rec.id, target: to, type: key, family, directed })
        typedPairs.add(pairKey(rec.id, to))
      }
    }
  }
  // Pass 2 -- untyped prose [[wikilinks]], skipping pairs already typed.
  const seenLink = new Set()
  for (const rec of records) {
    for (const name of linkNames(rec.md)) {
      const to = resolve(name, rec.isTask)
      if (!to || to === rec.id) continue
      const pk = pairKey(rec.id, to)
      if (typedPairs.has(pk) || seenLink.has(pk)) continue
      seenLink.add(pk)
      links.push({ source: rec.id, target: to, type: 'link', family: 'link', directed: false })
    }
  }
  // Degree = distinct neighbours (stable node sizing regardless of multi-edges).
  const nbr = new Map()
  const join = (a, b) => (nbr.get(a) ?? nbr.set(a, new Set()).get(a)).add(b)
  for (const l of links) {
    join(l.source, l.target)
    join(l.target, l.source)
  }
  for (const n of nodes) n.degree = nbr.get(n.id)?.size || 0
  return { generated: new Date().toISOString(), nodes, links }
}

// Normalise a frontmatter date to a YYYY-MM-DD string. js-yaml parses an
// unquoted `due: 2026-06-20` into a Date (the Atlas Guide / Dataview want them
// unquoted), so coerce that back to the plain calendar date; pass strings
// through (trimmed to the date part). null/absent → null.
function dateStr(v) {
  if (v == null) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10)
  const s = String(v).trim()
  return s ? s.slice(0, 10) : null
}

// Extract [[wikilink]] targets (basename, no alias/anchor) from a frontmatter
// value that may be a string or a list. A bare non-link string is kept as-is, so
// an informal `for_project: My-Project` still yields a usable label.
function linkTargets(v) {
  const arr = Array.isArray(v) ? v : v == null ? [] : [v]
  const out = []
  for (const item of arr) {
    const s = String(item)
    let matched = false
    for (const m of s.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const name = m[1].split('|')[0].split('#')[0].trim()
      if (name) {
        out.push(name)
        matched = true
      }
    }
    if (!matched && s.trim()) out.push(s.trim())
  }
  return out
}

// Display title for a task note: its H1, else the first non-empty body line
// (tasks are prose-first per the Atlas Guide — often no heading), else the
// filename. Strips leading markdown tokens and inline emphasis/links.
function taskTitle(md, fallback) {
  const h = firstHeading(md, null)
  if (h) return h
  for (const line of stripFrontmatter(md).split('\n')) {
    const clean = line
      .replace(/^\s*[#>\-*+]+\s*/, '')
      .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => (b || a).trim())
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .trim()
    if (clean) return clean
  }
  return fallback
}

// Tasks/ projection for the Kanban: each type:task note in the vault's Tasks/
// folder → its status (the lifecycle column), due/done dates, and the typed
// edges the board shows (for_project, owes, area, depends_on). Read live, so the
// board reflects the working tree on every poll; a vault with no Tasks/ → [].
function listTasks() {
  const root = currentVaultPath()
  const out = []
  for (const abs of listMdRecursive(path.join(root, 'Tasks'))) {
    const md = readMd(abs)
    if (md == null) continue
    const fm = frontmatter(md)
    if (fm.type && fm.type !== 'task') continue // skip a typed non-task (e.g. a Tasks index)
    let mtime = 0
    try {
      mtime = fs.statSync(abs).mtimeMs
    } catch {
      /* ignore */
    }
    out.push({
      path: path.relative(root, abs),
      title: taskTitle(md, path.basename(abs, '.md')),
      status: String(fm.status || '').toLowerCase(),
      priority: String(fm.priority || '').toLowerCase() || null,
      source: String(fm.source || '').toLowerCase() || null,
      due: dateStr(fm.due),
      done: dateStr(fm.done),
      created: dateStr(fm.created),
      updated: dateStr(fm.updated),
      project: linkTargets(fm.for_project)[0] || null,
      projectIdea: linkTargets(fm.for_project_idea)[0] || null,
      area: linkTargets(fm.area)[0] || null,
      owes: linkTargets(fm.owes),
      dependsOn: linkTargets(fm.depends_on),
      tags: Array.isArray(fm.tags) ? fm.tags.map((x) => String(x)) : [],
      mtime,
    })
  }
  return out
}

// The task-category vocabulary the Kanban offers in its project/area picker and
// feeds to inference: every project (Wiki/Projects/ pages + distinct for_project
// edges), every project-idea (distinct for_project_idea edges — exploratory hubs,
// not yet committed projects), and every life-area (distinct `area` edges)
// actually in use. Read live off the working tree; deduped case-insensitively
// (first casing wins), sorted.
export function listTaskCategories() {
  const root = currentVaultPath()
  const projects = new Map() // lowercased → canonical display name
  const projectIdeas = new Map()
  const areas = new Map()
  const add = (m, name) => {
    const k = name.toLowerCase()
    if (k && !m.has(k)) m.set(k, name)
  }
  // Project pages are projects even before any task points at them.
  try {
    for (const f of fs.readdirSync(path.join(root, 'Wiki', 'Projects'))) {
      if (f.toLowerCase().endsWith('.md')) add(projects, path.basename(f, '.md'))
    }
  } catch {
    /* no Projects/ dir in this vault */
  }
  // Distinct for_project / for_project_idea / area edges across the Tasks/ notes.
  for (const abs of listMdRecursive(path.join(root, 'Tasks'))) {
    const md = readMd(abs)
    if (md == null) continue
    const fm = frontmatter(md)
    if (fm.type && fm.type !== 'task') continue
    for (const p of linkTargets(fm.for_project)) add(projects, p)
    for (const pi of linkTargets(fm.for_project_idea)) add(projectIdeas, pi)
    for (const a of linkTargets(fm.area)) add(areas, a)
  }
  const sorted = (m) => [...m.values()].sort((a, b) => a.localeCompare(b))
  return { projects: sorted(projects), projectIdeas: sorted(projectIdeas), areas: sorted(areas) }
}

/* --- Atlas Type Registry ------------------------------------------------- *
 * A LIVE inventory of the typed vocabulary actually in use in a vault — node
 * types (`type:` values), edge keys (frontmatter keys whose values carry
 * [[wikilinks]]), and property keys (everything else) — cross-referenced with
 * the vault's Legend (Wiki/Legend.md, its type/edge/property registry). The
 * union surfaces drift: used-but-unregistered keys (prime duplicate candidates)
 * and registered-but-unused entries (count 0). Powers the Atlas tab's Type
 * Registry card, where the operator flags suspected duplicates. */

// True if a frontmatter value (string or list) contains a [[wikilink]] — the
// Legend's own test for whether a key is a typed EDGE vs a plain property.
function valueHasWikilink(v) {
  const arr = Array.isArray(v) ? v : [v]
  return arr.some((x) => /\[\[[^\]]+\]\]/.test(String(x)))
}

// Parse the Legend's three pipe-table sections into the declared registry:
// { node, edge, property } → [{ name, core, description }]. The name cell is
// `code`-wrapped (a leading ★ marks a fixed-core key); the description is the
// table's last column ("Means"). Descriptive parse — tolerant of absent/odd files.
function parseLegend(md) {
  const out = { node: [], edge: [], property: [] }
  if (md == null) return out
  let cur = null
  for (const line of md.split('\n')) {
    const h = line.match(/^##\s+(.+)$/)
    if (h) {
      const t = h[1].toLowerCase()
      cur = t.startsWith('node type') ? 'node' : t.startsWith('edge type') ? 'edge' : t.startsWith('propert') ? 'property' : null
      continue
    }
    if (!cur || !line.trim().startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 2) continue
    if (/^[-:\s]+$/.test(cells[0]) || /^(type|key)$/i.test(cells[0])) continue // separator / header row
    const core = cells[0].includes('★')
    const description = cells[cells.length - 1].replace(/`/g, '').trim()
    // The name cell `code`-wraps its key(s); a single row may list several
    // (e.g. `created` / `started` / `done`) — register each individually.
    const tokens = [...cells[0].matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean)
    const names = tokens.length ? tokens : [cells[0].replace(/★/g, '').trim()].filter(Boolean)
    for (const name of names) out[cur].push({ name, core, description })
  }
  return out
}

// Scan the current vault's typed content (Wiki/ + Tasks/ — where the schema
// applies; raw/ sources and data/ are out of scope) for actual usage. Returns
// { node, edge, property } maps of name → { count, examples[] }. A key counts as
// an edge if the Legend declares it one OR any observed value carries a [[link]].
function scanTypeUsage(legendEdges) {
  const root = currentVaultPath()
  const maps = { node: new Map(), edge: new Map(), property: new Map() }
  const bump = (cat, name, rel) => {
    let e = maps[cat].get(name)
    if (!e) maps[cat].set(name, (e = { count: 0, examples: [] }))
    e.count++
    if (e.examples.length < 5) e.examples.push(rel)
  }
  const files = [
    ...listMdRecursive(path.join(root, 'Wiki')),
    ...listMdRecursive(path.join(root, 'Tasks')),
  ]
  for (const abs of files) {
    const md = readMd(abs)
    if (md == null) continue
    const fm = frontmatter(md)
    if (!fm || typeof fm !== 'object' || Array.isArray(fm)) continue
    const rel = path.relative(root, abs)
    for (const [key, val] of Object.entries(fm)) {
      if (key === 'type') {
        const tv = String(val ?? '').trim()
        if (tv) bump('node', tv, rel)
        continue
      }
      bump(legendEdges.has(key) || valueHasWikilink(val) ? 'edge' : 'property', key, rel)
    }
  }
  return maps
}

// Build the Type Registry: per category, the union of the Legend's declared
// entries and live usage, each tagged registered/core + the operator's
// duplicate-flag. Sorted most-used first, then name.
function atlasTypes() {
  const vault = currentVaultKey()
  const legendMd = readMd(path.join(currentVaultPath(), 'Wiki', 'Legend.md'))
  const legend = parseLegend(legendMd)
  const usage = scanTypeUsage(new Set(legend.edge.map((e) => e.name)))
  const flags = loadFlags()
  const CATS = [
    { key: 'node', label: 'Node types' },
    { key: 'edge', label: 'Edge types' },
    { key: 'property', label: 'Properties' },
  ]
  const categories = CATS.map(({ key, label }) => {
    const byName = new Map()
    for (const e of legend[key])
      byName.set(e.name, { name: e.name, registered: true, core: e.core, description: e.description, count: 0, examples: [] })
    for (const [name, u] of usage[key]) {
      const ex = byName.get(name)
      if (ex) Object.assign(ex, { count: u.count, examples: u.examples })
      else byName.set(name, { name, registered: false, core: false, description: '', count: u.count, examples: u.examples })
    }
    const entries = [...byName.values()]
      .map((e) => ({ ...e, flagged: !!flags[flagKey(vault, key, e.name)] }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    return { key, label, entries }
  })
  return { generated: new Date().toISOString(), legendPath: 'Wiki/Legend.md', hasLegend: legendMd != null, categories }
}

function snippetFor(body, q) {
  const i = body.toLowerCase().indexOf(q)
  if (i === -1) return ''
  const start = Math.max(0, i - 40)
  const end = Math.min(body.length, i + q.length + 60)
  return (
    (start > 0 ? '…' : '') +
    body.slice(start, end).replace(/\s+/g, ' ').trim() +
    (end < body.length ? '…' : '')
  )
}

function search(q) {
  const query = q.trim().toLowerCase()
  if (!query) return []
  const root = currentVaultPath()
  const hits = []
  for (const abs of listMdRecursive(root)) {
    const md = readMd(abs)
    if (md == null) continue
    const rel = path.relative(root, abs)
    const isWiki = rel === 'Wiki' || rel.startsWith('Wiki' + path.sep)
    const body = stripFrontmatter(md)
    const title = firstHeading(md, path.basename(abs, '.md'))
    const inTitle = title.toLowerCase().includes(query) || rel.toLowerCase().includes(query)
    const inBody = body.toLowerCase().includes(query)
    if (!inTitle && !inBody) continue
    const folder = path.dirname(rel)
    hits.push({
      type: isWiki ? 'wiki' : 'note',
      title,
      subtitle: isWiki ? folder.replace(/^Wiki[/\\]?/, '') || 'Wiki' : folder === '.' ? 'vault' : folder,
      path: rel,
      score: (inTitle ? (isWiki ? 100 : 60) : 0) + (inBody ? (isWiki ? 30 : 20) : 0) + (isWiki ? 50 : 0),
      snippet: inBody ? snippetFor(body, query) : '',
    })
  }
  // data/*.json is work-only (DATA_DIR), so only fold it into results when
  // searching the default vault — not when a ?vault=… points elsewhere.
  if (root === VAULT) {
    for (const name of DATA_ALLOWLIST) {
      let raw = null
      try {
        raw = fs.readFileSync(path.join(DATA_DIR, name + '.json'), 'utf-8')
      } catch {
        continue
      }
      if (raw.toLowerCase().includes(query)) {
        hits.push({ type: 'data', title: name, subtitle: 'data', path: null, snippet: snippetFor(raw, query), score: 10 })
      }
    }
  }
  hits.sort((a, b) => b.score - a.score)
  return hits.slice(0, 24)
}

let lastGithubRefreshAt = 0

// Run a cross-vault read handler inside the vault named by ?vault= (absent →
// the configured default vault, now `atlas`). The wiki/note/search routes use this; data/projects/
// briefings don't (they're work-only). An unknown key → 400.
function withVault(req, res, fn) {
  try {
    return runInVault(String(req.query.vault || '') || undefined, fn)
  } catch (e) {
    return res.status(400).json({ error: String(e?.message || e) })
  }
}

export function readRouter() {
  const r = express.Router()
  r.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })

  r.get('/api/data/:name', (req, res) => {
    const name = req.params.name
    if (!DATA_ALLOWLIST.has(name)) return res.status(404).json({ error: 'unknown' })
    const raw = readMd(path.join(DATA_DIR, name + '.json'))
    if (raw == null) return res.status(404).json({ error: 'not found' })
    res.type('application/json').send(raw)
  })

  r.get('/api/notes', (req, res) =>
    withVault(req, res, () => {
      const folder = String(req.query.folder || '')
      if (!NOTE_FOLDERS.has(folder)) return res.status(403).json({ error: 'forbidden' })
      const root = currentVaultPath()
      const items = listMdRecursive(path.join(root, folder)).map((abs) => {
        const md = readMd(abs) || ''
        return { name: path.basename(abs), path: path.relative(root, abs), title: firstHeading(md, path.basename(abs, '.md')) }
      })
      res.json({ items })
    }),
  )

  r.get('/api/note', (req, res) =>
    withVault(req, res, () => {
      const rel = String(req.query.path || '')
      if (!rel.toLowerCase().endsWith('.md')) return res.status(400).type('text/plain').send('')
      const abs = safeJoin(rel)
      if (!abs) return res.status(403).type('text/plain').send('')
      const md = readMd(abs)
      if (md == null) return res.status(404).type('text/plain').send('')
      res.type('text/plain; charset=utf-8').send(md)
    }),
  )

  // Serve a vault HTML wiki page (experimental: HTML-based KB entries). Rendered
  // in a sandboxed iframe by the reader. Restricted to Wiki/*.html; a strict CSP
  // sandbox blocks scripts even if the file contains them (defense in depth).
  r.get('/api/wiki-html', (req, res) =>
    withVault(req, res, () => {
      const rel = String(req.query.path || '')
      if (!rel.toLowerCase().endsWith('.html')) return res.status(400).type('text/plain').send('')
      const abs = safeJoin(rel)
      if (!abs) return res.status(403).type('text/plain').send('')
      const norm = path.relative(currentVaultPath(), abs).split(path.sep).join('/')
      if (!norm.startsWith('Wiki/')) return res.status(403).type('text/plain').send('')
      const html = readMd(abs)
      if (html == null) return res.status(404).type('text/plain').send('')
      res.set('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'")
      res.type('text/html; charset=utf-8').send(html)
    }),
  )

  r.get('/api/wiki/:file(index|log)', (req, res) =>
    withVault(req, res, () => {
      const md = readMd(path.join(currentVaultPath(), 'Wiki', req.params.file + '.md'))
      if (md == null) return res.status(404).type('text/plain').send('')
      res.type('text/plain; charset=utf-8').send(md)
    }),
  )

  // Binary image files captured alongside notes (Inbox/assets, Wiki/assets).
  // safeJoin blocks traversal; the assets-prefix check blocks reading arbitrary
  // vault files through this route.
  r.get('/api/asset', (req, res) =>
    withVault(req, res, () => {
      const rel = String(req.query.path || '')
      const type = ASSET_TYPES[path.extname(rel).toLowerCase()]
      if (!type) return res.status(400).end()
      const abs = safeJoin(rel)
      if (!abs) return res.status(403).end()
      const norm = path.relative(currentVaultPath(), abs).split(path.sep).join('/')
      if (!/^(Inbox|Wiki)\/assets\//.test(norm)) return res.status(403).end()
      if (!fs.existsSync(abs)) return res.status(404).end()
      res.type(type)
      res.set('Cache-Control', 'public, max-age=86400') // override the router's no-store; assets are immutable
      fs.createReadStream(abs).pipe(res)
    }),
  )

  // Project cards: each Wiki/Projects/<name>.md (goal/now/repo/tag) + last commit
  // when a repo is set + a tag-based count of related notes (the KB footprint).
  r.get('/api/projects', async (_req, res) => {
    const parsed = listProjects()
    const counts = relatedCounts(new Set(parsed.map((p) => p.tag).filter(Boolean)))
    const projects = await Promise.all(
      parsed.map(async (p) => {
        // Local checkout first (fast, no rate limit); GitHub API as fallback for
        // repos not checked out on the box (only `github:` set, no local `repo:`).
        let commit = p.repo ? await gitLastCommit(p.repo) : null
        if (!commit && p.github) commit = await githubLastCommit(p.github)
        return {
          ...p,
          reachable: p.repo || p.github ? commit != null : true,
          commit,
          relatedSources: counts.get(p.tag) || 0,
        }
      }),
    )
    res.json({ generated: new Date().toISOString(), projects })
  })

  r.get('/api/wiki/pages', (req, res) => withVault(req, res, () => res.json({ items: wikiPages() })))

  r.get('/api/wiki/graph', (req, res) => withVault(req, res, () => res.json(wikiGraph())))

  // Atlas Type Registry — live node/edge/property vocabulary in use, merged with
  // the vault's Legend. Vault-aware (?vault=); read live off the working tree.
  r.get('/api/atlas/types', (req, res) => withVault(req, res, () => res.json(atlasTypes())))

  // Atlas typed query — relational + temporal queries over the typed layer
  // (edges, node types, status, dates). A READ despite POST: the structured
  // query spec is a JSON body, no mutation. Vault-aware (?vault=); read live.
  r.post('/api/atlas/query', (req, res) => withVault(req, res, () => res.json(queryAtlas(req.body || {}))))

  // Tasks Kanban source — type:task notes in the vault's Tasks/ folder, grouped
  // client-side by status. Vault-aware (?vault=); read live off the working tree.
  r.get('/api/tasks', (req, res) =>
    withVault(req, res, () => res.json({ generated: new Date().toISOString(), tasks: listTasks() })),
  )

  // The project/area vocabulary for the Kanban picker (and task inference).
  // Vault-aware (?vault=); read live off the working tree.
  r.get('/api/tasks/categories', (req, res) => withVault(req, res, () => res.json(listTaskCategories())))

  // Bundled Command Center data — one request per poll instead of ~8.
  r.get('/api/dashboard', (_req, res) => res.json(dashboardBundle()))

  r.get('/api/search', (req, res) => withVault(req, res, () => res.json({ items: search(String(req.query.q || '')) })))

  // Optional: refresh the GitHub-contributions scorecard/heatmap JSON. A fixed,
  // parameterless action (NOT arbitrary exec). Cooldown-guarded; only runs with a
  // real token from env/.env. No-op unless you keep scripts/refresh-github.mjs.
  r.post('/api/refresh/github', async (_req, res) => {
    const COOLDOWN_MS = 3 * 60 * 1000
    if (Date.now() - lastGithubRefreshAt < COOLDOWN_MS) return res.json({ ok: true, skipped: 'cooldown' })
    lastGithubRefreshAt = Date.now()
    let token = process.env.GITHUB_TOKEN
    if (!token) {
      try {
        const m = fs.readFileSync(path.join(WORKSPACE, '.env'), 'utf-8').match(/^GITHUB_TOKEN=(.+)$/m)
        if (m) token = m[1].trim().replace(/^["']|["']$/g, '')
      } catch {
        /* ignore */
      }
    }
    if (!token) return res.json({ ok: false, skipped: 'no token' })
    try {
      await execFileAsync('node', ['scripts/refresh-github.mjs'], {
        cwd: WORKSPACE,
        env: { ...process.env, GITHUB_TOKEN: token },
        timeout: 20000,
      })
      res.json({ ok: true })
    } catch (e) {
      res.json({ ok: false, error: String(e) })
    }
  })

  return r
}
