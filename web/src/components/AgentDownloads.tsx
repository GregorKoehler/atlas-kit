import { createPortal } from 'preact/compat'
import { useEffect, useMemo, useState } from 'preact/hooks'
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
 * The strip of ⬇ chips for the files an agent dropped in its downloads dir
 * (the downloads preamble tells every agent that dir is the way to hand the
 * operator a file). ONE component for both render sites — a dev agent's row
 * (AgentList) and an Atlas chat's spawned-agent rows (AtlasSpawnedAgents) —
 * so the markup AND the "updated" bookkeeping can't drift apart.
 *
 * Why it isn't just an `<a href download>`: installed to a phone's home screen
 * the dashboard runs in a chrome-less webview (manifest `display: standalone`)
 * — no URL bar, no back button. A bare anchor NAVIGATES that one webview, and
 * because the download route answers with `Content-Disposition: attachment`,
 * iOS/WebKit swaps the whole app for its non-renderable-content shim: a grey
 * file-type placeholder, the filename, and two links that both lead further
 * AWAY. With zero navigation chrome the only recovery is killing and
 * relaunching the app. Note what that shim is NOT: a preview. The operator
 * never sees their image, just an icon of one. So on mobile this overlay is not
 * merely an escape hatch — it is the ONLY way a download chip ever shows the
 * operator their file. Hence:
 *
 *  - an image opens an IN-APP overlay (dismissible four ways, incl. the system
 *    back gesture — see below), with an explicit Save;
 *  - anything else gets a non-navigating hand-off: `download` (a real download
 *    wherever it's honoured — all desktop browsers — with `target` ignored),
 *    falling back to a `_blank` browser overlay, which HAS a Done button, where
 *    it isn't. `download` is IGNORED in the iOS standalone webview (it degrades
 *    to the navigation above), so on a phone this path rests entirely on the
 *    `_blank` behaviour.
 *
 * Either way the tap itself never navigates the app away.
 *
 * ⚠️ Do NOT add `-webkit-touch-callout: none` (or `user-select: none`) to
 * `.dlprev__img`. A real <img> means iOS's long-press → "Save Image" works,
 * which is a save route that stays entirely in the app and needs neither
 * `download` nor `_blank` — the most reliable one on the phone, given the above.
 */
export function AgentDownloads({ id, files }: { id: string; files: AgentDownloadFile[] }) {
  // Bumped when a file is marked seen, to re-evaluate each chip's "updated"
  // badge against localStorage right away instead of waiting for the next poll.
  const [dlTick, setDlTick] = useState(0)
  const [preview, setPreview] = useState<AgentDownloadFile | null>(null)
  const updated = useMemo(() => updatedDownloads(id, files), [files, id, dlTick])

  // Seen-rule (downloads.ts markDownloaded): opening the preview counts exactly
  // as downloading does — both showed the operator this version.
  const seen = (f: AgentDownloadFile) => {
    markDownloaded(id, f.name, f.mtime)
    setDlTick((t) => t + 1)
  }

  const open = !!preview
  const close = () => setPreview(null)

  // The overlay's dismissal routes, all of which keep the operator INSIDE the app:
  // ✕ and a backdrop tap are wired in the markup, Escape here, and the fourth is
  // the system back gesture — opening pushes a history entry, so the phone's
  // edge-swipe back POPS that entry (closing the overlay) instead of walking out
  // of the PWA. Closing any other way pops it again so the stack can't
  // accumulate; the push carries no URL, so `history.back()` only ever undoes our
  // own entry and never navigates the dashboard anywhere.
  useEffect(() => {
    if (!open) return
    let popped = false
    history.pushState({ atlasPreview: true }, '')
    const onPop = () => {
      popped = true
      close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('popstate', onPop)
    document.addEventListener('keydown', onKey)
    const unlock = lockBodyScroll()
    return () => {
      window.removeEventListener('popstate', onPop)
      document.removeEventListener('keydown', onKey)
      unlock()
      if (!popped) history.back()
    }
  }, [open])

  // Rendered through a portal (like the row's full-screen views) so the overlay
  // escapes the card's stacking/scroll context. Kept OUTSIDE the empty-files
  // early return below: a file vanishing mid-preview must still unmount the
  // overlay through the same path, or the scroll lock would stay held.
  const overlay = preview
    ? createPortal(
        <div className="dlprev" onClick={close}>
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
              onClick={close}
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

  return (
    <div className="agent__downloads" title="files this agent has offered for download">
      {files.map((f) => {
        const up = updated.has(f.name)
        const title = `${f.name} — ${fmtBytes(f.size)}${up ? ' — updated since you last downloaded it' : ''}`
        const badge = up ? <span className="agent__dl-badge" /> : null
        return isPreviewable(f.name) ? (
          <button
            key={f.name}
            type="button"
            className="agent__dl"
            onClick={() => {
              seen(f)
              setPreview(f)
            }}
            title={`${title} — opens here; Save from the preview`}
          >
            {badge}⬇ {f.name}
          </button>
        ) : (
          <a
            key={f.name}
            className="agent__dl"
            href={agentDownloadUrl(id, f.name)}
            download={f.name}
            // `download` wins wherever it's honoured (every desktop browser), and
            // `target` is then ignored — so a desktop click is the same real
            // download it has always been. Where it ISN'T honoured (an installed
            // PWA's standalone webview), `_blank` opens the browser overlay —
            // which has a Done button — rather than replacing the app's only view.
            target="_blank"
            rel="noopener"
            onClick={() => seen(f)}
            title={title}
          >
            {badge}⬇ {f.name}
          </a>
        )
      })}
      {overlay}
    </div>
  )
}
