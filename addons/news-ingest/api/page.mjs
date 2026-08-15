/* ------------------------------------------------------------------ *
 * What lands in the vault: one `Wiki/Sources/news-<slug>.md` per item, plus the
 * rolling digest page.
 *
 * Pure string work — no filesystem, no vault, no git — so the shape of what gets
 * committed is testable without any of them.
 *
 * Three things the item page guarantees, in descending order of how annoying it
 * is to lose them:
 *   1. THE SOURCE URL IS ON THE PAGE, twice: in the frontmatter (queryable) and
 *      in the Source section (readable). A note whose origin you cannot re-open
 *      is a rumour.
 *   2. THE FEED'S OWN TEXT IS VERBATIM, in its own blockquoted section — never
 *      folded into the model's prose, where a paraphrase would quietly replace
 *      what the publisher actually wrote.
 *   3. WHAT FAILED IS ON THE PAGE. No summary, a truncated excerpt, no date —
 *      each says so where the reader is, not only in a log they will never open.
 *
 * 🔴 THE DIGEST IS LIVE STATE, THE PAGES ARE HISTORY. Per the vault's
 * overwrite-live / append-history discipline the digest is rewritten whole every
 * run (it is a view of the last N items and nothing else is derived from it),
 * while each item page is written once and then only ever updated in place by a
 * re-ingest of that same item.
 * ------------------------------------------------------------------ */

/** `Hello, World! (2026)` → `hello-world-2026`. */
export function slugify(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '') // NFKD leaves accents behind as combining marks
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
}

/* The dedupe key is appended to the title slug, so two items that share a
 * headline ("Weekly roundup") get two pages instead of silently overwriting each
 * other — and so a title that slugifies to nothing at all still has a filename. */
export const slugFor = ({ title, key }) => {
  const base = slugify(title)
  return `news-${base ? `${base}-` : ''}${String(key).slice(0, 8)}`
}
export const pagePathFor = (item) => `Wiki/Sources/${slugFor(item)}.md`

const blockquote = (text) =>
  String(text)
    .split('\n')
    .map((l) => (l.trim() ? `> ${l}` : '>'))
    .join('\n')

/** YAML frontmatter is scalars, so a title is quoted and its quotes escaped —
 *  a headline containing `"` must not produce an unparseable page. */
const yamlString = (s) => `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/**
 * One item page.
 *
 * `summary` is `{ ok: true, tags, body }` or `{ ok: false, error }`; the title
 * always comes from the FEED, never from the model — the publisher's own
 * headline is the one thing here that is not a paraphrase.
 */
export function renderItemPage({ item, feed, summary = { ok: false }, ingestedAt, excerptTruncated = false }) {
  const title = item.title || item.link || 'Untitled item'
  const tags = ['news', feed.tag, ...(summary.ok ? summary.tags || [] : [])].filter((t, i, a) => t && a.indexOf(t) === i)
  const created = String(ingestedAt || '').slice(0, 10)

  const fm = [
    '---',
    'type: source',
    'source: news',
    `feed: ${feed.tag}`,
    `url: ${yamlString(item.link)}`,
    `created: ${created}`,
    ...(item.published ? [`published: ${item.published.slice(0, 10)}`] : []),
    `tags: [${tags.join(', ')}]`,
    '---',
  ].join('\n')

  const out = [fm, '', `# ${title}`, '']

  if (summary.ok) {
    out.push(summary.body, '')
  } else {
    out.push(
      `*No summary was written for this item — ${summary.error || 'the summary step did not run'}. The feed's own text below is exactly what it carried.*`,
      '',
    )
  }

  out.push("## From the feed", '')
  if (item.summary) {
    out.push(blockquote(item.summary), '')
    if (excerptTruncated) out.push('*(excerpt truncated by the ingest limit — open the source for the rest)*', '')
  } else {
    out.push('*The feed entry carried no text beyond its headline.*', '')
  }

  out.push('## Source', '')
  if (item.link) out.push(`- ${item.link}`)
  out.push(`- ${feed.title || feed.tag} — \`${feed.url}\``)
  if (item.published) out.push(`- Published ${item.published.slice(0, 10)}`)
  out.push(`- Ingested ${created} by \`addons/news-ingest\``)
  out.push('')
  return out.join('\n')
}

/**
 * The rolling digest — the last N ingested items, newest first, grouped by feed.
 *
 * Every row links to the item's own Source page (a wikilink, so the vault's
 * graph sees it) AND carries the outside URL, because the two answer different
 * questions: "what did I already file about this" and "take me to the thing".
 */
export function renderDigest({ items, feeds, generatedAt }) {
  const day = String(generatedAt || '').slice(0, 10)
  const out = [
    '---',
    'type: note',
    'tags: [news, digest]',
    `updated: ${day}`,
    '---',
    '',
    '# News digest',
    '',
    `*Live state, rewritten by \`addons/news-ingest\` on every sweep (last: ${generatedAt}). The ${items.length ? `${items.length} most recent ingested item(s)` : 'items'} below each have their own page under \`Wiki/Sources/\`; this page is a view, so edits to it are overwritten.*`,
    '',
  ]

  if (!items.length) {
    out.push('*Nothing ingested yet.*', '')
  } else {
    // Grouped by feed, feeds in "most recently ingested" order — the same order
    // the flat item list is already in, so the page reads newest-first at both
    // levels without a second sort key.
    const groups = new Map()
    for (const it of items) {
      const tag = it.feed || 'feed'
      if (!groups.has(tag)) groups.set(tag, [])
      groups.get(tag).push(it)
    }
    for (const [tag, rows] of groups) {
      const feed = feeds.find((f) => f.tag === tag)
      out.push(`## ${feed?.title || tag}`, '')
      for (const r of rows) {
        const name = String(r.page || '').replace(/^.*\//, '').replace(/\.md$/, '')
        const when = String(r.at || '').slice(0, 10)
        out.push(`- ${when} — [[${name}|${r.title || name}]]${r.url ? ` · [source](${r.url})` : ''}`)
      }
      out.push('')
    }
  }

  out.push('## Feeds', '')
  if (feeds.length) for (const f of feeds) out.push(`- \`${f.tag}\` — ${f.title || f.url}`)
  else out.push('*No feeds configured.*')
  out.push('')
  return out.join('\n')
}
