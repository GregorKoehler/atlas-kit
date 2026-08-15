/* ------------------------------------------------------------------ *
 * Download chips — the pure decisions behind the files an agent offers.
 *
 * Split out of AgentList so the two chip render sites (a dev agent's row and an
 * Atlas chat's spawned-agent rows) share ONE implementation, and so the parts
 * that are pure — the route a tap takes, the byte format, the "updated since you
 * last downloaded it" rule — are unit-testable off preact (downloads.test.mjs).
 * The rendering itself lives in components/AgentDownloads.tsx.
 * ------------------------------------------------------------------ */

/** One file a session offered for download (AgentSession['downloads'][number]). */
export interface AgentDownloadFile {
  name: string
  size: number
  mtime: number
}

/* ================================================================== *
 * THE INVARIANT: no tap on a download, of any file type, may ever perform a
 * top-level navigation of the app's webview.
 *
 * Installed to a phone's home screen the dashboard runs chrome-less (manifest
 * `display: standalone`) — no URL bar, no back button — so a navigation away is
 * UNRECOVERABLE, and what the operator lands on isn't even a preview, just the
 * browser's grey file-icon shim. The earlier fix rescued IMAGES with an in-app
 * overlay and left everything else on `download` + `target="_blank"`, betting
 * that `_blank` would open a dismissible browser overlay. Tested on a real
 * installed PWA: it does not — an `.html` and a `.txt` each navigated the app's
 * one webview and stranded it, the same dead end by a different route.
 *
 * So the split below is no longer "who gets rescued" but "where is an anchor
 * PROVEN safe": only where `download` is actually honoured, which the standalone
 * webview is exactly the case that isn't. Everything else opens in-app.
 * ================================================================== */

/** How the overlay renders a file. `binary` is the no-preview panel — name,
 * size and a Save action, still in-app, still dismissible. */
export type PreviewKind = 'image' | 'text' | 'html' | 'binary'

/* An `<img src>` / `srcdoc` / decoded text are all SUBRESOURCE loads, so the
 * download route's `Content-Disposition: attachment` is ignored (it only
 * suppresses rendering for top-level navigations) and no server change is
 * needed — which is what makes rendering every one of these in-app possible.
 * skipped: PDF preview (it stays `binary` here) — PDF-in-iframe is unreliable on
 * mobile and is its own job; add when that is worked out. What this change does
 * hand it is the mechanism: a blob URL in an <object>/<iframe> is a subresource,
 * so the attachment disposition no longer forces a navigation. */
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i
const HTML_RE = /\.(html?|xhtml)$/i
const TEXT_RE =
  /\.(txt|md|markdown|json|jsonl|csv|tsv|log|ya?ml|xml|ini|toml|env|diff|patch|sql|css|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|rb|go|rs|c|h|cpp|java|conf)$/i

export function previewKind(name: string): PreviewKind {
  if (IMAGE_RE.test(name)) return 'image'
  if (HTML_RE.test(name)) return 'html'
  if (TEXT_RE.test(name)) return 'text'
  return 'binary'
}

/* Above this the overlay does NOT pull the file into memory: no inline text/HTML
 * render and no share blob (the download route's own cap is 100 MB —
 * AGENT_DOWNLOAD_MAX_BYTES in agent-local.mjs). An image is exempt — it renders
 * straight from its URL as a subresource, at any size, exactly as it always has.
 * Agent downloads are reports and exports; this is a guard rail, not a working
 * limit. */
export const INLINE_MAX_BYTES = 4 * 1024 * 1024

/** The browser facts the route depends on. `canShareFiles` is only known once
 * the blob has landed (`navigator.canShare({files})` needs the real File), and
 * it is read ONLY by `save` — `tap` never depends on it, so a caller that
 * doesn't know it yet can leave it out. */
export interface DownloadEnv {
  /** Chrome-less installed webview: `download` is ignored and there is no way back. */
  standalone: boolean
  /** `<a download>` exists at all (every desktop browser; false on ancient ones). */
  downloadHonoured: boolean
  canShareFiles?: boolean
}

/** Where the tap goes. `anchor` is a real browser download; `overlay` is in-app. */
export type TapRoute = 'overlay' | 'anchor'
/** How the overlay's explicit Save hands the file over. */
export type SaveRoute = 'share' | 'anchor' | 'longpress' | 'none'

export interface DownloadPlan {
  kind: PreviewKind
  tap: TapRoute
  save: SaveRoute
  /** Small enough to fetch into memory (inline render + a share blob). */
  inline: boolean
  /** Whether the overlay must pull the bytes in at all — to render text/HTML, or
   * because the share sheet is the only save route left and `canShare` needs a
   * real File to answer. False on the desktop image overlay, which renders from
   * the URL and saves with a plain anchor: that path stays a single request. */
  prefetch: boolean
}

/** THE routing decision, in one pure place — the piece that must never again
 * silently choose "navigate". Both the chip (which reads `tap`) and the overlay
 * (which reads `kind`/`save`) go through it. */
export function downloadRoute(file: { name: string; size: number }, env: DownloadEnv): DownloadPlan {
  const raw = previewKind(file.name)
  // An image renders from its URL, so its size never demotes it; text/HTML have
  // to be read into memory first, and a huge one falls back to the panel.
  const inline = file.size <= INLINE_MAX_BYTES
  const kind: PreviewKind = raw !== 'image' && !inline ? 'binary' : raw
  // ⚠️ THE line that holds the invariant. An anchor is allowed ONLY where
  // `download` is honoured AND we are not in the standalone webview — where it
  // is silently ignored and the click degrades into the navigation this module
  // exists to prevent. Note what is NOT here: no UA sniff, no screen width, and
  // no `target="_blank"` escape hatch (that was the bet that failed on device).
  const anchorSafe = env.downloadHonoured && !env.standalone
  return {
    kind,
    // Images have always opened in-app, desktop included — keep that.
    tap: raw === 'image' || !anchorSafe ? 'overlay' : 'anchor',
    // ⚠️ The ANCHOR outranks the share sheet, not the other way round. Desktop
    // browsers answer `canShare({files})` too, and a share dialog there would be
    // strictly worse than the download the operator expects — so the share sheet
    // is what the app reaches for only where a download cannot be had.
    save: anchorSafe
      ? 'anchor'
      : env.canShareFiles
        ? 'share'
        : // Standalone with no share route left. An image still has one that
          // never leaves the app (long-press → "Save Image"); nothing else
          // does, and saying so beats a Save button that does nothing.
          kind === 'image'
          ? 'longpress'
          : 'none',
    inline,
    prefetch: inline && (kind === 'text' || kind === 'html' || !anchorSafe),
  }
}

/** Read the two facts above off the browser, once per mount. `navigator.standalone`
 * is the iOS-specific flag; the display-mode query is the standard one (and covers
 * an installed Android/desktop PWA). Deliberately NOT a UA test. */
export function detectDownloadEnv(): DownloadEnv {
  const standalone =
    (typeof navigator !== 'undefined' && (navigator as unknown as { standalone?: boolean }).standalone === true) ||
    (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches)
  const downloadHonoured = typeof document !== 'undefined' && 'download' in document.createElement('a')
  return { standalone, downloadHonoured }
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
