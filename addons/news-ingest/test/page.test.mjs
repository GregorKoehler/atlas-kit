/* ------------------------------------------------------------------ *
 * What gets committed — the item page and the rolling digest, as strings.
 *
 * These are the three properties the page layout exists to guarantee, and each
 * one is a thing that would be silently lost if it regressed: the source URL is
 * on the page, the feed's own text is VERBATIM rather than paraphrased away, and
 * a failed summary SAYS SO on the page instead of only in a log.
 *
 * Run: node --test addons/news-ingest/test/page.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderItemPage, renderDigest, slugify, slugFor, pagePathFor } from '../api/page.mjs'

const feed = { url: 'https://example.org/feed.xml', tag: 'example', title: 'Example Blog' }
const item = {
  id: 'https://example.org/1',
  title: 'A "quoted" headline — with punctuation',
  link: 'https://example.org/1',
  published: '2026-08-14T12:00:00.000Z',
  summary: 'The feed said this.\n\nAnd then this.',
}
const at = '2026-08-15T06:30:00.000Z'

test('a summarized item page carries frontmatter, the summary and the verbatim excerpt', () => {
  const md = renderItemPage({
    item,
    feed,
    summary: { ok: true, tags: ['ai', 'release'], body: 'Two sentences of summary.' },
    ingestedAt: at,
  })
  assert.match(md, /^---\ntype: source\nsource: news\nfeed: example\n/)
  assert.match(md, /url: "https:\/\/example\.org\/1"/)
  assert.match(md, /created: 2026-08-15\npublished: 2026-08-14\n/)
  assert.match(md, /tags: \[news, example, ai, release\]/)
  assert.match(md, /# A "quoted" headline — with punctuation/, 'the headline is the FEED’s, never the model’s')
  assert.match(md, /Two sentences of summary\./)
  assert.match(md, /## From the feed\n\n> The feed said this\.\n>\n> And then this\./, 'the feed’s own words, blockquoted and unchanged')
  assert.match(md, /- https:\/\/example\.org\/1/)
  assert.match(md, /- Example Blog — `https:\/\/example\.org\/feed\.xml`/)
  assert.match(md, /- Ingested 2026-08-15 by `addons\/news-ingest`/)
})

test('a failed summary is STATED on the page, and the item is still filed', () => {
  const md = renderItemPage({ item, feed, summary: { ok: false, error: 'claude -p timed out after 120000ms' }, ingestedAt: at })
  assert.match(md, /No summary was written for this item — claude -p timed out/)
  assert.match(md, /> The feed said this\./, 'the excerpt is the half that must never be lost')
  assert.match(md, /tags: \[news, example\]/)
})

test('an empty excerpt and a truncated one both say which they are', () => {
  const bare = renderItemPage({ item: { ...item, summary: '' }, feed, ingestedAt: at })
  assert.match(bare, /The feed entry carried no text beyond its headline\./)
  const cut = renderItemPage({ item, feed, ingestedAt: at, excerptTruncated: true })
  assert.match(cut, /excerpt truncated by the ingest limit/)
})

test('a quote in the headline cannot break the YAML', () => {
  const md = renderItemPage({ item: { ...item, link: 'https://e/"x"' }, feed, ingestedAt: at })
  assert.match(md, /url: "https:\/\/e\/\\"x\\""/)
})

test('the slug is title-derived, key-suffixed, and never empty', () => {
  assert.equal(slugify('Hello, World! (2026)'), 'hello-world-2026')
  assert.equal(slugify('Ünïcödé Ítems'), 'unicode-items')
  assert.equal(slugFor({ title: 'Weekly roundup', key: 'abcdef0123456789' }), 'news-weekly-roundup-abcdef01')
  assert.equal(slugFor({ title: '', key: 'abcdef0123456789' }), 'news-abcdef01', 'a title that slugifies to nothing still has a filename')
  assert.notEqual(
    slugFor({ title: 'Weekly roundup', key: 'aaaaaaaa1' }),
    slugFor({ title: 'Weekly roundup', key: 'bbbbbbbb2' }),
    'two items sharing a headline get two pages, not one silent overwrite',
  )
  assert.equal(pagePathFor({ title: 'X', key: 'deadbeefcafe' }), 'Wiki/Sources/news-x-deadbeef.md')
})

test('the digest is a grouped, wikilinked VIEW that says it is overwritten', () => {
  const md = renderDigest({
    generatedAt: at,
    feeds: [feed, { url: 'https://other.example/f', tag: 'other', title: 'Other' }],
    items: [
      { at, title: 'Newest', url: 'https://example.org/2', feed: 'example', page: 'Wiki/Sources/news-newest-1234abcd.md' },
      { at: '2026-08-14T06:00:00.000Z', title: 'Older', url: 'https://other.example/1', feed: 'other', page: 'Wiki/Sources/news-older-5678ef00.md' },
      { at: '2026-08-13T06:00:00.000Z', title: 'Oldest', url: '', feed: 'example', page: 'Wiki/Sources/news-oldest-9999aaaa.md' },
    ],
  })
  assert.match(md, /this page is a view, so edits to it are overwritten/)
  assert.match(md, /## Example Blog\n\n- 2026-08-15 — \[\[news-newest-1234abcd\|Newest\]\] · \[source\]\(https:\/\/example\.org\/2\)/)
  assert.ok(md.indexOf('## Example Blog') < md.indexOf('## Other'), 'feeds appear in most-recently-ingested order')
  assert.match(md, /- 2026-08-13 — \[\[news-oldest-9999aaaa\|Oldest\]\]$/m, 'an item with no URL still links to its page')
  assert.match(md, /## Feeds\n\n- `example` — Example Blog\n- `other` — Other/)
})

test('an empty digest is a page, not a blank', () => {
  const md = renderDigest({ generatedAt: at, feeds: [], items: [] })
  assert.match(md, /# News digest/)
  assert.match(md, /\*Nothing ingested yet\.\*/)
  assert.match(md, /\*No feeds configured\.\*/)
})
