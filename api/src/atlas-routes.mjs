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
 * ------------------------------------------------------------------ */
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { resolveVault, isTypedVault } from './vaults.mjs'
import { enqueueAtlasCommit } from './atlas-commit-queue.mjs'
import { setFlag, flagKey } from './atlas-type-flags.mjs'

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

function today() {
  return new Date().toISOString().slice(0, 10)
}

// Resolve the target vault for a task write: the request body's `vault` (default
// the main `atlas`; the Recipes Kanban sends `a sibling vault`). Required to be a
// TYPED vault (carries a Wiki/Legend.md) — the typed Kanban is the only task-write
// surface, so this also keeps a stray key from scribbling Tasks/ into a plain
// vault. Returns { key, path } or null when the vault is unknown / untyped.
function taskVault(req) {
  const key = String(req.body?.vault || 'atlas')
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

export function atlasRouter(bearerAuth) {
  const r = express.Router()

  // Restage a task: set its status (Kanban column) and commit to the Atlas.
  r.post('/api/tasks/move', bearerAuth, async (req, res) => {
    const rel = String(req.body?.path || '')
    const status = String(req.body?.status || '').toLowerCase()
    if (!STATUSES.has(status)) return res.status(400).json({ ok: false, error: 'invalid status' })
    if (!TASK_RE.test(rel)) return res.status(400).json({ ok: false, error: 'invalid task path' })
    const vault = taskVault(req)
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
  // commit it. The note is prose-first per the Atlas Guide — the title is the
  // body's first line (what the Kanban reads as the card title); the typed
  // fields are filled in later by editing the note.
  //
  // Project/project-idea/area: an explicit `project`/`projectIdea`/`area` in the
  // body is used verbatim (the operator picked it in the composer); otherwise the
  // title is run through inference against the categories already in use, so the
  // card lands pre-coloured. Inference runs BEFORE the commit queue so its model
  // call never holds the wiki lock; a miss/failure just yields an uncategorised
  // task.
  r.post('/api/tasks/new', bearerAuth, async (req, res) => {
    const title = String(req.body?.title || '').trim()
    if (!title) return res.status(400).json({ ok: false, error: 'title required' })
    const due = String(req.body?.due || '').trim()
    if (due && !DATE_RE.test(due)) return res.status(400).json({ ok: false, error: 'invalid due date' })
    // Optional free-text body — the description paragraph(s) below the title line
    // (the Atlas task body convention). Normalise CRLF so the note stays clean.
    const bodyText = String(req.body?.body || '').replace(/\r\n/g, '\n').trim()
    let project = String(req.body?.project || '').trim()
    let projectIdea = String(req.body?.projectIdea || '').trim()
    let area = String(req.body?.area || '').trim()
    if (project && !CATEGORY_RE.test(project)) return res.status(400).json({ ok: false, error: 'invalid project' })
    if (projectIdea && !CATEGORY_RE.test(projectIdea))
      return res.status(400).json({ ok: false, error: 'invalid project idea' })
    if (area && !CATEGORY_RE.test(area)) return res.status(400).json({ ok: false, error: 'invalid area' })
    // Optional provenance facet (the Legend `source` enum — e.g. `email` for tasks
    // filed by the hourly email pass). A passthrough like project/area: written
    // verbatim into the frontmatter; lowercased + validated to a safe bare scalar.
    const source = String(req.body?.source || '').trim().toLowerCase()
    if (source && !SOURCE_RE.test(source)) return res.status(400).json({ ok: false, error: 'invalid source' })
    const vault = taskVault(req)
    if (!vault) return res.status(404).json({ ok: false, error: 'unknown or non-typed vault' })

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
    res
      .status(result.ok ? 200 : 502)
      .json(
        result.ok
          ? { ...result, path: rel, project: project || null, projectIdea: projectIdea || null, area: area || null }
          : result,
      )
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

  // Set (or clear) a task's due date: rewrite its `due` frontmatter and commit.
  r.post('/api/tasks/due', bearerAuth, async (req, res) => {
    const rel = String(req.body?.path || '')
    const due = String(req.body?.due || '').trim()
    if (!TASK_RE.test(rel)) return res.status(400).json({ ok: false, error: 'invalid task path' })
    if (due && !DATE_RE.test(due)) return res.status(400).json({ ok: false, error: 'invalid due date' })
    const vault = taskVault(req)
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
    const vault = taskVault(req)
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
    const vault = taskVault(req)
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
    const vault = taskVault(req)
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
