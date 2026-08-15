/* ------------------------------------------------------------------ *
 * RSS 2.0 / Atom → `{ title, items: [{ id, title, link, published, summary }] }`.
 *
 * Pure string work: no network, no filesystem, no clock — so the part with all
 * the real variance (every publisher's idea of a feed) is testable against
 * fixtures alone, which is exactly what test/parse.test.mjs does.
 *
 * WHY NOT AN XML PARSER. An addon may not add an npm dependency (docs/ADDONS.md),
 * and a feed is a shallow, well-known shape: a flat list of <item>/<entry>
 * blocks, each with a handful of leaf tags. So this reads the tags it needs and
 * ignores everything else, rather than modelling XML. The cost is honest: it
 * would not survive a nested <item> inside an <item>, and no feed has one.
 *
 * 🔴 WHAT THE ID IS FOR. `id` is the dedupe key's whole input, so it is taken in
 * the order publishers actually keep stable — <guid>/<id>, then the link, then a
 * hash of title+date. A feed that rotates its guids re-ingests; one that omits
 * them entirely still dedupes on the URL, which is what almost every feed
 * without guids has.
 * ------------------------------------------------------------------ */
import crypto from 'node:crypto'

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** `&amp;` → `&`, `&#8217;` → `’`. Unknown entities are left alone rather than
 *  swallowed: a literal `&foo;` in a headline is text, not a decoding failure. */
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m
    }
    const v = NAMED[g.toLowerCase()]
    return v === undefined ? m : v
  })
}

const unwrapCdata = (s) => {
  const m = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(s)
  return m ? m[1] : s
}

/** Feed descriptions are HTML far more often than not — the vault gets text. */
export function stripHtml(s) {
  return decodeEntities(
    String(s ?? '')
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const tagRe = (name, prefixed) =>
  new RegExp(`<${prefixed ? '[a-z0-9]+:' : ''}${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${prefixed ? '[a-z0-9]+:' : ''}${name}>`, 'i')

/**
 * The text of the first `<name>` in `xml`, CDATA unwrapped and entity-decoded.
 *
 * The un-prefixed form is tried FIRST and the namespaced one (`dc:date`,
 * `content:encoded`, `media:title`) only as a fallback — otherwise a feed
 * carrying `<media:title>` before its real `<title>` would hand us the wrong one.
 */
export function tagText(xml, name) {
  const m = tagRe(name, false).exec(xml) || tagRe(name, true).exec(xml)
  return m ? decodeEntities(unwrapCdata(m[1])).trim() : ''
}

const attrs = (s) =>
  Object.fromEntries(
    [...String(s).matchAll(/([a-z0-9:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => [
      m[1].toLowerCase(),
      decodeEntities(m[2] ?? m[3]),
    ]),
  )

/** Atom's `<link href … rel="alternate">`: the page a human would open. */
export function atomLink(block) {
  const links = [...String(block).matchAll(/<(?:[a-z0-9]+:)?link\b([^>]*?)\/?>/gi)].map((m) => attrs(m[1]))
  const withHref = links.filter((a) => a.href)
  return (
    withHref.find((a) => a.rel === 'alternate')?.href ||
    withHref.find((a) => !a.rel)?.href ||
    withHref[0]?.href ||
    ''
  )
}

/** ISO-8601, or `''` when the feed's date is missing or unparseable — an empty
 *  string is a fact the page can state, a bogus date is one it cannot. */
export function toIso(raw) {
  const t = Date.parse(String(raw ?? '').trim())
  return Number.isFinite(t) ? new Date(t).toISOString() : ''
}

const blocks = (xml, name) =>
  [...xml.matchAll(new RegExp(`<(?:[a-z0-9]+:)?${name}(?:\\s[^>]*)?>[\\s\\S]*?</(?:[a-z0-9]+:)?${name}>`, 'gi'))].map((m) => m[0])

/**
 * Parse one feed body. Never throws: a truncated download, an HTML error page
 * served with a feed's content-type, a feed with zero entries — all come back as
 * `{ title, items: [] }` and the caller reports "0 items" rather than dying.
 */
export function parseFeed(xml, { excerptChars = 4000 } = {}) {
  const text = String(xml ?? '')
  const entries = [...blocks(text, 'item'), ...blocks(text, 'entry')]
  // The channel/feed title lives BEFORE the first entry — read only that slice,
  // so a first entry's own <title> cannot be mistaken for the feed's (and so a
  // 4 MB feed is not copied once per item to find one string).
  const firstEntry = entries.length ? text.indexOf(entries[0]) : -1
  const feedTitle = tagText(firstEntry > 0 ? text.slice(0, firstEntry) : firstEntry === 0 ? '' : text, 'title')

  const items = entries.map((block) => {
    const title = tagText(block, 'title')
    const guid = tagText(block, 'guid') || tagText(block, 'id')
    const link = tagText(block, 'link') || atomLink(block)
    const published = toIso(
      tagText(block, 'pubDate') || tagText(block, 'published') || tagText(block, 'updated') || tagText(block, 'date'),
    )
    const full = stripHtml(
      tagText(block, 'description') || tagText(block, 'summary') || tagText(block, 'encoded') || tagText(block, 'content'),
    )
    // Capped here rather than at the page: the excerpt is also what goes into the
    // prompt, and a full-text feed would otherwise put whole articles in both.
    const summary = full.slice(0, excerptChars)
    const id =
      guid ||
      link ||
      // Last resort: something stable derived from the item itself. A feed with
      // no guid, no link AND no date would otherwise re-ingest on every sweep.
      `sha1:${crypto.createHash('sha1').update(`${title}\n${published}`).digest('hex')}`
    return { id, title, link, published, summary, summaryTruncated: full.length > summary.length }
  })

  // Newest first when the feed dates every entry (most do); otherwise document
  // order, which is the publisher's own ordering and better than a partial sort.
  const dated = items.length > 0 && items.every((i) => i.published)
  const ordered = dated ? [...items].sort((a, b) => (a.published < b.published ? 1 : a.published > b.published ? -1 : 0)) : items

  return { title: feedTitle, items: ordered.filter((i) => i.title || i.link) }
}

/** The dedupe key: this item, in this feed. Stable across runs and machines. */
export const itemKey = (feedUrl, id) => crypto.createHash('sha1').update(`${feedUrl}\n${id}`).digest('hex').slice(0, 16)
