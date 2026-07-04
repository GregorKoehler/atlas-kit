/* ------------------------------------------------------------------ *
 * Daily done-clear — archive completed Kanban tasks off the board.
 *
 * The Kanban reads `Tasks/*.md` live off the vault working tree, and the
 * dashboard also visually ages `done` cards off the board each morning.
 * This cron makes that DURABLE: once a day it moves every `status: done`
 * task whose `done:` date is older than RETAIN_DAYS into `Tasks/.archive/`.
 * Because the reader skips dot-directories, an archived task leaves the
 * board but stays in the vault (and its git history) — nothing is deleted.
 *
 * Every move goes through the SAME serial commit queue the Kanban writes
 * use (pull --rebase --autostash → move → commit → push), so it never
 * races an in-flight drag against the shared checkout.
 *
 * Which vault: argv[2] (a vaults.json key), default `atlas`. A no-op when
 * the vault isn't configured / has no Tasks/ — safe to schedule anytime.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { resolveVault, defaultVaultKey } from '../api/src/vaults.mjs'
import { enqueueAtlasCommit } from '../api/src/atlas-commit-queue.mjs'

const key = process.argv[2] || defaultVaultKey()
const RETAIN_DAYS = Number(process.env.CLEAR_DONE_RETAIN_DAYS || 1)

// Read a single bare frontmatter scalar by key (line-based; no YAML dep, so this
// cron resolves cleanly from the repo root — same style as api/src/atlas-routes).
function fmScalar(md, k) {
  if (!md.startsWith('---')) return null
  const end = md.indexOf('\n---', 3)
  const block = end === -1 ? md : md.slice(3, end)
  const m = block.match(new RegExp(`^\\s*${k}:\\s*(.+?)\\s*$`, 'm'))
  return m ? m[1].replace(/^["']|["']$/g, '').trim() : null
}
function dateStr(v) {
  const s = v == null ? '' : String(v).trim()
  return s ? s.slice(0, 10) : null
}
function cutoff() {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - RETAIN_DAYS)
  return d.toISOString().slice(0, 10)
}

const vault = resolveVault(key)
if (!vault) {
  console.log(`clear-done: no "${key}" vault configured — nothing to do`)
  process.exit(0)
}
const tasksDir = path.join(vault.path, 'Tasks')
if (!fs.existsSync(tasksDir)) {
  console.log(`clear-done[${key}]: no Tasks/ — nothing to do`)
  process.exit(0)
}

// Find archivable done tasks (flat Tasks/*.md only — never re-scan .archive/).
const before = cutoff()
const archivable = []
for (const name of fs.readdirSync(tasksDir)) {
  if (!name.toLowerCase().endsWith('.md')) continue
  const abs = path.join(tasksDir, name)
  if (!fs.statSync(abs).isFile()) continue
  const md = fs.readFileSync(abs, 'utf-8')
  if ((fmScalar(md, 'type') || '') !== 'task') continue
  if ((fmScalar(md, 'status') || '').toLowerCase() !== 'done') continue
  const done = dateStr(fmScalar(md, 'done'))
  // Archive done tasks whose done-date is older than the retention window (a
  // task with no done-date is left in place until a status write stamps one).
  if (done && done < before) archivable.push(name)
}

if (!archivable.length) {
  console.log(`clear-done[${key}]: no done tasks older than ${before} — nothing to archive`)
  process.exit(0)
}

const r = await enqueueAtlasCommit({
  vault: key,
  message: `tasks: archive ${archivable.length} done task${archivable.length > 1 ? 's' : ''}`,
  mutate: async (root) => {
    const archiveDir = path.join(root, 'Tasks', '.archive')
    fs.mkdirSync(archiveDir, { recursive: true })
    for (const name of archivable) {
      const from = path.join(root, 'Tasks', name)
      if (fs.existsSync(from)) fs.renameSync(from, path.join(archiveDir, name))
    }
  },
})

if (r.ok) {
  console.log(`clear-done[${key}]: archived ${archivable.length} done task(s)${r.committed ? ' (committed)' : ''}`)
} else {
  console.error(`clear-done[${key}]: ${r.warning}`)
  process.exit(1)
}
