/* ------------------------------------------------------------------ *
 * Download chips — the pure decisions behind the files an agent offers.
 *
 * Split out of AgentList so the two chip render sites (a dev agent's row and an
 * Atlas chat's spawned-agent rows) share ONE implementation, and so the parts
 * that are pure — previewability, the byte format, the "updated since you last
 * downloaded it" rule — are unit-testable off preact (downloads.test.mjs).
 * The rendering itself lives in components/AgentDownloads.tsx.
 * ------------------------------------------------------------------ */

/** One file a session offered for download (AgentSession['downloads'][number]). */
export interface AgentDownloadFile {
  name: string
  size: number
  mtime: number
}

/* Which files the dashboard previews IN-APP — i.e. renders inside its own
 * overlay instead of handing the file to the browser. Installed to a phone's
 * home screen the dashboard runs chrome-less (manifest `display: standalone`),
 * so ANY navigation away is unrecoverable — and what the operator lands on
 * isn't even a preview, just the browser's grey file-icon shim. So this
 * predicate decides not only who gets rescued but who the operator can SEE at
 * all on a phone.
 *
 * Images only, deliberately. An `<img src>` is a SUBRESOURCE load, so the
 * download route's `Content-Disposition: attachment` is ignored (it only
 * suppresses rendering for top-level navigations) and no server change is
 * needed. A PDF would need a real navigation (iframe/embed), which that same
 * disposition turns straight back into a download — so PDFs take the
 * non-navigating hand-off with every other type. */
const PREVIEWABLE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i

export function isPreviewable(name: string): boolean {
  return PREVIEWABLE.test(name)
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/* The mtime this operator last SAW, per (session id, filename), so a fresh write
 * to the agent's downloads dir (a newer mtime than what's stored) can flag an
 * "updated" badge. */
function dlKey(id: string, name: string): string {
  return `atlas-kit-agent-dl:${id}:${name}`
}

export function lastDownloadedMtime(id: string, name: string): number {
  try {
    return Number(localStorage.getItem(dlKey(id, name))) || 0
  } catch {
    return 0
  }
}

/** Record `mtime` as the version of this file the operator has now seen.
 *
 * THE RULE (one, for both chip sites): a file counts as SEEN when the operator
 * opens its in-app preview, exactly as it does when they download it — in both
 * cases they have been shown that version. So the badge clears on either, and
 * only a NEWER write from the agent brings it back. */
export function markDownloaded(id: string, name: string, mtime: number) {
  try {
    localStorage.setItem(dlKey(id, name), String(mtime))
  } catch {
    /* private mode etc. — the badge just won't persist across reloads */
  }
}

/** The names in `files` written since the operator last saw them (badge on). */
export function updatedDownloads(id: string, files: AgentDownloadFile[]): Set<string> {
  const set = new Set<string>()
  for (const f of files) {
    if (f.mtime > lastDownloadedMtime(id, f.name)) set.add(f.name)
  }
  return set
}
