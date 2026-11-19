import { useEffect, useRef, useState } from 'preact/hooks'
import { NoteInline } from './NoteInline'
import { lockBodyScroll } from '../lib/scrollLock'
import { headingMatches } from '../lib/vaultLinks'

interface Props {
  path: string | null
  missing: string | null
  /** A `[[Page#Heading]]` link's heading: scrolled to once the page renders. */
  anchor?: string
  /** 'compact' (a chat's page links): a panel over the chat, which stays
   *  visible beside it — not a full-screen takeover. A sheet on a phone. */
  variant?: 'full' | 'compact'
  /** Which vault the path lives in (default → work). */
  vault?: string
  /** True once a wikilink has been followed, so Back can return. */
  canGoBack?: boolean
  onBack?: () => void
  onClose: () => void
  onWikiLink: (target: string) => void
  /** Fired after an in-reader edit persists (e.g. an Atlas task's project/area),
   *  so the opener can reflect it (the Kanban re-polls to re-colour the card). */
  onTaskChanged?: () => void
  /** When provided (Atlas tab), shows a "Chat about this" button that opens a
   *  knowledge chat scoped to this page + its graph neighbourhood. Resolves the
   *  spawn result; the opener closes the reader on success (so this unmounts). */
  onChat?: (path: string) => Promise<{ ok: boolean; error?: string }>
}

/** Full-screen overlay reader for any vault note / wiki page (read-only, except
 *  the Atlas TaskView's project/area picker). */
export function NoteReader({ path, missing, anchor, variant = 'full', vault, canGoBack, onBack, onClose, onWikiLink, onTaskChanged, onChat }: Props) {
  const isOpen = !!path || !!missing
  const [chatBusy, setChatBusy] = useState(false)
  const [chatErr, setChatErr] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)

  // Reset the chat button's state whenever a different page is opened.
  useEffect(() => {
    setChatBusy(false)
    setChatErr('')
  }, [path])

  // Esc closes the reader ONLY — caught on the way down and stopped, so the
  // full-screen chat underneath (its own document-level Esc) stays open.
  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    const unlock = lockBodyScroll()
    return () => {
      window.removeEventListener('keydown', onKey, true)
      unlock()
    }
  }, [isOpen, onClose])

  // Scroll to the anchored heading once the note has loaded and rendered
  // (NoteInline fetches on its own); give up quietly after a few seconds.
  useEffect(() => {
    const body = bodyRef.current
    if (!path || !anchor || !body) return
    const find = () => {
      const h = [...body.querySelectorAll('h1, h2, h3, h4, h5, h6')].find((el) => headingMatches(el.textContent ?? '', anchor))
      if (h) h.scrollIntoView({ block: 'start' })
      return !!h
    }
    if (find()) return
    const mo = new MutationObserver(() => find() && stop())
    const t = setTimeout(() => stop(), 5000)
    const stop = () => {
      mo.disconnect()
      clearTimeout(t)
    }
    mo.observe(body, { childList: true, subtree: true })
    return stop
  }, [path, anchor])

  if (!isOpen) return null

  const title = path ? (path.split('/').pop() ?? path).replace(/\.(md|html)$/i, '') : missing

  const startChat = async () => {
    if (!path || !onChat || chatBusy) return
    setChatBusy(true)
    setChatErr('')
    const r = await onChat(path)
    // On success the opener closes the reader (this component unmounts), so leave
    // the button busy; on failure, re-enable it and surface the reason inline.
    if (!r.ok) {
      setChatBusy(false)
      setChatErr(r.error || 'could not start chat')
    }
  }

  return (
    <div className={variant === 'compact' ? 'reader reader--compact' : 'reader'} onClick={onClose}>
      <div className="reader__panel glass" onClick={(e) => e.stopPropagation()}>
        <header className="reader__head">
          <div className="reader__head-left">
            {canGoBack ? (
              <button type="button" className="reader__back" onClick={onBack}>
                ← Back
              </button>
            ) : null}
            <span className="reader__title hud-label">{title}</span>
          </div>
          <div className="reader__head-right">
            {onChat && path ? (
              <>
                {chatErr ? <span className="reader__chat-err">✗ {chatErr}</span> : null}
                <button
                  type="button"
                  className="reader__chat"
                  onClick={startChat}
                  disabled={chatBusy}
                  title="Open an Atlas chat scoped to this page and its graph neighbourhood"
                >
                  {chatBusy ? 'Opening…' : '💬 Chat about this'}
                </button>
              </>
            ) : null}
            <button type="button" className="reader__close" onClick={onClose} aria-label="Close">
              ✕
            </button>
          </div>
        </header>
        <div className="reader__body" ref={bodyRef}>
          {path ? (
            <NoteInline path={path} vault={vault} options={{ onWikiLink, onTaskChanged }} />
          ) : (
            <div className="empty-state">
              Page not yet created:{' '}
              <span className="wikilink wikilink--static">{missing}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
