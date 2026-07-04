/* ------------------------------------------------------------------ *
 * Atlas typed query engine — relational + temporal queries over the
 * live working tree (Wiki/ + Tasks/).
 *
 * This is the payoff of the typed layer (Atlas Guide §7): EXACT,
 * deterministic answers over typed edges, node types, status, and dates
 * — "filters/traversals over typed fields, not fuzzy search". One vault
 * scan per query → an in-memory page model → AND-combined filters.
 * No infra: "cheap because it's all markdown" (Guide §8); same
 * read-live-off-the-working-tree philosophy as /api/tasks and
 * /api/wiki/graph. Powers the query_atlas MCP tool, POST
 * /api/atlas/query, and the Atlas tab's Relational Lenses card.
 *
 * (The small frontmatter/link/date helpers mirror read-routes.mjs; kept
 * local so the engine doesn't couple to the route module.)
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { currentVaultPath } from './vaults.mjs'

// Fixed-core typed-edge keys (the Legend's ★ edges) — treated as edges even when
// the value is an informal bare string (`area: Health`) rather than a [[link]].
const CORE_EDGE_KEYS = new Set(['owes', 'owed_by', 'area', 'depends_on', 'for_project', 'stakeholders', 'mentor', 'works_with'])
// Frontmatter keys whose value is a calendar date.
const DATE_KEYS = new Set(['due', 'created', 'updated', 'done', 'started', 'last_contact'])
const DATE_FILTERS = ['due', 'created', 'updated', 'done', 'started', 'last_contact']

/* --- local md helpers (mirror read-routes.mjs) --------------------- */
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
function firstHeading(md, fallback) {
  for (const line of stripFrontmatter(md).split('\n')) {
    const m = line.match(/^#\s+(.+)$/)
    if (m) return m[1].trim()
  }
  return fallback
}
// Tasks are prose-first per the Atlas Guide — often no H1.
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
// [[wikilink]] targets (basename, alias/anchor stripped) from a string or list;
// a bare non-link string is kept as-is (an informal `area: Health` still yields a label).
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
// Normalise a frontmatter date (js-yaml parses unquoted dates to Date) → YYYY-MM-DD.
function dateStr(v) {
  if (v == null) return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10)
  const s = String(v).trim()
  return s ? s.slice(0, 10) : null
}
function valueHasWikilink(v) {
  const arr = Array.isArray(v) ? v : [v]
  return arr.some((x) => /\[\[[^\]]+\]\]/.test(String(x)))
}

/* --- index: one page per Wiki/ + Tasks/ note, frontmatter classified -- */
function buildIndex(root) {
  const files = [
    ...listMdRecursive(path.join(root, 'Wiki')),
    ...listMdRecursive(path.join(root, 'Tasks')),
  ]
  const pages = []
  for (const abs of files) {
    const md = readMd(abs)
    if (md == null) continue
    const fm = frontmatter(md)
    if (!fm || typeof fm !== 'object' || Array.isArray(fm)) continue
    const base = path.basename(abs, '.md')
    const type = String(fm.type ?? '').trim()
    const page = {
      path: path.relative(root, abs),
      title: type === 'task' ? taskTitle(md, base) : firstHeading(md, base),
      type,
      tags: [],
      edges: {}, // key → [targets]
      dates: {}, // key → YYYY-MM-DD
      props: {}, // key → scalar
    }
    for (const [k, v] of Object.entries(fm)) {
      if (k === 'type') continue
      if (k === 'tags') {
        page.tags = Array.isArray(v) ? v.map((x) => String(x)) : v == null ? [] : [String(v)]
        continue
      }
      if (valueHasWikilink(v) || CORE_EDGE_KEYS.has(k)) {
        page.edges[k] = linkTargets(v)
        continue
      }
      if (DATE_KEYS.has(k) || v instanceof Date) {
        const d = dateStr(v)
        if (d) page.dates[k] = d
        continue
      }
      page.props[k] = typeof v === 'object' && v !== null ? JSON.stringify(v) : v
    }
    page._text = (page.title + ' ' + stripFrontmatter(md)).toLowerCase()
    pages.push(page)
  }
  return pages
}

/* --- date math (server-side; the engine owns relative windows) ------- */
function todayStr() {
  return new Date().toISOString().slice(0, 10)
}
function addDays(ds, n) {
  const d = new Date(ds + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
// A relative window token → inclusive {after?, before?, on?} bounds (YYYY-MM-DD).
function resolveWindow(token, today) {
  switch (token) {
    case 'overdue':
      return { before: addDays(today, -1) } // strictly before today
    case 'today':
      return { on: today }
    case 'next_7d':
      return { after: today, before: addDays(today, 7) }
    case 'this_week': {
      const dow = new Date(today + 'T00:00:00Z').getUTCDay() // 0=Sun
      return { after: today, before: addDays(today, (7 - dow) % 7) } // … through Sunday
    }
    case 'this_month': {
      const d = new Date(today + 'T00:00:00Z')
      const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
      return { after: today, before: end.toISOString().slice(0, 10) }
    }
    case 'past_7d':
      return { after: addDays(today, -7), before: today }
    default:
      return {}
  }
}

const toArr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x])
const lc = (x) => String(x).toLowerCase()
const baseOf = (t) => lc(t).split(/[\\/]/).pop()

// Inclusive date match: after ≤ value ≤ before; `on` exact; `window` fills gaps.
function matchDate(value, filter, today) {
  if (!value) return false
  let { before, after, on, window } = filter
  if (window) {
    const w = resolveWindow(window, today)
    before = before ?? w.before
    after = after ?? w.after
    on = on ?? w.on
  }
  if (on && value !== on) return false
  if (after && value < after) return false
  if (before && value > before) return false
  return true
}
function edgeMatches(page, key, target) {
  const targets = page.edges[key]
  if (!targets) return false
  if (!target) return targets.length > 0
  const t = lc(target)
  return targets.some((x) => baseOf(x).includes(t) || lc(x).includes(t))
}
function snippetFor(text, q) {
  const i = text.indexOf(q)
  if (i === -1) return ''
  const start = Math.max(0, i - 40)
  const end = Math.min(text.length, i + q.length + 60)
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '')
}

function defaultSort(spec) {
  if (spec.past_cadence) return '-_overdue'
  if (spec.due) return 'due'
  if (spec.last_contact) return 'last_contact'
  if (spec.done) return '-done'
  return '-updated'
}
function sortKeyValue(p, field) {
  if (field === 'title') return p.title || ''
  if (field === '_overdue') return p._daysOverdue ?? -Infinity
  return p.dates[field] || '' // date fields sort lexicographically (ISO)
}
function sortPages(pages, sortSpec) {
  const desc = sortSpec.startsWith('-')
  const field = desc ? sortSpec.slice(1) : sortSpec
  return pages.sort((a, b) => {
    const av = sortKeyValue(a, field)
    const bv = sortKeyValue(b, field)
    // Missing values (empty string / -Infinity) sort last regardless of direction.
    const aEmpty = av === '' || av === -Infinity
    const bEmpty = bv === '' || bv === -Infinity
    if (aEmpty && bEmpty) return a.title.localeCompare(b.title)
    if (aEmpty) return 1
    if (bEmpty) return -1
    const cmp = av < bv ? -1 : av > bv ? 1 : a.title.localeCompare(b.title)
    return desc ? -cmp : cmp
  })
}

function toRow(p, spec) {
  const row = { path: p.path, title: p.title, type: p.type }
  if (p.tags.length) row.tags = p.tags
  if (p.props.status != null) row.status = p.props.status
  if (p.props.priority != null) row.priority = p.props.priority
  if (Object.keys(p.dates).length) row.dates = p.dates
  if (Object.keys(p.edges).length) row.edges = p.edges
  if (p._daysOverdue != null) row.daysOverdue = p._daysOverdue
  if (spec.text) row.snippet = snippetFor(p._text, lc(spec.text))
  return row
}

/**
 * Run a typed query against a vault. Spec (all optional, AND-combined):
 *   type, tag, status, priority, source  — string | string[]
 *                                   (source = the Legend provenance enum, e.g. `email`)
 *   edges: [{ key, target }]      — forward typed-edge filters (snake_case keys)
 *   linkedTo: string              — any forward edge whose target matches
 *   due|created|updated|done|started|last_contact: { before?, after?, on?, window? }
 *                                   window ∈ overdue|today|next_7d|this_week|this_month|past_7d
 *   past_cadence: true            — person/contacts where last_contact+cadence_days < today
 *   text: string                  — full-text filter within the typed-filtered set (hybrid)
 *   sort: 'due'|'last_contact'|'updated'|'title'|… ('-' prefix = desc)
 *   limit: number (default 50, max 200)
 * Returns { generated, count, truncated, pages: [row…] } with the matched fields surfaced.
 */
export function queryAtlas(spec = {}, root = currentVaultPath()) {
  const today = todayStr()
  const pages = buildIndex(root)
  const types = toArr(spec.type).map(lc)
  const tags = toArr(spec.tag).map(lc)
  const statuses = toArr(spec.status).map(lc)
  const priorities = toArr(spec.priority).map(lc)
  const sources = toArr(spec.source).map(lc)
  const edges = toArr(spec.edges)

  let result = pages.filter((p) => {
    if (types.length && !types.includes(lc(p.type))) return false
    if (tags.length && !p.tags.some((tg) => tags.includes(lc(tg)))) return false
    if (statuses.length && !statuses.includes(lc(p.props.status ?? ''))) return false
    if (priorities.length && !priorities.includes(lc(p.props.priority ?? ''))) return false
    if (sources.length && !sources.includes(lc(p.props.source ?? ''))) return false
    for (const e of edges) {
      if (!e || !e.key) continue
      if (!edgeMatches(p, e.key, e.target)) return false
    }
    if (spec.linkedTo) {
      const t = lc(spec.linkedTo)
      const any = Object.values(p.edges).some((arr) => arr.some((x) => baseOf(x).includes(t) || lc(x).includes(t)))
      if (!any) return false
    }
    for (const k of DATE_FILTERS) {
      if (spec[k] && !matchDate(p.dates[k], spec[k], today)) return false
    }
    if (spec.past_cadence) {
      const last = p.dates.last_contact
      const cad = Number(p.props.cadence_days)
      if (!last || !Number.isFinite(cad)) return false
      const dueBy = addDays(last, cad)
      if (dueBy >= today) return false // not yet due
      p._daysOverdue = Math.round((Date.parse(today) - Date.parse(dueBy)) / 86400000)
    }
    if (spec.text && !p._text.includes(lc(spec.text))) return false
    return true
  })

  result = sortPages(result, spec.sort || defaultSort(spec))
  const limit = Math.min(Math.max(1, Number(spec.limit) || 50), 200)
  const truncated = result.length > limit
  return {
    generated: new Date().toISOString(),
    count: result.length,
    truncated,
    pages: result.slice(0, limit).map((p) => toRow(p, spec)),
  }
}
