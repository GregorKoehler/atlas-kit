import { createPortal } from 'preact/compat'
import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import type { ComponentChildren } from 'preact'
import { agentDownloadUrl } from '../lib/api'
import { lockBodyScroll } from '../lib/scrollLock'
import {
  detectDownloadEnv,
  downloadRoute,
  fmtBytes,
  markDownloaded,
  updatedDownloads,
  type AgentDownloadFile,
  type DownloadEnv,
} from '../lib/downloads'

/**
 * ONE download hand-off, wearing whichever chrome the caller asked for.
 *
 * `downloadRoute` (lib/downloads.ts) decides between the in-app overlay and a
 * plain `<a download>`, and NOTHING else in this file (or anywhere else) may
 * open one of these files — the standalone-webview trap documented on
 * AgentDownloads below is a property of *how the tap is wired*, so the strip and
 * the sheet share this one wiring rather than each writing it. The two differ
 * only in className and label markup.
 *
 * ⚠️ The anchor carries NO `target` and never will: in the standalone webview a
 * new browsing context IS a top-level navigation of the app, which is the exact
 * failure this component exists to prevent. It is reached only where `download`
 * is honoured, and there `target` was ignored anyway.
 */
function DownloadItem({
  id,
  file,
  updated,
  className,
  env,
  onSeen,
  onPreview,
  children,
}: {
  id: string
  file: AgentDownloadFile
  updated: boolean
  className: string
  env: DownloadEnv
  onSeen: (f: AgentDownloadFile) => void
  onPreview: (f: AgentDownloadFile) => void
  children: ComponentChildren
}) {
  const plan = downloadRoute(file, env)
  const title = `${file.name} — ${fmtBytes(file.size)}${updated ? ' — updated since you last downloaded it' : ''}`
  return plan.tap === 'overlay' ? (
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
      onClick={() => onSeen(file)}
      title={title}
    >
      {children}
    </a>
  )
}

/** What the bar says it did, so the operator can report which branch they hit —
 * the share sheet and the standalone webview only exist on a phone. */
const SAVE_LABEL = {
  share: 'via share sheet',
  anchor: 'via download',
  longpress: 'long-press the image → Save Image',
  none: 'no in-app save route',
} as const

/**
 * The overlay itself — one file, rendered IN THE APP whatever its type, with an
 * explicit Save. Reached for every type in the standalone webview and for images
 * everywhere; see DownloadItem above for who gets here.
 *
 * The body is pulled in as a Blob when the overlay OPENS, not when Save is
 * tapped, and that ordering is load-bearing: `navigator.share()` needs the tap's
 * transient activation, and an `await fetch(...)` inside the handler consumes it
 * → `NotAllowedError`. Prefetching means the Save handler calls `share()`
 * synchronously with the File already in hand. `canShare` is asked here too, for
 * the same reason — mobile browsers filter by MIME type, so a `false` must fall
 * through to a stated dead end, never to a navigation.
 */
function DownloadPreview({
  id,
  file,
  env,
  onClose,
}: {
  id: string
  file: AgentDownloadFile
  env: DownloadEnv
  onClose: () => void
}) {
  // ONE state for the whole prefetch, so "canShare said no" is distinguishable
  // from "not read yet" — two separate nulls would leave the bar stuck on
  // "preparing…" for exactly the types the share sheet refuses.
  const [body, setBody] = useState<{ text: string | null; share: File | null } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const shareFile = body?.share ?? null
  const text = body?.text ?? null
  const plan = downloadRoute(file, { ...env, canShareFiles: !!shareFile })
  const url = agentDownloadUrl(id, file.name)
  const needsText = plan.kind === 'text' || plan.kind === 'html'
  const loading = plan.prefetch && !err && !body

  useEffect(() => {
    if (!plan.prefetch) return
    let alive = true
    const ctrl = new AbortController()
    fetch(url, { signal: ctrl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const blob = await r.blob()
        // The route answers with a real Content-Type; the fallbacks are for the
        // bridge-proxied path, and a typeless File is what the share sheet refuses.
        const type =
          blob.type ||
          (plan.kind === 'html' ? 'text/html' : plan.kind === 'text' ? 'text/plain' : 'application/octet-stream')
        const decoded = needsText ? await blob.text() : null
        if (!alive) return
        const f = new File([blob], file.name, { type })
        // Asked ONCE, here — never inside the tap handler, where the extra work
        // is exactly what can cost the gesture its transient activation.
        setBody({ text: decoded, share: navigator.canShare?.({ files: [f] }) ? f : null })
      })
      .catch((e) => {
        if (alive && e?.name !== 'AbortError') setErr(String(e?.message || e))
      })
    return () => {
      alive = false
      ctrl.abort()
    }
  }, [url, plan.prefetch, needsText])

  const onSave = () => {
    if (!shareFile) return
    setNote(null)
    // ⚠️ NOTHING may be awaited between the tap and share(): the blob was
    // prefetched above precisely so this call is synchronous in the handler and
    // the gesture's transient activation is still ours.
    navigator
      .share({ files: [shareFile] })
      .then(() => setNote('handed to the share sheet'))
      .catch((e: { name?: string }) => {
        // A dismissed share sheet throws AbortError. That is the operator
        // changing their mind, not a failure — it must never read as one.
        if (e?.name === 'AbortError') return
        setNote(
          e?.name === 'NotAllowedError'
            ? 'the share sheet needs a fresh tap — tap Save again'
            : `share failed: ${e?.name || String(e)}`,
        )
      })
  }

  const stop = (e: Event) => e.stopPropagation()
  return (
    <>
      {plan.kind === 'image' ? (
        /* Straight from the URL, as a subresource — no fetch in the way, at any
           size, and the default touch callout gives long-press → "Save Image". */
        <img className="dlprev__img" src={url} alt={file.name} onClick={stop} />
      ) : err ? (
        <div className="dlprev__panel" onClick={stop}>
          <span>could not read this file</span>
          <span className="dlprev__route">{err}</span>
        </div>
      ) : plan.kind === 'html' && text !== null ? (
        /* ⚠️ `allow-scripts` WITHOUT `allow-same-origin` — an agent-authored
           report is untrusted content, and those two together would let it reach
           the dashboard's own origin and storage. Omitting allow-top-navigation
           and allow-popups is what makes "it cannot navigate the app" structural
           rather than a promise. srcdoc, so nothing is navigated to either. */
        <iframe className="dlprev__frame" title={file.name} sandbox="allow-scripts" srcdoc={text} />
      ) : plan.kind === 'text' && text !== null ? (
        <pre className="dlprev__text" onClick={stop}>
          {text}
        </pre>
      ) : (
        <div className="dlprev__panel" onClick={stop}>
          <span className="dlprev__panel-name">{file.name}</span>
          <span className="dlprev__route">
            {loading ? 'reading…' : plan.inline ? 'no in-app preview for this type' : 'too large to read in-app'}
          </span>
        </div>
      )}
      {/* Action bar at the BOTTOM: thumb-reachable on a phone, and clear of
          the notch/status bar. Safe-area insets in .dlprev__bar. */}
      <div className="dlprev__bar" onClick={stop}>
        <span className="dlprev__name" title={file.name}>
          {file.name} · {fmtBytes(file.size)}
        </span>
        <span className="dlprev__route">{note ?? (loading ? 'preparing…' : SAVE_LABEL[plan.save])}</span>
        {loading ? null : plan.save === 'share' ? (
          <button type="button" className="dlprev__save" onClick={onSave} title="hand this file to the system share sheet">
            ⬆ Save
          </button>
        ) : plan.save === 'anchor' ? (
          <a className="dlprev__save" href={url} download={file.name} title="save this file">
            ⬇ Save
          </a>
        ) : null}
        <button
          type="button"
          className="dlprev__close"
          onClick={onClose}
          aria-label="close preview"
          title="close (Esc, backdrop tap, or the back gesture)"
        >
          ✕
        </button>
      </div>
    </>
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
 * sees their image, just an icon of one. So on mobile the overlay is not merely
 * an escape hatch — it is the ONLY way a download chip ever shows the operator
 * their file.
 *
 * ⚠️ And `target="_blank"` is NOT the escape it looks like. The first cut of this
 * rescue left every non-image type on `download` + `_blank`, expecting `_blank`
 * to open a browser overlay with a Done button. Tested on a real installed PWA:
 * an `.html` and a `.txt` each stranded the app just the same. So the overlay now
 * takes EVERY type in the standalone webview, `target` is gone from this file
 * entirely, and the anchor survives only where `download` is honoured — see
 * `downloadRoute`.
 *
 * ⚠️ Do NOT add `-webkit-touch-callout: none` (or `user-select: none`) to
 * `.dlprev__img`. A real <img> means the phone's long-press → "Save Image"
 * works, which is a save route that stays entirely in the app and needs neither
 * `download` nor the share sheet — the most reliable one on the phone, given the
 * above.
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
  // Read once per mount: whether we are the installed chrome-less webview, and
  // whether `<a download>` exists at all. Both decide where a tap may go.
  const env = useMemo(() => detectDownloadEnv(), [])

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
          {/* Keyed by name so switching files inside the sheet remounts the
              prefetch rather than showing the previous file's body. */}
          <DownloadPreview key={preview.name} id={id} file={preview} env={env} onClose={() => setPreview(null)} />
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
                      env={env}
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
          env={env}
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
