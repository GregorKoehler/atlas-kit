/* ------------------------------------------------------------------ *
 * Atlas task writes — the Kanban drag-to-restage + new-task endpoints.
 *
 * POST /api/tasks/move { path, status } flips a `type: task` note's
 * `status:` frontmatter (bumping `updated:`, and setting/clearing the
 * `done:` milestone) and commits it to the Atlas through the single-writer
 * commit queue (enqueueAtlasCommit) so it can't race the refresh cron /
 * paired-worker merges. Bearer-gated (Caddy injects the token server-side);
 * the browser's optimistic Kanban move is the UI half.
 *
 * POST /api/tasks/new { title, due?, body?, project?/projectIdea?/area?, source? }
 * scaffolds a fresh `type: task` note in the Atlas's Tasks/ folder (status:
 * inbox — the lifecycle entry point), with an optional `due:` date, an optional
 * free-text `body` (the description paragraph below the title line), an
 * optional category, and an optional `source:` provenance facet (the Legend
 * enum — `email` for tasks filed by the hourly email pass), and commits it
 * through the same queue. The Kanban "+ New task" button is the UI half; the
 * commit is what "kicks off" on add.
 *
 * POST /api/tasks/due { path, due } sets (or clears, when due is empty) a
 * task's `due:` frontmatter (bumping `updated:`) and commits it. The Kanban
 * card's due chip is the UI half.
 *
 * POST /api/tasks/body { path, body } replaces a task's body (everything after
 * the frontmatter — the description below the title), bumping `updated:`, and
 * commits it. The reader's "Edit" affordance on a task note is the UI half.
 *
 * POST /api/tasks/priority { path, priority } sets (or clears, when priority is
 * empty) a task's `priority:` frontmatter (the Legend's high/medium/low enum),
 * bumping `updated:`, and commits it. The Kanban card's flame toggle is the UI
 * half — it flags a card `priority: high` (and clears it back to unset).
 *
 * POST /api/atlas/type-flag { vault, category, name, flagged } toggles the
 * operator's "suspected duplicate" flag on a Type Registry entry. Unlike the
 * task writes this does NOT touch the Atlas repo — flags are dashboard metadata,
 * persisted to a server-side .state file (atlas-type-flags.mjs). The Type
 * Registry card's flag toggle is the UI half; the live list is GET /api/atlas/types.
 *
 * Task Prospects — a proposed task that does NOT exist in the vault yet (see
 * atlas-prospects.mjs). Same non-vault-touching shape as the type-flag above (a
 * server-side .state file), so a rejected prospect never touches the vault, not
 * even transiently.
 *   POST /api/prospects/new { title, body?, due?, project?/projectIdea?/area?,
 *   source?, vault?, sourceKey?, producer? } — bearer-gated, for dev and
 *   knowledge agents to PROPOSE a follow-up instead of filing it directly.
 *   `sourceKey` (e.g. `dev-agent:<repo>:<slug>`) is the STICKY dedup key: a
 *   source already decided (approved OR rejected) is silently skipped rather
 *   than re-queued.
 *   GET /api/prospects — the pending review queue (open; read-only).
 *   POST /api/prospects/approve { id, edits? } — writes the REAL task through
 *   createTask() (the exact /api/tasks/new path), optionally overridden by
 *   `edits` (edit-then-approve), then stamps the sticky "approved" decision.
 *   POST /api/prospects/reject { id } — discards the prospect and stamps the
 *   sticky "rejected" decision. Both bearer-gated; the operator's review
 *   surface is the UI half.
 * ------------------------------------------------------------------ */
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { resolveVault, isTypedVault } from './vaults.mjs'
import { enqueueAtlasCommit } from './atlas-commit-queue.mjs'
import { setFlag, flagKey } from './atlas-type-flags.mjs'
import { addProspect, listProspects, resolveProspect } from './atlas-prospects.mjs'

const STATUSES = new Set(['inbox', 'next', 'doing', 'waiting', 'done'])
// The Legend's `priority` enum (Wiki/Legend.md). '' clears the field.
const PRIORITIES = new Set(['high', 'medium', 'low'])
// Flat Tasks/<slug>.md only — no subdirectories, no path traversal.
const TASK_RE = /^Tasks\/[A-Za-z0-9._-]+\.md$/
// A plain calendar date (what <input type="date"> and the `due:` field both use).
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
// A project / life-area name — what goes inside a for_project/area [[wikilink]].
// Permissive enough for new areas with spaces, but no wikilink/YAML metacharacters.
const CATEGORY_RE = /^[A-Za-z0-9 ._-]{1,64}$/
// The Legend's `source` provenance enum (Wiki/Legend.md — currently `email`,
// open-ended). A lowercase bare-scalar token, so it writes unquoted into the YAML.
const SOURCE_RE = /^[a-z][a-z0-9_-]{0,31}$/
// Type Registry flag inputs: the three Legend categories + a safe type/key name.
const TYPE_CATEGORIES = new Set(['node', 'edge', 'property'])
const TYPE_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/
// A prospect's sticky dedup key (a producer-chosen pointer at whatever it
// re-notices, e.g. `dev-agent:<repo>:<slug>`) — bounded, printable, no whitespace.
const SOURCE_KEY_RE = /^[\x21-\x7e]{1,200}$/
// A prospect's `producer` label (which agent proposed it) — free text, bounded,
// no need for a strict charset (it's display-only, never a path).
const PRODUCER_MAX = 64

function today() {
  return new Date().toISOString().slice(0, 10)
}

// Resolve the target vault for a task write: the request body's `vault` (default
// the main `atlas`; the Recipes Kanban sends `a sibling vault`). Required to be a
// TYPED vault (carries a Wiki/Legend.md) — the typed Kanban is the only task-write
// surface, so this also keeps a stray key from scribbling Tasks/ into a plain
// vault. Returns { key, path } or null when the vault is unknown / untyped.
function taskVault(vault) {
  const key = String(vault || 'atlas')
  if (!isTypedVault(key)) return null
  return { key, path: resolveVault(key).path }
}

// Title → a filesystem-safe Tasks/<slug>.md slug (a subset of TASK_RE's
// charset). Strips accents, lowercases, and collapses runs to single dashes.
function slugify(s) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
}

// Splice the frontmatter block, letting `mutate` set/delete keys in place via
// the { set, del } it receives. Returns the new text, or null if the note has no
// frontmatter block. Only the frontmatter is touched; the body is untouched.
function editFrontmatter(text, mutate) {
  if (!text.startsWith('---')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  let lines = text.slice(3, end).split('\n')
  const set = (key, val) => {
    const re = new RegExp(`^\\s*${key}:`)
    let found = false
    lines = lines.map((l) => {
      if (re.test(l)) {
        found = true
        return `${key}: ${val}`
      }
      return l
    })
    if (!found) lines.push(`${key}: ${val}`)
  }
  const del = (key) => {
    const re = new RegExp(`^\\s*${key}:`)
    lines = lines.filter((l) => !re.test(l))
  }
  mutate({ set, del })
  return '---' + lines.join('\n') + text.slice(end)
}

// A Kanban move: overwrite `status` + `updated`, set/clear the `done` milestone.
function restage(text, status, day) {
  return editFrontmatter(text, ({ set, del }) => {
    set('status', status)
    set('updated', day)
    if (status === 'done') set('done', day)
    else del('done')
  })
}

// A Kanban due edit: set `due` (or clear it when `due` is empty) + bump `updated`.
function setDue(text, due, day) {
  return editFrontmatter(text, ({ set, del }) => {
    if (due) set('due', due)
    else del('due')
    set('updated', day)
  })
}

// A Kanban priority edit: set `priority` (or clear it when empty) + bump `updated`.
function setPriority(text, priority, day) {
  return editFrontmatter(text, ({ set, del }) => {
    if (priority) set('priority', priority)
    else del('priority')
    set('updated', day)
  })
}

// A project / project-idea / area edit: for each field PRESENT in `cat`, set it
// to a quoted [[wikilink]] (matching the Atlas's typed-edge style) or clear it
// when empty. Undefined fields are left untouched. Bumps `updated`.
function setCategory(text, cat, day) {
  return editFrontmatter(text, ({ set, del }) => {
    if (cat.project !== undefined) {
      if (cat.project) set('for_project', `"[[${cat.project}]]"`)
      else del('for_project')
    }
    if (cat.projectIdea !== undefined) {
      if (cat.projectIdea) set('for_project_idea', `"[[${cat.projectIdea}]]"`)
      else del('for_project_idea')
    }
    if (cat.area !== undefined) {
      if (cat.area) set('area', `"[[${cat.area}]]"`)
      else del('area')
    }
    set('updated', day)
  })
}

// Replace a task note's body (everything after the frontmatter), keeping the
// frontmatter and bumping `updated`. The body convention is a blank line then
// the body; an empty body leaves just the frontmatter. Returns null if the note
// has no frontmatter block.
function setBody(text, body, day) {
  const withUpdated = editFrontmatter(text, ({ set }) => set('updated', day))
  if (withUpdated == null) return null
  const end = withUpdated.indexOf('\n---', 3) // start of the closing fence
  const fenceEnd = withUpdated.indexOf('\n', end + 1) // newline ending the closing ---
  if (fenceEnd === -1) return null
  const head = withUpdated.slice(0, fenceEnd + 1) // ---\n<frontmatter>\n---\n
  return body ? `${head}\n${body}\n` : head
}

// Core of POST /api/tasks/new, factored out so an in-process caller (the
// prospect-approval route below) can write through the EXACT same path — no
// second task-writing path, no HTTP self-loop. Takes the same shape as the
// route's req.body; returns { status, ok, error? } or { status, ok:true, ... }.
//
// The note is prose-first per the Atlas Guide — the title is the body's first
// line (what the Kanban reads as the card title); the typed fields are filled in
// later by editing the note.
export async function createTask(body) {
  const title = String(body?.title || '').trim()
  if (!title) return { status: 400, ok: false, error: 'title required' }
  const due = String(body?.due || '').trim()
  if (due && !DATE_RE.test(due)) return { status: 400, ok: false, error: 'invalid due date' }
  // Optional free-text body — the description paragraph(s) below the title line
  // (the Atlas task body convention). Normalise CRLF so the note stays clean.
  const bodyText = String(body?.body || '').replace(/\r\n/g, '\n').trim()
  const project = String(body?.project || '').trim()
  const projectIdea = String(body?.projectIdea || '').trim()
  const area = String(body?.area || '').trim()
  if (project && !CATEGORY_RE.test(project)) return { status: 400, ok: false, error: 'invalid project' }
  if (projectIdea && !CATEGORY_RE.test(projectIdea)) return { status: 400, ok: false, error: 'invalid project idea' }
  if (area && !CATEGORY_RE.test(area)) return { status: 400, ok: false, error: 'invalid area' }
  // Optional provenance facet (the Legend `source` enum). A passthrough like
  // project/area: written verbatim into the frontmatter; lowercased + validated
  // to a safe bare scalar.
  const source = String(body?.source || '').trim().toLowerCase()
  if (source && !SOURCE_RE.test(source)) return { status: 400, ok: false, error: 'invalid source' }
  const vault = taskVault(body?.vault)
  if (!vault) return { status: 404, ok: false, error: 'unknown or non-typed vault' }

  const base = slugify(title) || 'task'
  // Pick a non-colliding Tasks/<slug>.md against the current tree.
  let slug = base
  for (let n = 2; fs.existsSync(path.join(vault.path, `Tasks/${slug}.md`)); n++) slug = `${base}-${n}`
  const rel = `Tasks/${slug}.md`
  const abs = path.join(vault.path, rel)
  const day = today()
  const cat = `${project ? `\nfor_project: "[[${project}]]"` : ''}${projectIdea ? `\nfor_project_idea: "[[${projectIdea}]]"` : ''}${area ? `\narea: "[[${area}]]"` : ''}`
  const src = source ? `\nsource: ${source}` : ''
  // Body convention: title line, then a blank line, then the optional body.
  const note = `---\ntype: task\nstatus: inbox\ncreated: ${day}\nupdated: ${day}${due ? `\ndue: ${due}` : ''}${src}${cat}\n---\n\n${title}\n${bodyText ? `\n${bodyText}\n` : ''}`

  const result = await enqueueAtlasCommit({
    vault: vault.key,
    message: `tasks: new ${slug}`,
    paths: rel,
    mutate: async () => {
      // Re-check after the queue's pull so a concurrent create isn't clobbered.
      if (fs.existsSync(abs)) throw new Error('task already exists')
      fs.writeFileSync(abs, note)
    },
  })
  return result.ok
    ? { status: 200, ...result, path: rel, project: project || null, projectIdea: projectIdea || null, area: area || null }
    : { status: 502, ...result }
}

export function atlasRouter(bearerAuth) {
  const r = express.Router()

  // Restage a task: set its status (Kanban column) and commit to the Atlas.
  r.post('/api/tasks/move', bearerAuth, async (req, res) => {
    const rel = String(req.body?.path || '')
    const status = String(req.body?.status || '').toLowerCase()
    if (!STATUSES.has(status)) return res.status(400).json({ ok: false, error: 'invalid status' })
    if (!TASK_RE.test(rel)) return res.status(400).json({ ok: false, error: 'invalid task path' })
    const vault = taskVault(req.body?.vault)
    if (!vault) return res.status(404).json({ ok: false, error: 'unknown or non-typed vault' })
    const abs = path.join(vault.path, rel)
    if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: 'task not found' })

    const day = today()
    const slug = path.basename(rel, '.md')
    const result = await enqueueAtlasCommit({
      vault: vault.key,
      message: `tasks: ${slug} -> ${status}`,
      paths: rel,
      mutate: async () => {
        const text = fs.readFileSync(abs, 'utf-8')
        const next = restage(text, status, day)
        if (next == null) throw new Error('task note has no frontmatter')
        if (next !== text) fs.writeFileSync(abs, next)
      },
    })
    res.status(result.ok ? 200 : 502).json(result)
  })

  // Create a task: scaffold a new type:task note in Tasks/ (status: inbox) and
  // commit it — see createTask() above for the note-writing logic, shared with
  // the prospect-approval route so there is only ever ONE task-writing path.
  r.post('/api/tasks/new', bearerAuth, async (req, res) => {
    const { status, ...result } = await createTask(req.body || {})
    res.status(status).json(result)
  })

  // Flag (or unflag) a Type Registry entry as a suspected duplicate. This is
  // dashboard metadata — persisted to a server-side .state file, NOT written into
  // the Atlas repo (the dashboard "never writes uninvited" there). Bearer-gated
  // like the task writes; the card's flag toggle is the UI half.
  r.post('/api/atlas/type-flag', bearerAuth, (req, res) => {
    const vault = String(req.body?.vault || 'atlas')
    const category = String(req.body?.category || '')
    const name = String(req.body?.name || '')
    const flagged = req.body?.flagged === true
    if (!TYPE_CATEGORIES.has(category)) return res.status(400).json({ ok: false, error: 'invalid category' })
    if (!TYPE_NAME_RE.test(name)) return res.status(400).json({ ok: false, error: 'invalid name' })
    if (!resolveVault(vault)) return res.status(404).json({ ok: false, error: 'unknown vault' })
    setFlag(flagKey(vault, category, name), flagged)
    res.json({ ok: true })
  })

  // File a new Task Prospect — a proposed task that does NOT exist in the vault
  // yet (see atlas-prospects.mjs). Dev and knowledge agents call this INSTEAD of
  // /api/tasks/new; the operator's review surface turns it into a real task via
  // /api/prospects/approve. Validation mirrors createTask()'s (this is what an
  // approved prospect becomes).
  r.post('/api/prospects/new', bearerAuth, (req, res) => {
    const title = String(req.body?.title || '').trim()
    if (!title) return res.status(400).json({ ok: false, error: 'title required' })
    const due = String(req.body?.due || '').trim()
    if (due && !DATE_RE.test(due)) return res.status(400).json({ ok: false, error: 'invalid due date' })
    const project = String(req.body?.project || '').trim()
    if (project && !CATEGORY_RE.test(project)) return res.status(400).json({ ok: false, error: 'invalid project' })
    const projectIdea = String(req.body?.projectIdea || '').trim()
    if (projectIdea && !CATEGORY_RE.test(projectIdea))
      return res.status(400).json({ ok: false, error: 'invalid project idea' })
    const area = String(req.body?.area || '').trim()
    if (area && !CATEGORY_RE.test(area)) return res.status(400).json({ ok: false, error: 'invalid area' })
    const source = String(req.body?.source || '').trim().toLowerCase()
    if (source && !SOURCE_RE.test(source)) return res.status(400).json({ ok: false, error: 'invalid source' })
    const sourceKey = String(req.body?.sourceKey || '').trim()
    if (sourceKey && !SOURCE_KEY_RE.test(sourceKey)) return res.status(400).json({ ok: false, error: 'invalid sourceKey' })
    const vault = String(req.body?.vault || 'atlas')
    if (!isTypedVault(vault)) return res.status(404).json({ ok: false, error: 'unknown or non-typed vault' })
    const producer = String(req.body?.producer || '').trim().slice(0, PRODUCER_MAX) || null
    const bodyText = String(req.body?.body || '').replace(/\r\n/g, '\n').trim()

    // { ok:false, skipped } isn't an error — it's the sticky guarantee working
    // as intended (a source already decided, or already queued, stays quiet).
    const result = addProspect({
      title,
      body: bodyText,
      due: due || null,
      project: project || null,
      projectIdea: projectIdea || null,
      area: area || null,
      source: source || null,
      vault,
      sourceKey: sourceKey || null,
      producer,
    })
    res.json(result)
  })

  // The pending prospect queue — open, read-only (like the vault GET reads).
  r.get('/api/prospects', (_req, res) => res.json({ items: listProspects() }))

  // Approve a prospect: write the REAL task through createTask() — the EXACT
  // /api/tasks/new path, so an approved prospect gets the normal frontmatter,
  // typed edges, and `source:` provenance — optionally overridden by `edits`
  // (edit-then-approve), then stamp the sticky "approved" decision.
  r.post('/api/prospects/approve', bearerAuth, async (req, res) => {
    const id = String(req.body?.id || '')
    const prospect = listProspects().find((p) => p.id === id)
    if (!prospect) return res.status(404).json({ ok: false, error: 'prospect not found' })
    const edits = req.body?.edits && typeof req.body.edits === 'object' ? req.body.edits : {}
    const { status, ...result } = await createTask({
      title: edits.title ?? prospect.title,
      body: edits.body ?? prospect.body,
      due: edits.due ?? prospect.due,
      project: edits.project ?? prospect.project,
      projectIdea: edits.projectIdea ?? prospect.projectIdea,
      area: edits.area ?? prospect.area,
      source: prospect.source,
      vault: prospect.vault,
    })
    // ⚠️ Only retire the prospect once the task is really on disk and committed —
    // a failed write must leave it pending, not silently swallow the proposal.
    if (!result.ok) return res.status(status).json(result)
    resolveProspect(id, 'approved')
    res.status(status).json(result)
  })

  // Reject a prospect: discard it (it never touches the vault) and stamp the
  // sticky "rejected" decision so it's never re-proposed.
  r.post('/api/prospects/reject', bearerAuth, (req, res) => {
    const id = String(req.body?.id || '')
    const prospect = resolveProspect(id, 'rejected')
    if (!prospect) return res.status(404).json({ ok: false, error: 'prospect not found' })
    res.json({ ok: true })
  })

  // Set (or clear) a task's due date: rewrite its `due` frontmatter and commit.
  r.post('/api/tasks/due', bearerAuth, async (req, res) => {
    const rel = String(req.body?.path || '')
    const due = String(req.body?.due || '').trim()
    if (!TASK_RE.test(rel)) return res.status(400).json({ ok: false, error: 'invalid task path' })
    if (due && !DATE_RE.test(due)) return res.status(400).json({ ok: false, error: 'invalid due date' })
    const vault = taskVault(req.body?.vault)
    if (!vault) return res.status(404).json({ ok: false, error: 'unknown or non-typed vault' })
    const abs = path.join(vault.path, rel)
    if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: 'task not found' })

    const day = today()
    const slug = path.basename(rel, '.md')
    const result = await enqueueAtlasCommit({
      vault: vault.key,
      message: `tasks: ${slug} due ${due || 'cleared'}`,
      paths: rel,
      mutate: async () => {
        const text = fs.readFileSync(abs, 'utf-8')
        const next = setDue(text, due, day)
        if (next == null) throw new Error('task note has no frontmatter')
        if (next !== text) fs.writeFileSync(abs, next)
      },
    })
    res.status(result.ok ? 200 : 502).json(result)
  })

  // Set (or clear) a task's priority: rewrite its `priority` frontmatter (the
  // Legend's high/medium/low enum) and commit. The Kanban card's flame toggle is
  // the UI half — it flags a card `priority: high` and clears it back to unset.
  r.post('/api/tasks/priority', bearerAuth, async (req, res) => {
    const rel = String(req.body?.path || '')
    const priority = String(req.body?.priority || '').trim().toLowerCase()
    if (!TASK_RE.test(rel)) return res.status(400).json({ ok: false, error: 'invalid task path' })
    if (priority && !PRIORITIES.has(priority)) return res.status(400).json({ ok: false, error: 'invalid priority' })
    const vault = taskVault(req.body?.vault)
    if (!vault) return res.status(404).json({ ok: false, error: 'unknown or non-typed vault' })
    const abs = path.join(vault.path, rel)
    if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: 'task not found' })

    const day = today()
    const slug = path.basename(rel, '.md')
    const result = await enqueueAtlasCommit({
      vault: vault.key,
      message: `tasks: ${slug} priority ${priority || 'cleared'}`,
      paths: rel,
      mutate: async () => {
        const text = fs.readFileSync(abs, 'utf-8')
        const next = setPriority(text, priority, day)
        if (next == null) throw new Error('task note has no frontmatter')
        if (next !== text) fs.writeFileSync(abs, next)
      },
    })
    res.status(result.ok ? 200 : 502).json(result)
  })

  // Replace a task's body (the description below the title): rewrite everything
  // after the frontmatter and commit. The reader's "Edit" affordance is the UI
  // half. CRLF-normalised + trimmed, mirroring /api/tasks/new.
  r.post('/api/tasks/body', bearerAuth, async (req, res) => {
    const rel = String(req.body?.path || '')
    if (!TASK_RE.test(rel)) return res.status(400).json({ ok: false, error: 'invalid task path' })
    const body = String(req.body?.body || '').replace(/\r\n/g, '\n').trim()
    const vault = taskVault(req.body?.vault)
    if (!vault) return res.status(404).json({ ok: false, error: 'unknown or non-typed vault' })
    const abs = path.join(vault.path, rel)
    if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: 'task not found' })

    const day = today()
    const slug = path.basename(rel, '.md')
    const result = await enqueueAtlasCommit({
      vault: vault.key,
      message: `tasks: ${slug} edit body`,
      paths: rel,
      mutate: async () => {
        const text = fs.readFileSync(abs, 'utf-8')
        const next = setBody(text, body, day)
        if (next == null) throw new Error('task note has no frontmatter')
        if (next !== text) fs.writeFileSync(abs, next)
      },
    })
    res.status(result.ok ? 200 : 502).json(result)
  })

  // Set (or correct) a task's project / project-idea / area. Each field is
  // optional: a name sets it, '' clears it, absent leaves it untouched. The
  // Kanban keeps a single colour per card, so the composer/reader picker sets one
  // kind and clears the others. Values are written as quoted [[wikilinks]] (the
  // typed-edge style).
  r.post('/api/tasks/category', bearerAuth, async (req, res) => {
    const rel = String(req.body?.path || '')
    if (!TASK_RE.test(rel)) return res.status(400).json({ ok: false, error: 'invalid task path' })
    const cat = {}
    for (const field of ['project', 'projectIdea', 'area']) {
      if (!(field in req.body)) continue
      const v = String(req.body[field] ?? '').trim()
      if (v && !CATEGORY_RE.test(v)) return res.status(400).json({ ok: false, error: `invalid ${field}` })
      cat[field] = v
    }
    if (!('project' in cat) && !('projectIdea' in cat) && !('area' in cat))
      return res.status(400).json({ ok: false, error: 'nothing to set' })
    const vault = taskVault(req.body?.vault)
    if (!vault) return res.status(404).json({ ok: false, error: 'unknown or non-typed vault' })
    const abs = path.join(vault.path, rel)
    if (!fs.existsSync(abs)) return res.status(404).json({ ok: false, error: 'task not found' })

    const day = today()
    const slug = path.basename(rel, '.md')
    const label = cat.project || cat.projectIdea || cat.area || 'cleared'
    const result = await enqueueAtlasCommit({
      vault: vault.key,
      message: `tasks: ${slug} category ${label}`,
      paths: rel,
      mutate: async () => {
        const text = fs.readFileSync(abs, 'utf-8')
        const next = setCategory(text, cat, day)
        if (next == null) throw new Error('task note has no frontmatter')
        if (next !== text) fs.writeFileSync(abs, next)
      },
    })
    res.status(result.ok ? 200 : 502).json(result)
  })

  return r
}
