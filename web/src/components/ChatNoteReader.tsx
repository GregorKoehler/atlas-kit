import { useEffect, useRef } from 'preact/hooks'
import { createPortal } from 'preact/compat'
import { NoteReader } from './NoteReader'
import { useNoteReader } from '../lib/useNoteReader'
import { ChatVault } from '../lib/markdown'
import { useChatNoteRequest, useChatPages } from '../lib/chatNotes'

/** The one overlay every chat view's Atlas page links open in (mounted once,
 * by AppShell). The chat rows stay mounted underneath — still polling, scroll
 * and draft untouched — because opening a page is a global signal
 * (chatNotes.openChatNote), not state of the row. Links followed inside push
 * onto the reader's own back stack. Portaled to <body> so it stacks above a
 * full-screen chat, which is portaled there too. */
export function ChatNoteReader() {
  const req = useChatNoteRequest()
  const vault = req?.vault
  const pages = useChatPages(vault, !!req)
  const r = useNoteReader(pages)
  const done = useRef(0)
  useEffect(() => {
    if (!req || !pages || req.n <= done.current) return
    done.current = req.n
    r.openTarget(req.target)
  }, [req?.n, pages])

  if (!r.path && !r.missing) return null
  return createPortal(
    // Inside the overlay, vault paths link like they do in the chat.
    <ChatVault.Provider value={{ vault }}>
      <NoteReader
        variant="compact"
        path={r.path}
        missing={r.missing}
        anchor={r.anchor}
        vault={vault}
        canGoBack={r.canGoBack}
        onBack={r.back}
        onClose={r.close}
        onWikiLink={r.navigate}
      />
    </ChatVault.Provider>,
    document.body,
  )
}
