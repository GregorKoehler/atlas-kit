/* ------------------------------------------------------------------ *
 * The feed list — a hand-edited JSON file, so this pins the ONE property that
 * matters about a hand-edited file: a bad line loses its own feed and nothing
 * else. Every rejection comes back with a reason a human can act on.
 *
 * Run: node --test addons/news-ingest/test/feeds.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadFeeds, normalizeFeed, tagFromUrl } from '../api/feeds.mjs'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-news-feeds-'))
const write = (name, body) => {
  const p = path.join(dir, name)
  fs.writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body))
  return p
}

test('a shipped-shape file loads, with defaults filled in', () => {
  const file = write('ok.json', {
    feeds: [
      { url: 'https://example.org/feed.xml', tag: 'example', title: 'Example' },
      'https://www.example.net/atom.xml',
    ],
  })
  const { feeds, errors } = loadFeeds(file)
  assert.deepEqual(errors, [])
  assert.deepEqual(feeds[0], { url: 'https://example.org/feed.xml', tag: 'example', title: 'Example' })
  assert.deepEqual(feeds[1], { url: 'https://www.example.net/atom.xml', tag: 'example.net', title: '' }, 'a bare URL is a feed; the tag falls back to the host')
})

test('the SHIPPED example file is valid and neutral', () => {
  const file = fileURLToPath(new URL('../feeds.example.json', import.meta.url))
  const { feeds, errors } = loadFeeds(file)
  assert.deepEqual(errors, [])
  assert.ok(feeds.length >= 1)
  // A public repo ships an example, never anyone's reading list.
  assert.ok(feeds.every((f) => /^https:\/\//.test(f.url)))
})

test('one bad entry is dropped with a reason — the rest still load', () => {
  const file = write('mixed.json', {
    feeds: [
      { url: 'https://good.example/feed' },
      { tag: 'no-url' },
      { url: 'not a url' },
      { url: 'file:///etc/passwd' },
      'https://good.example/feed',
      { url: 'https://second.example/feed', tag: 'Second Feed!!' },
    ],
  })
  const { feeds, errors } = loadFeeds(file)
  assert.deepEqual(
    feeds.map((f) => f.url),
    ['https://good.example/feed', 'https://second.example/feed'],
  )
  assert.equal(errors.length, 4)
  assert.match(errors[0], /feeds\[1\]: missing "url"/)
  assert.match(errors[1], /feeds\[2\]: "not a url" is not a URL/)
  assert.match(errors[2], /only http\(s\) feeds are read, not file:/)
  assert.match(errors[3], /duplicate URL/)
  assert.equal(feeds[1].tag, 'second-feed', 'a tag is reduced to a frontmatter-safe scalar')
})

test('an absent file is the first-run state, not an exception', () => {
  const { feeds, errors, exists } = loadFeeds(path.join(dir, 'nope.json'))
  assert.equal(exists, false)
  assert.deepEqual(feeds, [])
  assert.match(errors[0], /copy feeds.example.json/)
})

test('a broken or empty file says what is wrong with IT', () => {
  assert.match(loadFeeds(write('bad.json', '{not json')).errors[0], /not valid JSON/)
  assert.match(loadFeeds(write('shape.json', { urls: [] })).errors[0], /expected \{"feeds": \[\.\.\.\]\}/)
  assert.match(loadFeeds(write('empty.json', { feeds: [] })).errors[0], /lists no feeds/)
})

test('normalizeFeed and tagFromUrl are total — no input throws', () => {
  assert.match(normalizeFeed(null, 0).error, /not a URL or an object/)
  assert.match(normalizeFeed(42, 3).error, /not a URL or an object/)
  assert.equal(tagFromUrl('https://www.Example.ORG/x'), 'example.org')
  assert.equal(tagFromUrl('nonsense'), 'feed')
})

test.after(() => fs.rmSync(dir, { recursive: true, force: true }))
