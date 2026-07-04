import { useEffect, useState } from 'preact/hooks'
import { NoteInline } from './NoteInline'
import { lockBodyScroll } from '../lib/scrollLock'

interface Props {
  path: string | null
  missing: string | null
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
export function NoteReader({ path, missing, vault, canGoBack, onBack, onClose, onWikiLink, onTaskChanged, onChat }: Props) {
  const isOpen = !!path || !!missing
  const [chatBusy, setChatBusy] = useState(false)
  const [chatErr, setChatErr] = useState('')

  // Reset the chat button's state whenever a different page is opened.
  useEffect(() => {
    setChatBusy(false)
    setChatErr('')
  }, [path])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const unlock = lockBodyScroll()
    return () => {
      document.removeEventListener('keydown', onKey)
      unlock()
    }
  }, [isOpen, onClose])

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
    <div className="reader" onClick={onClose}>
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
        <div className="reader__body">
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
