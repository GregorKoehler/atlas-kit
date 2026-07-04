/* ------------------------------------------------------------------ *
 * General vault commit queue — the SINGLE serialization point for every
 * write to the vault (VAULT_PATH). All writers funnel through here so
 * commits to `main` never race: the Kanban drag-to-done, the done-clear
 * cron, the paired-worker ingest, manual tools, … Each job runs inside an
 * in-process mutex that does pull --rebase --autostash → apply the change
 * → commit → push, with a ref-lock-race retry (the refresh-atlas cron +
 * any worker worktree share this .git). Never throws — a failure comes
 * back as { ok:false, warning } so a transient remote race reconciles
 * next sync.
 *
 * Two job shapes, both serialized through the same lock:
 *   enqueueAtlasCommit({ message, mutate, paths? }) — `mutate(atlasPath)`
 *     edits files in the Atlas working tree (e.g. flip a Task's `status:`
 *     for a Kanban move); we stage (paths, or -A) + commit + push.
 *   enqueueAtlasMerge({ branch, message? }) — merge a worker's `atlas/<…>`
 *     branch into main (the built-in `merge=union` driver auto-resolves the
 *     append-only log.md/index.md) + push. A genuine conflict is aborted
 *     and flagged, never force-resolved.
 *
 * Usage (e.g. the Kanban move endpoint a future dev agent will add):
 *   await enqueueAtlasCommit({
 *     message: `tasks: ${slug} → ${status}`,
 *     paths: `Tasks/${file}`,
 *     mutate: async (atlas) => { ...rewrite the task's status frontmatter... },
 *   })
 * ------------------------------------------------------------------ */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import os from 'node:os'
import { resolveVault, defaultVaultKey } from './vaults.mjs'

const execFileAsync = promisify(execFile)
const BRANCH = process.env.ATLAS_BRANCH || 'main'
// Exported so the detached ingest worker commits vault branches under the same
// identity (env-overridable) without a third copy of these constants.
export const AUTHOR_NAME = process.env.ATLAS_AUTHOR_NAME || 'Atlas Kit'
export const AUTHOR_EMAIL = process.env.ATLAS_AUTHOR_EMAIL || 'atlas-kit@localhost'
// A dedicated, throwaway worktree for branch merges. The merge runs HERE, never
// in the live main checkout — a capture/research/amend ingest into Atlas edits
// that checkout in place (cwd = atlas root), and `git merge` aborts on a dirty
// tree, which is what stranded paired-worker branches. withLock serializes
// merges, so one reusable path is safe (recreated fresh per merge).
const MERGE_WT = process.env.ATLAS_MERGE_WORKTREE || path.join(os.tmpdir(), 'atlas-kit-merge')

// Serialize every job: a promise chain so two writers can't interleave a
// pull/rebase/commit/push against the one Atlas checkout. (Single box, in-process.)
let chain = Promise.resolve()
function withLock(fn) {
  const run = chain.then(fn, fn)
  chain = run.then(
    () => {},
    () => {},
  )
  return run
}

// Transient lock collision (the refresh-atlas cron's pull, a worker worktree op,
// or a concurrent push) holding .git/index.lock or a ref lock — retry briefly
// rather than fail. Same class the capture committer handles.
const LOCK_RE = /index\.lock|Unable to create|another git process|cannot lock ref/i
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function atlasPath(vault) {
  return resolveVault(vault || defaultVaultKey())?.path || null
}

async function git(atlas, args, attempt = 0) {
  try {
    return await execFileAsync('git', ['-C', atlas, '-c', `safe.directory=${atlas}`, ...args], {
      encoding: 'utf-8',
      timeout: 60000,
    })
  } catch (e) {
    const msg = (e?.stderr || e?.message || '').toString()
    if (attempt < 4 && LOCK_RE.test(msg)) {
      await sleep(200 * (attempt + 1))
      return git(atlas, args, attempt + 1)
    }
    throw e
  }
}

async function syncMain(atlas) {
  await git(atlas, ['pull', '--rebase', '--autostash', 'origin', BRANCH])
}

// Push, retrying on a non-fast-forward race (another writer/phone pushed between
// our pull and push): re-sync and try again a couple of times. merge=union keeps
// the append-only files mergeable so the re-rebase stays clean.
async function pushMain(atlas) {
  for (let attempt = 0; ; attempt++) {
    try {
      await git(atlas, ['push', 'origin', BRANCH])
      return
    } catch (e) {
      const msg = (e?.stderr || e?.message || '').toString()
      if (attempt < 2 && /non-fast-forward|fetch first|rejected|behind/i.test(msg)) {
        await syncMain(atlas)
        continue
      }
      throw e
    }
  }
}

function oneLine(e) {
  return (e?.stderr || e?.message || String(e)).toString().replace(/\s+/g, ' ').trim().slice(0, 200)
}

/* Direct working-tree edit (Kanban status change, etc.). `mutate(atlasPath)`
 * makes the file changes; we stage `paths` (or everything) + commit + push.
 * `vault` selects which typed vault to write to (default the main `atlas`; the
 * Recipes Kanban passes `a sibling vault`) — its own checkout, same single-writer
 * lock so the two never race. Returns { ok, committed, pushed } or { ok:false, warning }. */
export function enqueueAtlasCommit({ message, mutate, paths, vault }) {
  return withLock(async () => {
    const atlas = atlasPath(vault)
    if (!atlas) return { ok: false, warning: `${vault} vault not configured` }
    const list = paths ? (Array.isArray(paths) ? paths : [paths]).filter(Boolean) : null
    try {
      await syncMain(atlas)
      if (typeof mutate === 'function') await mutate(atlas)
      await git(atlas, list ? ['add', '--', ...list] : ['add', '-A'])
      // Nothing staged (no-op edit / already identical)? Skip cleanly.
      try {
        await git(atlas, list ? ['diff', '--cached', '--quiet', '--', ...list] : ['diff', '--cached', '--quiet'])
        return { ok: true, committed: false, warning: 'nothing to commit' }
      } catch {
        /* non-zero = there ARE staged changes → proceed */
      }
      const commitArgs = [
        '-c',
        `user.name=${AUTHOR_NAME}`,
        '-c',
        `user.email=${AUTHOR_EMAIL}`,
        'commit',
        '-m',
        String(message || 'atlas: update').slice(0, 200),
      ]
      if (list) commitArgs.push('--', ...list)
      await git(atlas, commitArgs)
      await pushMain(atlas)
      return { ok: true, committed: true, pushed: true }
    } catch (e) {
      return { ok: false, warning: `atlas commit failed: ${oneLine(e)}` }
    }
  })
}

/* Merge a worker's branch into main (the paired-worker ingest). The merge runs
 * in an ISOLATED detached worktree at the freshly-fetched origin/main — NOT the
 * live main checkout, which a concurrent capture/research/amend ingest into
 * Atlas keeps dirty mid-run (cwd = atlas root); `git merge` aborts on a dirty
 * tree, and that abort is what stranded paired-worker branches "for manual
 * resolution". A pristine worktree can't be aborted by an unrelated writer.
 * The live checkout catches up on its next pull (cron / next queue op / the
 * best-effort ff below). `*.md merge=union` keeps the append-only files (and any
 * page) conflict-free. Returns { ok, merged, pushed } or { ok:false, warning }. */
export function enqueueAtlasMerge({ branch, message }) {
  return withLock(async () => {
    const atlas = atlasPath()
    if (!atlas) return { ok: false, warning: 'atlas vault not configured' }
    if (!branch) return { ok: false, warning: 'branch required' }
    const msg = String(message || `atlas: merge ${branch}`).slice(0, 200)
    try {
      // Fresh detached worktree at the latest origin/main (the live checkout has
      // `main` checked out, so --detach avoids "branch already checked out").
      await git(atlas, ['worktree', 'remove', '--force', MERGE_WT]).catch(() => {})
      await git(atlas, ['worktree', 'prune']).catch(() => {})
      await git(atlas, ['fetch', 'origin', BRANCH])
      await git(atlas, ['worktree', 'add', '--detach', MERGE_WT, `origin/${BRANCH}`])
      // Merge + push, re-merging onto a re-fetched origin/main on a non-ff race
      // (the ingest committer or the phone pushed between our fetch and push).
      for (let attempt = 0; ; attempt++) {
        await git(MERGE_WT, ['reset', '--hard', `origin/${BRANCH}`])
        await git(MERGE_WT, ['-c', `user.name=${AUTHOR_NAME}`, '-c', `user.email=${AUTHOR_EMAIL}`, 'merge', '--no-ff', '-m', msg, branch])
        try {
          await git(MERGE_WT, ['push', 'origin', `HEAD:${BRANCH}`])
          break
        } catch (e) {
          const m = (e?.stderr || e?.message || '').toString()
          if (attempt < 2 && /non-fast-forward|fetch first|rejected|behind/i.test(m)) {
            await git(atlas, ['fetch', 'origin', BRANCH])
            continue
          }
          throw e
        }
      }
      // Best-effort: fast-forward the live checkout so dashboard reads reflect the
      // merge now (no-op if it's dirty/busy — cron reconciles within 15 min).
      await git(atlas, ['merge', '--ff-only', `origin/${BRANCH}`]).catch(() => {})
      return { ok: true, merged: true, pushed: true }
    } catch (e) {
      return { ok: false, warning: `atlas merge failed (left for manual resolution): ${oneLine(e)}` }
    } finally {
      await git(atlas, ['worktree', 'remove', '--force', MERGE_WT]).catch(() => {})
      await git(atlas, ['worktree', 'prune']).catch(() => {})
    }
  })
}
