/* Auto-linking for every chat surface: every link in every chat view is
 * clickable.
 *
 * The ONE place that decides what in a run of text is a link and where it is
 * allowed to point. markdown.tsx's renderInline folds URL_SOURCE into its own
 * tokenizer (so a URL is claimed before `_x_` italics can split it, and never
 * inside code, a [text](url), an image or a [[wikilink]]); plain-text surfaces
 * (operator bubbles, question blocks, the terminal view) call findLinks.
 *
 * Detected: http(s):// and mailto: URLs, `www.` hosts (href gets https://),
 * and markdown autolinks `<https://…>`. Never a bare domain or file name —
 * `markdown.tsx`, `foo.py`, `example.com` stay text.
 *
 * Pure and JSX-free on purpose, so `node --test` runs it directly
 * (linkify.test.mjs).
 */

// Characters a bare URL never contains: whitespace, angle brackets, ASCII and
// typographic quotes, backticks. Everything else is greedily taken and
// trimUrl gives back the trailing punctuation that belongs to the sentence.
const URL_BODY = '[^\\s<>"`„“”«»]'
/** A URL candidate: `<url>` (autolink, taken verbatim) or a bare URL that is
 * not glued to a preceding word, email or path (`foo@www.x`, `a/https://`).
 * Exported so renderInline can make it one alternative of its tokenizer. */
export const URL_SOURCE =
  `<(?:https?:\\/\\/|mailto:)[^\\s<>]+>|(?<![\\w@.\\/:-])(?:https?:\\/\\/|mailto:|www\\.)${URL_BODY}+`

// Sentence punctuation that ends a URL rather than belonging to it.
const TRAIL = /[.,;:!?…'"’‘”“„»›*]$/
const count = (s: string, c: string) => s.split(c).length - 1

/** Drop trailing sentence punctuation, and a closing `)`/`]` only while it is
 * unbalanced — so Wikipedia's `…/Foo_(bar)` keeps its paren but
 * "(see https://x.y)" does not swallow the sentence's. */
export function trimUrl(s: string): string {
  for (;;) {
    const last = s[s.length - 1]
    if (TRAIL.test(s)) s = s.slice(0, -1)
    else if (last === ')' && count(s, '(') < count(s, ')')) s = s.slice(0, -1)
    else if (last === ']' && count(s, '[') < count(s, ']')) s = s.slice(0, -1)
    else return s
  }
}

/** The href a link may carry, or null when it must stay text: only http(s)
 * with a host, and mailto with an address. `www.x.y` becomes https://www.x.y.
 * Everything else — javascript:, data:, a relative path — is refused, so a
 * hostile `[x](javascript:…)` in an agent reply renders as text. */
export function safeHref(raw: string): string | null {
  const s = raw.trim()
  const www = /^www\./i.test(s)
  const href = www ? `https://${s}` : s
  let u: URL
  try {
    u = new URL(href)
  } catch {
    return null
  }
  if (u.protocol === 'mailto:') return u.pathname.includes('@') ? href : null
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (!u.hostname) return null
  // `www.` alone is not a host — require a real domain after it.
  if (www && u.hostname.split('.').filter(Boolean).length < 3) return null
  return href
}

/** One candidate token (what URL_SOURCE matched) read into the link it makes:
 * how many characters of the token the link spans, its text, and its href
 * (null → leave it as text). */
export function readCandidate(token: string): { length: number; text: string; href: string | null } {
  if (token.startsWith('<')) {
    const inner = token.slice(1, -1)
    return { length: token.length, text: inner, href: safeHref(inner) }
  }
  const text = trimUrl(token)
  return { length: text.length, text, href: safeHref(text) }
}

export interface LinkRange {
  start: number
  end: number
  href: string
}

/** Every link in plain text, as [start, end) ranges over it.
 *
 * `wrapWidth` (the terminal view only): a TUI hard-wraps a long URL across
 * pane rows (the expired-login oauth URL is ~500 chars at 80 columns), so a
 * row-wise match would link a fragment. When a URL runs to the end of a row at
 * least `wrapWidth - 4` long and the next row is ONE URL-ish token, that row
 * is joined into the same link — its text keeps the line break, the href
 * doesn't. Chat bubbles never pass it: their text is not wrapped. */
export function findLinks(text: string, opts: { wrapWidth?: number } = {}): LinkRange[] {
  const re = new RegExp(URL_SOURCE, 'g')
  const out: LinkRange[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const start = m.index
    let raw = m[0]
    let end = start + raw.length
    if (opts.wrapWidth && !raw.startsWith('<')) {
      const rowStart = text.lastIndexOf('\n', start - 1) + 1
      let rowLen = end - rowStart
      while (text[end] === '\n' && rowLen >= opts.wrapWidth - 4) {
        const next = text.indexOf('\n', end + 1)
        const row = text.slice(end + 1, next < 0 ? text.length : next)
        const tok = row.trim()
        if (!tok || !new RegExp(`^${URL_BODY}+$`).test(tok)) break
        raw += tok
        rowLen = row.length
        end = next < 0 ? text.length : next
        // the token sits at the end of its row (trailing blanks aside)
        end = end - (row.length - row.trimEnd().length)
      }
    }
    if (raw.startsWith('<')) {
      const c = readCandidate(raw)
      if (c.href) out.push({ start, end, href: c.href })
      continue
    }
    const trimmed = trimUrl(raw)
    end -= raw.length - trimmed.length
    re.lastIndex = end
    const href = safeHref(trimmed)
    if (href) out.push({ start, end, href })
  }
  return out
}

export type LinkPart = string | { text: string; href: string }

/** Plain text split into text and link parts — the shape the bubbles render. */
export function linkify(text: string): LinkPart[] {
  const out: LinkPart[] = []
  let last = 0
  for (const l of findLinks(text)) {
    if (l.start > last) out.push(text.slice(last, l.start))
    const t = text.slice(l.start, l.end)
    out.push({ text: t.startsWith('<') ? t.slice(1, -1) : t, href: l.href })
    last = l.end
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
