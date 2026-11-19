/* Atlas page links in every chat view (the follow-up to URL linking,
 * linkify.ts): a [[Page]], a [[Page|label]], a [[Page#Heading]]
 * and a bare `Wiki/…/X.md` / `Tasks/x.md` path in a chat open the page in a
 * small overlay over the chat.
 *
 * The ONE place that decides what a vault reference is and which page it
 * opens. markdown.tsx renders the tokens; useNoteReader / chatNotes.ts resolve
 * a click against a vault's page list. Resolution is on CLICK against a list
 * loaded once per vault — never a fetch per rendered link, so the chat poll
 * stays cheap.
 *
 * Pure and JSX-free on purpose, so `node --test` runs it directly
 * (vaultLinks.test.mjs).
 */
import type { WikiPage } from './api'
import { URL_SOURCE, readCandidate } from './linkify'

/** One entry of a note reader's back stack: an existing page (`path`, plus
 * the heading to scroll to) or a title with no page yet (`missing`). */
export interface ReaderEntry {
  path: string | null
  missing: string | null
  anchor?: string
}

/** `Page|label` (the inside of a [[…]]) → the target to resolve and the text
 * to show. A table cell's escaped `\|` arrives already unescaped. */
export function parseWikiLink(inner: string): { target: string; label: string } {
  const bar = inner.indexOf('|')
  const target = (bar < 0 ? inner : inner.slice(0, bar)).trim()
  const label = bar < 0 ? target : inner.slice(bar + 1).trim() || target
  return { target, label }
}

const noExt = (p: string) => p.replace(/\.md$/i, '')

/** Resolve a link target against a vault's page list. Accepts a title / file
 * name (`Demo-Project`, matched like Obsidian: by file name, any case), a
 * vault path with or without `.md` (`Tasks/foo`, `Wiki/Projects/X.md`), a path
 * tail (`Projects/X`), and a `#Heading` anchor on any of them.
 *
 * An explicit `.md` path that the list doesn't hold still opens by path: the
 * note endpoint is the truth about a file, and a reader's list covers Wiki/
 * only (a relative link to `../../Tasks/x.md` must not read "not created").
 * Anything else unmatched is `missing` — the reader's "not yet created" state,
 * never a dead click. */
export function resolveTarget(target: string, pages: WikiPage[] | null | undefined): ReaderEntry {
  const hash = target.indexOf('#')
  const page = (hash < 0 ? target : target.slice(0, hash)).trim().replace(/\\/g, '/').replace(/^\.?\//, '')
  const anchor = hash < 0 ? undefined : target.slice(hash + 1).trim() || undefined
  const want = noExt(page).toLowerCase()
  const list = pages ?? []
  let hit: WikiPage | undefined
  if (want.includes('/')) {
    hit =
      list.find((p) => noExt(p.path).toLowerCase() === want) ??
      list.find((p) => noExt(p.path).toLowerCase().endsWith('/' + want))
    if (!hit && /\.md$/i.test(page)) return { path: page, missing: null, anchor }
  } else if (want) {
    hit = list.find((p) => p.title.toLowerCase() === want)
  }
  return hit ? { path: hit.path, missing: null, anchor } : { path: null, missing: page || target, anchor }
}

/** A markdown link's href, when it points at another note of the same vault —
 * `[x](../Concepts/Y.md)`, `[x](Y%20Z.md#Part)`, `[x](/Tasks/t.md)` — as the
 * vault path (+ `#anchor`) to open; null for anything else (a URL, a non-.md
 * file, a path climbing out of the vault). `basePath` is the folder of the
 * note the link sits in. */
export function relativeNotePath(basePath: string | undefined, href: string): string | null {
  let h = href.trim()
  if (/^[a-z][a-z0-9+.-]*:/i.test(h) || h.startsWith('//')) return null
  try {
    h = decodeURI(h)
  } catch {
    /* keep it raw */
  }
  const hash = h.indexOf('#')
  const file = hash < 0 ? h : h.slice(0, hash)
  if (!/\.md$/i.test(file)) return null
  const parts = file.startsWith('/') ? [] : (basePath ?? '').split('/').filter(Boolean)
  for (const seg of file.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(seg)
  }
  return parts.join('/') + (hash < 0 ? '' : h.slice(hash))
}

/** A vault path in running text: `Wiki/…/X.md` or `Tasks/x.md`, not glued to
 * a preceding word or path (`/srv/vault/Wiki/…`, `docs/Wiki/…`). No spaces —
 * in prose there is no telling where such a path would start; a code span
 * holding exactly one path may have them (vaultPathOf). */
export const VAULT_PATH_SOURCE = String.raw`(?<![\w/.\-])(?:Wiki|Tasks)\/[^\s\x60<>|\[\]()*"']*?\.md(?!\w)`

/** The vault path a code span holds, when that is ALL it holds. */
export function vaultPathOf(code: string): string | null {
  const s = code.trim()
  return /^(?:Wiki|Tasks)\/[^\n\x60<>|]*\.md$/.test(s) ? s : null
}

/** The page a vault path names, from a vault's page list — case-insensitive,
 * so the link opens the file's real spelling — or null when the list has no
 * such page (the path then stays plain text). */
export function knownPath(pages: WikiPage[] | null | undefined, path: string): string | null {
  const want = path.toLowerCase()
  return (pages ?? []).find((p) => p.path.toLowerCase() === want)?.path ?? null
}

export type RefPart =
  | string
  | { kind: 'url'; text: string; href: string }
  | { kind: 'wiki'; text: string; target: string; label: string }
  | { kind: 'path'; text: string; path: string }

/** Plain (non-markdown) text split into text, URLs, [[wikilinks]] and vault
 * paths — the operator's own bubbles, question blocks, outbound briefs.
 * Concatenating every part's text gives the input back, byte for byte. */
export function splitRefs(text: string): RefPart[] {
  const re = new RegExp(String.raw`(\[\[[^\]\n]+\]\])|(${VAULT_PATH_SOURCE})|(${URL_SOURCE})`, 'g')
  const out: RefPart[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    let end = m.index + m[0].length
    let part: RefPart | null = null
    if (m[1]) part = { kind: 'wiki', text: m[0], ...parseWikiLink(m[0].slice(2, -2)) }
    else if (m[2]) part = { kind: 'path', text: m[0], path: m[0] }
    else {
      // The URL candidate over-matches trailing punctuation (linkify.ts).
      const c = readCandidate(m[0])
      end = m.index + c.length
      re.lastIndex = end
      if (c.href) part = { kind: 'url', text: c.text, href: c.href }
    }
    if (!part) continue
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(part)
    last = end
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Does a rendered heading's text answer a `#Heading` anchor? Compared the
 * forgiving way (case, punctuation and spacing ignored), so both Obsidian's
 * `[[Page#My Heading]]` and a slugged `#my-heading` land on it. */
export function headingMatches(text: string, anchor: string): boolean {
  const slug = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  return !!slug(anchor) && slug(text) === slug(anchor)
}
