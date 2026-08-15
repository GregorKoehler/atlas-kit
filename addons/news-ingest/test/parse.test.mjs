/* ------------------------------------------------------------------ *
 * The feed parser, against fixtures — no network, no filesystem, no clock.
 *
 * This is where every publisher's idea of a feed lands, so it is where the
 * per-item facts get pinned: RSS 2.0 and Atom both parse, CDATA and entities
 * survive, HTML in a description becomes text, and the ID — the whole input to
 * the dedupe key — falls back in the order publishers actually keep stable.
 *
 * Run: node --test addons/news-ingest/test/parse.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFeed, decodeEntities, stripHtml, tagText, atomLink, toIso, itemKey } from '../api/parse.mjs'

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example Feed</title>
    <link>https://example.org/</link>
    <description>A channel description that is not an item.</description>
    <item>
      <title>Second post &amp; friends</title>
      <link>https://example.org/2</link>
      <guid isPermaLink="false">tag:example.org,2026:2</guid>
      <pubDate>Tue, 12 Aug 2026 09:00:00 GMT</pubDate>
      <description><![CDATA[<p>Two <b>bold</b> things happened.</p><p>Then a third.</p>]]></description>
    </item>
    <item>
      <title>Third post</title>
      <link>https://example.org/3</link>
      <pubDate>Wed, 13 Aug 2026 09:00:00 GMT</pubDate>
      <description>Plain text, with an &#8212; em dash.</description>
    </item>
    <item>
      <title>First post</title>
      <link>https://example.org/1</link>
      <pubDate>Mon, 11 Aug 2026 09:00:00 GMT</pubDate>
      <content:encoded><![CDATA[The full body, in content:encoded.]]></content:encoded>
    </item>
  </channel>
</rss>`

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <link rel="self" href="https://example.net/atom.xml"/>
  <entry>
    <title type="text">An Atom entry</title>
    <id>urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a</id>
    <link rel="edit" href="https://example.net/edit/1"/>
    <link rel="alternate" type="text/html" href="https://example.net/posts/1"/>
    <updated>2026-08-14T12:00:00Z</updated>
    <summary>What the entry is about.</summary>
  </entry>
  <entry>
    <title>No link, no id</title>
    <published>2026-08-13T12:00:00Z</published>
    <content type="html">&lt;p&gt;Escaped HTML content.&lt;/p&gt;</content>
  </entry>
</feed>`

test('RSS: the CHANNEL title is the feed title, not the first item’s', () => {
  assert.equal(parseFeed(RSS).title, 'Example Feed')
  assert.equal(parseFeed(ATOM).title, 'Atom Example')
})

test('RSS items parse, and a dated feed comes back newest first', () => {
  const { items } = parseFeed(RSS)
  assert.deepEqual(
    items.map((i) => i.title),
    ['Third post', 'Second post & friends', 'First post'],
    'sorted by pubDate descending, not document order',
  )
  const second = items[1]
  assert.equal(second.link, 'https://example.org/2')
  assert.equal(second.id, 'tag:example.org,2026:2', 'the guid wins over the link')
  assert.equal(second.published, '2026-08-12T09:00:00.000Z')
  assert.equal(second.summary, 'Two bold things happened.\nThen a third.', 'CDATA unwrapped, HTML stripped to text')
  assert.equal(items[0].summary, 'Plain text, with an — em dash.', 'numeric entities decoded')
  assert.equal(items[2].summary, 'The full body, in content:encoded.', 'content:encoded is read when there is no description')
})

test('an item with no guid dedupes on its LINK', () => {
  const third = parseFeed(RSS).items[0]
  assert.equal(third.id, 'https://example.org/3')
})

test('Atom: alternate link wins, id is the guid, escaped HTML becomes text', () => {
  const { items } = parseFeed(ATOM)
  assert.equal(items[0].title, 'An Atom entry')
  assert.equal(items[0].link, 'https://example.net/posts/1', 'rel="alternate", not rel="edit"')
  assert.equal(items[0].id, 'urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a')
  assert.equal(items[0].published, '2026-08-14T12:00:00.000Z')
  assert.equal(items[1].summary, 'Escaped HTML content.')
  assert.match(items[1].id, /^sha1:/, 'no id and no link → a stable hash, so it cannot re-ingest forever')
})

test('an unparseable date is empty, never a made-up one', () => {
  assert.equal(toIso('not a date'), '')
  assert.equal(toIso(''), '')
  assert.equal(toIso('Tue, 12 Aug 2026 09:00:00 GMT'), '2026-08-12T09:00:00.000Z')
})

test('the excerpt cap applies at parse time, and says it was cut', () => {
  const long = `<rss><channel><item><title>t</title><link>https://e/1</link><description>${'x'.repeat(500)}</description></item></channel></rss>`
  const item = parseFeed(long, { excerptChars: 100 }).items[0]
  assert.equal(item.summary.length, 100)
  assert.equal(item.summaryTruncated, true)
  assert.equal(parseFeed(long, { excerptChars: 5000 }).items[0].summaryTruncated, false)
})

test('garbage in is an empty feed out, never a throw', () => {
  for (const junk of ['', '<html><body>502 Bad Gateway</body></html>', '<rss><channel></channel>', null]) {
    const r = parseFeed(junk)
    assert.deepEqual(r.items, [], String(junk).slice(0, 20))
  }
})

test('an undated feed keeps the publisher’s own order', () => {
  const xml = `<rss><channel><item><title>A</title><link>https://e/a</link></item><item><title>B</title><link>https://e/b</link></item></channel></rss>`
  assert.deepEqual(
    parseFeed(xml).items.map((i) => i.title),
    ['A', 'B'],
  )
})

test('a namespaced tag never shadows the real one', () => {
  const block = '<item><media:title>WRONG</media:title><title>RIGHT</title></item>'
  assert.equal(tagText(block, 'title'), 'RIGHT')
  // …but a namespaced-only tag is still found.
  assert.equal(tagText('<item><dc:date>2026-08-01</dc:date></item>', 'date'), '2026-08-01')
})

test('entity and HTML handling is conservative', () => {
  assert.equal(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x2014;'), 'a & b <c> "d" \'e\' —')
  assert.equal(decodeEntities('&notanentity; stays'), '&notanentity; stays', 'unknown entities are text, not a decode failure')
  assert.equal(stripHtml('<script>evil()</script><p>Kept</p>'), 'Kept')
  assert.equal(stripHtml('one<br/>two'), 'one\ntwo')
})

test('atomLink falls back through rel, then to any href', () => {
  assert.equal(atomLink('<link href="https://a/1"/>'), 'https://a/1')
  assert.equal(atomLink('<link rel="self" href="https://a/self"/>'), 'https://a/self')
  assert.equal(atomLink('<entry>no links</entry>'), '')
})

test('the dedupe key is stable, and scoped to the feed', () => {
  const a = itemKey('https://f/1', 'guid-1')
  assert.equal(a, itemKey('https://f/1', 'guid-1'), 'same input → same key, run after run')
  assert.notEqual(a, itemKey('https://f/2', 'guid-1'), 'the same guid in another feed is another item')
  assert.equal(a.length, 16)
})
