import { createPortal } from 'preact/compat'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { agentDownloadUrl } from '../lib/api'
import { lockBodyScroll } from '../lib/scrollLock'
import {
  fmtBytes,
  isPreviewable,
  markDownloaded,
  updatedDownloads,
  type AgentDownloadFile,
} from '../lib/downloads'

/**
 * ONE download hand-off, wearing whichever chrome the caller asked for.
 *
 * `isPreviewable` decides between the in-app image overlay and the
 * non-navigating `download` + `_blank` hand-off, and NOTHING else in this file
 * (or anywhere else) may open one of these files — the standalone-webview trap
 * documented on AgentDownloads below is a property of *how the tap is wired*,
 * so the strip and the sheet share this one wiring rather than each writing it.
 * The two differ only in className and label markup.
 */
function DownloadItem({
  id,
  file,
  updated,
  className,
  onSeen,
  onPreview,
  children,
}: {
  id: string
  file: AgentDownloadFile
  updated: boolean
  className: string
  onSeen: (f: AgentDownloadFile) => void
  onPreview: (f: AgentDownloadFile) => void
  children: ComponentChildren
}) {
  const title = `${file.name} — ${fmtBytes(file.size)}${updated ? ' — updated since you last downloaded it' : ''}`
  return isPreviewable(file.name) ? (
    <button
      type="button"
      className={className}
      onClick={() => {
        onSeen(file)
        onPreview(file)
      }}
      title={`${title} — opens here; Save from the preview`}
    >
      {children}
    </button>
  ) : (
    <a
      className={className}
      href={agentDownloadUrl(id, file.name)}
      download={file.name}
      // `download` wins wherever it's honoured (every desktop browser), and
      // `target` is then ignored — so a desktop click is the same real download
      // it has always been. Where it ISN'T honoured (an installed PWA's
      // standalone webview), `_blank` opens the browser overlay — which has a
      // Done button — rather than replacing the app's only view.
      target="_blank"
      rel="noopener"
      onClick={() => onSeen(file)}
      title={title}
    >
      {children}
    </a>
  )
}

/**
 * The files an agent dropped in its downloads dir (the downloads preamble tells
 * every agent that dir is the way to hand the operator a file). ONE component
 * for every render site — a dev agent's row (AgentList), an Atlas chat's
 * spawned-agent rows (AtlasSpawnedAgents) and, with `compact`, the full-screen
 * viewer's head and app-only bar — so the markup AND the "updated" bookkeeping
 * can't drift apart.
 *
 * Two presentations, same hand-off (DownloadItem above):
 *  - default: the wrapping strip of one chip per file, under the row's head;
 *  - `compact`: a single "⬇ N" chip with ONE aggregate updated-dot, which opens
 *    a dismissible sheet listing the files. That is what full screen gets: the
 *    strip's per-file chips cost real ROWS on a 390px phone (one per file, and
 *    full screen is where the transcript is the product), while the chip costs
 *    one chip's width whatever N is.
 *
 * Why a tap isn't just an `<a href download>`: installed to a phone's home
 * screen the dashboard runs in a chrome-less webview (manifest `display:
 * standalone`) — no URL bar, no back button. A bare anchor NAVIGATES that one
 * webview, and because the download route answers with `Content-Disposition:
 * attachment`, iOS/WebKit swaps the whole app for its non-renderable-content
 * shim: a grey file-type placeholder, the filename, and two links that both lead
 * further AWAY. With zero navigation chrome the only recovery is killing and
 * relaunching the app. Note what that shim is NOT: a preview. The operator never
 * sees their image, just an icon of one. So on mobile the image overlay is not
 * merely an escape hatch — it is the ONLY way a download chip ever shows the
 * operator their file.
 *
 * ⚠️ Do NOT add `-webkit-touch-callout: none` (or `user-select: none`) to
 * `.dlprev__img`. A real <img> means iOS's long-press → "Save Image" works,
 * which is a save route that stays entirely in the app and needs neither
 * `download` nor `_blank` — the most reliable one on the phone, given the above.
 */
export function AgentDownloads({
  id,
  files,
  compact,
}: {
  id: string
  files: AgentDownloadFile[]
  compact?: boolean
}) {
  // Bumped when a file is marked seen, to re-evaluate each chip's "updated"
  // badge against localStorage right away instead of waiting for the next poll.
  const [dlTick, setDlTick] = useState(0)
  const [preview, setPreview] = useState<AgentDownloadFile | null>(null)
  const [sheet, setSheet] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  const updated = useMemo(() => updatedDownloads(id, files), [files, id, dlTick])

  // Seen-rule (downloads.ts markDownloaded): opening the preview counts exactly
  // as downloading does — both showed the operator this version.
  const seen = (f: AgentDownloadFile) => {
    markDownloaded(id, f.name, f.mtime)
    setDlTick((t) => t + 1)
  }

  // The sheet is only ever a `compact` surface, and an agent whose last file
  // vanished mid-view must close it — derived rather than stored, so the effect
  // below unwinds the history entry on that path too instead of stranding it.
  const sheetOpen = !!compact && sheet && files.length > 0
  const open = sheetOpen || !!preview

  // ⚠️ …but derived is only half of it: the flag the sheet was OPENED with would
  // outlive its last file. `sheetOpen` correctly unmounts the portal (and unwinds
  // the history entry) when the agent's downloads dir empties, while `sheet`
  // stays true — so the next file the agent drops flips it back on its own and
  // the sheet pops open over the transcript, a bottom sheet appearing on the
  // phone with nobody having asked for it. Reset the flag with the files.
  useEffect(() => {
    if (!files.length) setSheet(false)
  }, [files.length])
  const previewRef = useRef(preview)
  previewRef.current = preview

  // The dismissal routes, all of which keep the operator INSIDE the app: ✕ and a
  // backdrop tap are wired in the markup, Escape here, and the fourth is the
  // system back gesture — an open overlay pushes a history entry, so the phone's
  // edge-swipe back POPS that entry instead of walking out of the PWA. Closing
  // any other way pops it again so the stack can't accumulate; the push carries
  // no URL, so `history.back()` only ever undoes our own entry and never
  // navigates the dashboard anywhere.
  //
  // ⚠️ ONE entry for the whole stack, not one per layer, even though the sheet
  // can have the image preview open on top of it. Two independent entries can't
  // be made safe here: both layers' popstate handlers are on `window`, so the
  // pop that closes the preview is also seen by the sheet's handler, and the
  // obvious fix (close the sheet when a preview opens) races — the cleanup's
  // `history.back()` is queued asynchronously while the new layer's `pushState`
  // runs synchronously, so the traversal lands on the entry just pushed and
  // slams the preview shut again. So: back-swipe dismisses the whole stack at
  // once (the operator stays in the app, which is the requirement), while
  // ✕/backdrop/Escape close only the top layer — closing the preview that way
  // returns to the sheet, and the single entry is still owed, so nothing stale
  // is left behind to eat a later back-swipe.
  useEffect(() => {
    if (!open) return
    let popped = false
    history.pushState({ atlasPreview: true }, '')
    const onPop = () => {
      popped = true
      setPreview(null)
      setSheet(false)
    }
    // ⚠️ CAPTURE phase + stopImmediatePropagation: the full-screen viewer and the
    // app-only overlay each close themselves on Escape from a BUBBLE-phase
    // document listener registered before this one, so an Escape aimed at this
    // overlay used to tear the whole full screen down with it (already true of
    // the image preview; the sheet would have inherited it). A capture listener
    // on `document` runs before every bubble listener on it, so stopping there
    // makes Escape peel exactly one layer — the top one.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      if (previewRef.current) setPreview(null)
      else setSheet(false)
    }
    window.addEventListener('popstate', onPop)
    document.addEventListener('keydown', onKey, true)
    const unlock = lockBodyScroll()
    return () => {
      window.removeEventListener('popstate', onPop)
      document.removeEventListener('keydown', onKey, true)
      unlock()
      if (!popped) history.back()
    }
  }, [open])

  const toggleSheet = () => {
    if (!sheet) {
      // Anchor the panel under the chip (desktop popover). Measured on open
      // rather than tracked: the head doesn't move while the sheet is up, and a
      // resize/scroll observer would be machinery for a case that can't happen
      // in a position:fixed full-screen overlay. The phone breakpoint ignores
      // these and docks the panel to the bottom edge instead.
      const r = chipRef.current?.getBoundingClientRect()
      setAnchor(
        r ? { top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 328)) } : null,
      )
    }
    setSheet((v) => !v)
  }

  // Rendered through a portal (like the row's full-screen views) so the overlay
  // escapes the card's stacking/scroll context. Kept OUTSIDE the empty-files
  // early return below: a file vanishing mid-preview must still unmount the
  // overlay through the same path, or the scroll lock would stay held.
  const overlay = preview
    ? createPortal(
        <div className="dlprev" onClick={() => setPreview(null)}>
          <img
            className="dlprev__img"
            src={agentDownloadUrl(id, preview.name)}
            alt={preview.name}
            onClick={(e) => e.stopPropagation()}
          />
          {/* Action bar at the BOTTOM: thumb-reachable on a phone, and clear of
              the notch/status bar. Safe-area insets in .dlprev__bar. */}
          <div className="dlprev__bar" onClick={(e) => e.stopPropagation()}>
            <span className="dlprev__name" title={preview.name}>
              {preview.name} · {fmtBytes(preview.size)}
            </span>
            <a
              className="dlprev__save"
              href={agentDownloadUrl(id, preview.name)}
              download={preview.name}
              target="_blank"
              rel="noopener"
              title="save this file"
            >
              ⬇ Save
            </a>
            <button
              type="button"
              className="dlprev__close"
              onClick={() => setPreview(null)}
              aria-label="close preview"
              title="close (Esc, backdrop tap, or the back gesture)"
            >
              ✕
            </button>
          </div>
        </div>,
        document.body,
      )
    : null

  if (!files.length) return overlay

  if (compact) {
    const n = updated.size
    return (
      <>
        <button
          ref={chipRef}
          type="button"
          className="agent__budget agent__dlchip"
          aria-expanded={sheetOpen}
          onClick={toggleSheet}
          title={
            `${files.length} file${files.length === 1 ? '' : 's'} offered for download` +
            (n ? ` · ${n} updated since you last downloaded ${n === 1 ? 'it' : 'them'}` : '') +
            ' — tap to list them'
          }
        >
          <span className="agent__ctx-label">⬇</span>
          <span className="agent__ctx-label tnum">{files.length}</span>
          {n ? <span className="agent__dl-badge" /> : null}
        </button>
        {/* Authored BEFORE the image overlay so the two portals land in that
            order in <body>; their z-indexes (.dlsheet 141, .dlprev 142) settle
            it regardless, since the preview is opened FROM the sheet and must
            paint over it. */}
        {sheetOpen
          ? createPortal(
              <>
                <div className="dlsheet-backdrop" onClick={() => setSheet(false)} />
                <div
                  className="dlsheet"
                  role="dialog"
                  aria-label="files this agent has offered for download"
                  style={
                    anchor ? `--dlsheet-top:${anchor.top}px;--dlsheet-left:${anchor.left}px` : undefined
                  }
                >
                  <div className="dlsheet__head">
                    <span className="hud-label">downloads</span>
                    <button
                      type="button"
                      className="dlsheet__close"
                      onClick={() => setSheet(false)}
                      aria-label="close"
                      title="close (Esc, backdrop tap, or the back gesture)"
                    >
                      ✕
                    </button>
                  </div>
                  {files.map((f) => (
                    <DownloadItem
                      key={f.name}
                      id={id}
                      file={f}
                      updated={updated.has(f.name)}
                      className="dlsheet__row"
                      onSeen={seen}
                      onPreview={setPreview}
                    >
                      <span className="dlsheet__name">⬇ {f.name}</span>
                      <span className="dlsheet__size tnum">{fmtBytes(f.size)}</span>
                      {updated.has(f.name) ? <span className="agent__dl-badge" /> : null}
                    </DownloadItem>
                  ))}
                </div>
              </>,
              document.body,
            )
          : null}
        {overlay}
      </>
    )
  }

  return (
    <div className="agent__downloads" title="files this agent has offered for download">
      {files.map((f) => (
        <DownloadItem
          key={f.name}
          id={id}
          file={f}
          updated={updated.has(f.name)}
          className="agent__dl"
          onSeen={seen}
          onPreview={setPreview}
        >
          {updated.has(f.name) ? <span className="agent__dl-badge" /> : null}⬇ {f.name}
        </DownloadItem>
      ))}
      {overlay}
    </div>
  )
}
