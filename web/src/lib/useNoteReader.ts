import { useState } from 'preact/hooks'
import type { WikiPage } from './api'
import { resolveTarget, type ReaderEntry } from './vaultLinks'

/**
 * Drives the note-reader overlay with a back-stack. Opening from outside the
 * reader (a search hit, a card, the graph) starts a fresh history; wikilinks
 * followed inside the reader push onto it so Back returns to the prior page.
 */
export function useNoteReader(pages: WikiPage[] | null | undefined) {
  // Visited entries; the last is the current page. Empty → reader closed.
  const [stack, setStack] = useState<ReaderEntry[]>([])
  const current: ReaderEntry = stack[stack.length - 1] ?? { path: null, missing: null }

  return {
    path: current.path,
    missing: current.missing,
    anchor: current.anchor,
    canGoBack: stack.length > 1,
    // Opened from outside the reader → fresh history.
    openPath: (path: string) => setStack([{ path, missing: null }]),
    openTarget: (target: string) => setStack([resolveTarget(target, pages)]),
    // A wikilink followed inside the reader → push so Back returns here.
    navigate: (target: string) => setStack((s) => [...s, resolveTarget(target, pages)]),
    back: () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)),
    close: () => setStack([]),
  }
}
