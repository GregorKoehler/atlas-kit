/* ------------------------------------------------------------------ *
 * Duplicated frontmatter keys — detect, resolve, repair.
 *
 * The vault carries `*.md merge=union` (.gitattributes) so its append-only
 * logs merge without conflicts. Union merge does not understand YAML: when two
 * writers change the SAME frontmatter line on two sides — a paired worker's
 * `atlas/*` branch merged by enqueueAtlasMerge, a phone's Obsidian Git sync
 * racing the commit queue's rebase, two writers each rewriting `related:` —
 * git keeps BOTH lines. That is a duplicate YAML mapping key, `js-yaml` THROWS
 * on it (it does not last-wins), and every frontmatter reader swallows the
 * throw and returns `{}`. The page becomes UNTYPED to every consumer at once,
 * silently: it drops out of the project cards, the typed query engine, the
 * graph and every typed traversal, while still rendering fine in Obsidian.
 *
 * ⚠️ WRITER IDEMPOTENCY CANNOT PREVENT THIS. The duplicate is created by the
 * MERGE, not by a writer: each side rewrote its single line correctly. So the
 * fix has to sit AFTER the merge (the self-heal below, driven from the serial
 * commit queue) and the reader has to survive the window in between
 * (loadFrontmatter). project-card.mjs's `rewriteNow` is the third layer — it
 * keeps its OWN write to exactly one key — but it only covers the one key it
 * writes, which is why it is not the fix.
 *
 * Resolution policy — two kinds of key, one rule each:
 *   · SCALAR live state (now, status, updated, due, …): the NEWEST occurrence
 *     wins. Date-shaped values have a real order, so take the max; anything
 *     else only has FILE order, where union merge appends the incoming side
 *     last — so the last occurrence wins.
 *   · ARRAY keys (related, tags, depends_on, stakeholders, …): the set UNION of
 *     every occurrence, ORDER-PRESERVING. Dropping either side would lose a
 *     writer's work, which is the failure the union-merge setting exists to
 *     prevent in the body.
 * The resolved value keeps the RAW lines of whichever occurrence it came from
 * whenever one occurrence already IS the answer, so a repair is a minimal diff
 * and never re-quotes a value it did not have to touch.
 *
 * We deliberately do NOT change the `*.md merge=union` strategy: the
 * append-only logs (Wiki/log.md, Wiki/index.md) need it, and it is what makes
 * the multi-writer vault work at all.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'

/* Repairs go to the SAME append-only audit log as agent spawns, so "why did
 * that page change" is answerable after the fact. A direct appender rather than
 * importing `audit` from agent-local.mjs, which boots the whole tmux session
 * registry on import — this file is imported by the shared vault READER
 * (read-routes.mjs), which must stay cheap and side-effect-free. */
const AUDIT_LOG = path.join(process.env.AGENT_LOCAL_DIR || path.join(os.homedir(), '.atlas-kit'), 'audit.log')
function audit(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive: true })
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
  } catch {
    /* observability must never break a write path */
  }
}

// A top-level frontmatter key line: `key:` at column 0.
const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:/
// YYYY-MM-DD, optionally with a time — the only scalar shape with a real order.
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/

// First `--- … ---` frontmatter block → { body, start, end }.
function frontmatterBlock(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  return m ? { body: m[1], start: m.index, end: m.index + m[0].length } : null
}

function stripQuotes(s) {
  const t = String(s).trim()
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) return t.slice(1, -1)
  return t
}

/* Split a frontmatter body into top-level entries, in order. A line that does
 * not start a top-level key — an indented block-sequence item, a continuation,
 * a comment — belongs to the entry above it, so a multi-line value moves and
 * drops as one unit. */
function entries(body) {
  const out = []
  for (const line of body.split('\n')) {
    const m = KEY_RE.exec(line)
    if (m) out.push({ key: m[1], lines: [line] })
    else if (out.length) out[out.length - 1].lines.push(line)
    else out.push({ key: null, lines: [line] })
  }
  return out
}

// The entry's parsed value, or undefined when it alone does not parse.
function valueOf(e) {
  try {
    const o = yaml.load(e.lines.join('\n'))
    return o && typeof o === 'object' ? o[e.key] : undefined
  } catch {
    return undefined
  }
}

// The entry's scalar text as written (first line, after the colon).
function scalarText(e) {
  const l = e.lines[0]
  return stripQuotes(l.slice(l.indexOf(':') + 1))
}

/* Resolve one duplicated key's occurrences into the single entry that replaces
 * them → { policy, lines }. See the policy in the header. */
function resolveKey(key, occ) {
  const vals = occ.map(valueOf)
  if (vals.every((v) => Array.isArray(v))) {
    const seen = new Set()
    const union = []
    for (const arr of vals)
      for (const item of arr) {
        const k = JSON.stringify(item)
        if (seen.has(k)) continue
        seen.add(k)
        union.push(item)
      }
    // One side already IS the union (the common case: a writer appended) → keep
    // its lines verbatim rather than re-rendering the whole list.
    const same = vals.findIndex((v) => JSON.stringify(v) === JSON.stringify(union))
    if (same !== -1) return { policy: 'union', lines: occ[same].lines }
    // A JSON array literal is a valid YAML flow sequence, and matches the
    // hand-written style of these pages (`related: ["[[A]]", "[[B]]"]`).
    return { policy: 'union', lines: [`${key}: [${union.map((v) => JSON.stringify(v)).join(', ')}]`] }
  }
  const raw = occ.map(scalarText)
  if (raw.every((s) => ISO_RE.test(s))) {
    let best = 0
    for (let i = 1; i < raw.length; i++) if (raw[i] > raw[best]) best = i
    return { policy: 'newest', lines: occ[best].lines }
  }
  return { policy: 'newest', lines: occ[occ.length - 1].lines }
}

/** Top-level frontmatter keys that appear more than once. [] when the file has
 *  no frontmatter or none is duplicated. */
export function duplicateFrontmatterKeys(text) {
  const fm = frontmatterBlock(text)
  if (!fm) return []
  const counts = new Map()
  for (const e of entries(fm.body)) if (e.key) counts.set(e.key, (counts.get(e.key) || 0) + 1)
  return [...counts].filter(([, n]) => n > 1).map(([k]) => k)
}

/** Repair a page a union merge doubled → { text, repairs:[{key,policy,dropped}] },
 *  or null when there is nothing to repair (no frontmatter, no duplicate key).
 *  The resolved entry takes the position of the key's FIRST occurrence; every
 *  later one is dropped. Body and every other line are untouched. */
export function healFrontmatter(text) {
  const fm = frontmatterBlock(text)
  if (!fm) return null
  const es = entries(fm.body)
  const counts = new Map()
  for (const e of es) if (e.key) counts.set(e.key, (counts.get(e.key) || 0) + 1)
  if (![...counts.values()].some((n) => n > 1)) return null
  const repairs = []
  const done = new Set()
  const lines = []
  for (const e of es) {
    if (!e.key || counts.get(e.key) === 1) {
      lines.push(...e.lines)
      continue
    }
    if (done.has(e.key)) continue // a duplicate a union merge left behind → dropped
    done.add(e.key)
    const occ = es.filter((x) => x.key === e.key)
    const r = resolveKey(e.key, occ)
    repairs.push({ key: e.key, policy: r.policy, dropped: occ.length - 1 })
    lines.push(...r.lines)
  }
  return { text: text.slice(0, fm.start) + '---\n' + lines.join('\n') + '\n---' + text.slice(fm.end), repairs }
}

// Warn ONCE per page+damage: the readers below run on every poll, and a line
// per request would bury the one that matters.
const warned = new Set()

/** Parse a note's YAML frontmatter, SURVIVING a page a union merge doubled.
 *  Strict parse first (unchanged for every healthy page); on a throw, resolve
 *  the duplicates in memory with the same policy the on-disk self-heal applies
 *  and parse that — so a card stays rendered, and reads exactly what the repair
 *  is about to write, for the window between the merge and the repair.
 *  → { data, repairs }. Unrecoverable damage still degrades to `{}`, as before,
 *  but never silently: it is logged. */
export function loadFrontmatter(md, label = '') {
  const text = String(md ?? '')
  if (!text.startsWith('---')) return { data: {}, repairs: [] }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { data: {}, repairs: [] }
  try {
    return { data: yaml.load(text.slice(3, end)) || {}, repairs: [] }
  } catch (e) {
    const healed = healFrontmatter(text)
    if (healed) {
      const hEnd = healed.text.indexOf('\n---', 3)
      try {
        const data = yaml.load(healed.text.slice(3, hEnd)) || {}
        note(label, `frontmatter has duplicated key(s) ${healed.repairs.map((r) => r.key).join(', ')} — read through the union-merge repair`, {
          event: 'frontmatter-read-repair',
          keys: healed.repairs.map((r) => r.key),
        })
        return { data, repairs: healed.repairs }
      } catch {
        /* still broken → fall through */
      }
    }
    note(label, `frontmatter does not parse (${String(e.message || e).split('\n')[0]}) — the page is untyped to every reader`, {
      event: 'frontmatter-unparseable',
    })
    return { data: {}, repairs: [] }
  }
}

function note(label, message, entry) {
  const k = `${label}|${entry.event}|${(entry.keys || []).join(',')}`
  if (warned.has(k)) return
  warned.add(k)
  console.warn(`[frontmatter] ${label || '(page)'}: ${message}`)
  audit({ action: 'frontmatter', file: label, ...entry })
}

/** Repair, stage and COMMIT every .md a pull/rebase/merge just brought in whose
 *  frontmatter a union merge doubled — the self-heal that makes the damage
 *  transient instead of permanent. Runs INSIDE the caller's write lock, right
 *  after the git operation that could have created it.
 *
 *  `run(args)` executes git in `dir` (the caller's own runner, with its own
 *  lock-retry); `from` is the commit `dir` was at BEFORE the operation (or any
 *  ref, e.g. `HEAD^` for a merge commit). Never throws — a repair that cannot
 *  be made must not fail the write it rode in on; it is reported instead.
 *  → { repaired: [{ file, repairs }], committed, warning? } */
export async function healTouchedFrontmatter({ dir, run, from, to = 'HEAD', author, label = 'atlas' }) {
  const out = { repaired: [], committed: false }
  if (!dir || !from) return out
  try {
    const { stdout } = await run(['diff', '--name-only', `${from}..${to}`])
    const touched = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((f) => f.toLowerCase().endsWith('.md'))
    for (const file of touched) {
      let text
      try {
        text = fs.readFileSync(path.join(dir, file), 'utf-8')
      } catch {
        continue // deleted by the merge
      }
      const healed = healFrontmatter(text)
      if (!healed) {
        // Not doubled, but still unparseable? Say so — a page that silently
        // untypes itself is the whole failure class this file exists for.
        loadFrontmatter(text, file)
        continue
      }
      fs.writeFileSync(path.join(dir, file), healed.text)
      out.repaired.push({ file, repairs: healed.repairs })
      const detail = healed.repairs.map((r) => `${r.key} (${r.policy}, -${r.dropped})`).join(', ')
      console.warn(`[frontmatter] ${label}: repaired union-merged duplicate key(s) in ${file}: ${detail}`)
      audit({ action: 'frontmatter-heal', label, file, repairs: healed.repairs })
    }
    if (!out.repaired.length) return out
    const files = out.repaired.map((r) => r.file)
    await run(['add', '--', ...files])
    await run([
      '-c',
      `user.name=${author?.name || 'Atlas Kit'}`,
      '-c',
      `user.email=${author?.email || 'atlas-kit@localhost'}`,
      'commit',
      '-m',
      `atlas: heal ${files.length} page(s) with union-merged duplicate frontmatter keys`.slice(0, 200),
      '--',
      ...files,
    ])
    out.committed = true
    return out
  } catch (e) {
    const warning = (e?.stderr || e?.message || String(e)).toString().replace(/\s+/g, ' ').trim().slice(0, 200)
    console.error(`[frontmatter] ${label}: self-heal failed: ${warning}`)
    audit({ action: 'frontmatter-heal', label, error: warning })
    return { ...out, warning }
  }
}
