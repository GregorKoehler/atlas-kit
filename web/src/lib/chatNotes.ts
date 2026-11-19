import { useEffect, useState } from 'preact/hooks'
import { fetchTasks, fetchWikiPages, type WikiPage } from './api'

/* Atlas page links in chat views: the per-vault page list they resolve
 * against, and the global "open this page over the chat" signal that the one
 * <ChatNoteReader> (AppShell) answers.
 *
 * The page list is Wiki/ + Tasks/ (chats name tasks as often as pages), loaded
 * ONCE per vault and shared by every chat row — only when something needs it:
 * a click, or a rendered `Wiki/…/X.md` path that must know whether it exists.
 * The chat poll never fetches it. */

interface Entry {
  at: number
  pages: WikiPage[] | null
  pending: Promise<WikiPage[]> | null
}
const cache = new Map<string, Entry>()
const subs = new Set<() => void>()
// A rendered path re-checks against a list this old at most; a click wants
// one fresher, so a page an agent wrote a minute ago opens instead of "missing".
const STALE_MS = 5 * 60_000
const CLICK_STALE_MS = 15_000

const key = (vault?: string) => vault ?? ''

/** The vault's page list, fetched when the cached one is older than `maxAge`
 * (one request in flight per vault, however many callers). */
export function loadChatPages(vault: string | undefined, maxAge = STALE_MS): Promise<WikiPage[]> {
  const e = cache.get(key(vault)) ?? { at: 0, pages: null, pending: null }
  cache.set(key(vault), e)
  if (e.pages && Date.now() - e.at < maxAge) return Promise.resolve(e.pages)
  if (!e.pending) {
    e.pending = Promise.all([fetchWikiPages(vault), fetchTasks(vault)])
      .then(([wiki, tasks]) => [
        // Wiki first: a task never shadows a page of the same name (the graph's rule).
        ...wiki,
        ...tasks.map((t) => ({ title: (t.path.split('/').pop() ?? t.path).replace(/\.md$/i, ''), path: t.path, folder: 'Tasks' })),
      ])
      .catch(() => e.pages ?? [])
      .then((pages) => {
        e.pages = pages
        e.at = Date.now()
        e.pending = null
        subs.forEach((f) => f())
        return pages
      })
  }
  return e.pending
}

/** The cached page list of `vault` (loading it on first use), or null while
 * it loads. `enabled: false` → null and no fetch (a render outside any chat). */
export function useChatPages(vault: string | undefined, enabled = true): WikiPage[] | null {
  const [, bump] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const f = () => bump((n) => n + 1)
    subs.add(f)
    loadChatPages(vault)
    return () => void subs.delete(f)
  }, [vault, enabled])
  return enabled ? (cache.get(key(vault))?.pages ?? null) : null
}

let request: { vault?: string; target: string; n: number; ready: boolean } | null = null
const reqSubs = new Set<() => void>()

/** Open `target` (a [[link]] target or a vault path) of `vault` in the chat
 * overlay — once its page list is fresh enough to resolve it. */
export function openChatNote(vault: string | undefined, target: string) {
  const n = (request?.n ?? 0) + 1
  request = { vault, target, n, ready: false }
  loadChatPages(vault, CLICK_STALE_MS).then(() => {
    if (request?.n !== n) return // a newer click won
    request.ready = true
    reqSubs.forEach((f) => f())
  })
}

/** The latest open request, once its vault's page list is fresh. */
export function useChatNoteRequest() {
  const [, bump] = useState(0)
  useEffect(() => {
    const f = () => bump((n) => n + 1)
    reqSubs.add(f)
    return () => void reqSubs.delete(f)
  }, [])
  return request?.ready ? request : null
}
