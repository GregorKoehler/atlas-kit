/* ------------------------------------------------------------------ *
 * The whole sweep end to end, and the routes on top of it — against a REAL
 * throwaway vault (a bare "origin" + a clone, so the commit queue really pulls,
 * commits and pushes), with the two outside worlds injected: `fetchImpl` serves
 * fixture feeds and `summarizeImpl` stands in for `claude -p`.
 *
 * Hermetic by construction: NO NETWORK and NO MODEL. Everything else — the vault,
 * git, the commit queue, the state file — is the real thing, because the bugs
 * worth catching here live in exactly those seams.
 *
 * What this pins:
 *   · a sweep commits one page per new item PLUS the digest, in ONE commit;
 *   · A FEED THAT FAILS DOES NOT KILL THE RUN — its error is recorded and the
 *     other feeds still land;
 *   · items already ingested are NOT re-summarized (the dedupe is the cost
 *     control), while a genuinely new item is picked up;
 *   · the caps bound a run, round-robin across feeds, and what they held back is
 *     REPORTED as deferred rather than silently dropped;
 *   · a failed summary still files the item, saying so on the page;
 *   · A FAILED COMMIT MARKS NOTHING AS SEEN, so the items are retried;
 *   · GET /api/news reads, POST /api/news/sweep is bearer-gated.
 *
 * Run: node --test addons/news-ingest/test/sweep.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

// Same resolution the addon itself uses — express lives in core's node_modules.
const express = createRequire(new URL('../../../api/src/', import.meta.url))('express')

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV }).trim()

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-news-e2e-'))
const remote = path.join(root, 'remote.git')
const vault = path.join(root, 'vault')
const brokenVault = path.join(root, 'not-a-repo')
git(root, 'init', '--bare', '-q', '-b', 'main', remote)
git(root, 'clone', '-q', remote, vault)
git(vault, 'config', 'user.email', 'test@example.com')
git(vault, 'config', 'user.name', 'Test')
fs.mkdirSync(path.join(vault, 'Wiki'), { recursive: true })
fs.writeFileSync(path.join(vault, 'Wiki', 'Legend.md'), '# Legend\n')
git(vault, 'add', '.')
git(vault, 'commit', '-q', '-m', 'init')
git(vault, 'push', '-q', 'origin', 'main')
fs.mkdirSync(brokenVault)

/* --- the fixtures --------------------------------------------------------- */

const ALPHA = 'https://alpha.test/feed.xml'
const BETA = 'https://beta.test/atom.xml'
const DOWN = 'https://down.test/feed.xml'

const rssItem = (n) => `
    <item>
      <title>Alpha ${n}</title>
      <link>https://alpha.test/${n}</link>
      <guid>alpha-${n}</guid>
      <pubDate>Fri, 0${n} Aug 2026 09:00:00 GMT</pubDate>
      <description><![CDATA[<p>Alpha item ${n} body.</p>]]></description>
    </item>`
const rss = (ns) => `<rss version="2.0"><channel><title>Alpha Feed</title>${ns.map(rssItem).join('')}</channel></rss>`
const atom = (ns) => `<feed xmlns="http://www.w3.org/2005/Atom"><title>Beta Feed</title>${ns
  .map(
    (n) => `<entry><title>Beta ${n}</title><id>beta-${n}</id><link rel="alternate" href="https://beta.test/${n}"/><updated>2026-08-0${n}T09:00:00Z</updated><summary>Beta entry ${n} body.</summary></entry>`,
  )
  .join('')}</feed>`

// Mutable, so a later test can publish a new item into a feed.
const bodies = new Map([
  [ALPHA, rss([1, 2, 3])],
  [BETA, atom([1, 2])],
])

const fetchImpl = async (url) => {
  if (url === DOWN) return new Response('<html>502 Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' })
  const body = bodies.get(url)
  if (!body) return new Response('not found', { status: 404 })
  return new Response(body, { status: 200, headers: { 'content-type': 'application/xml' } })
}

let summaryMode = 'ok'
const summarizeImpl = async ({ item }) =>
  summaryMode === 'fail'
    ? { ok: false, error: 'claude -p exited 1: Invalid API key · Please run /login' }
    : { ok: true, tags: ['stub'], body: `A stub summary of "${item.title}", long enough to pass validation.` }

/* --- the environment ------------------------------------------------------ */

const feedsFile = path.join(root, 'feeds.json')
fs.writeFileSync(
  feedsFile,
  JSON.stringify({
    feeds: [
      { url: ALPHA, tag: 'alpha' },
      { url: BETA, tag: 'beta', title: 'Beta Feed' },
      { url: DOWN, tag: 'down' },
    ],
  }),
)
const vaultsFile = path.join(root, 'vaults.json')
fs.writeFileSync(
  vaultsFile,
  JSON.stringify({
    atlas: { path: vault, label: 'Atlas', default: true },
    broken: { path: brokenVault, label: 'Broken' },
  }),
)

process.env.VAULTS_FILE = vaultsFile
process.env.VAULT_PATH = vault
process.env.VAULT_DIR = vault
process.env.ATLAS_BRANCH = 'main'
process.env.AGENT_LOCAL_DIR = path.join(root, 'state')
process.env.ATLAS_NEWS_FEEDS_FILE = feedsFile
process.env.ATLAS_NEWS_STATE_FILE = path.join(root, 'state', 'news-ingest.json')
process.env.DASHBOARD_BEARER_TOKEN = 'test-token'

const { sweepNews } = await import('../api/sweep.mjs')
const { readState } = await import('../api/state.mjs')
const registerAddon = (await import('../api/register.mjs')).default

const sweep = (extra = {}) => sweepNews({ requestedBy: 'test', fetchImpl, summarizeImpl, ...extra })
const tracked = (p) => git(vault, 'ls-files', '--', p).split('\n').filter(Boolean)
const readVault = (rel) => fs.readFileSync(path.join(vault, rel), 'utf-8')
const commits = () => Number(git(vault, 'rev-list', '--count', 'HEAD'))

/* --- 1. the happy path ---------------------------------------------------- */

test('a sweep files every new item and the digest in ONE commit, and the dead feed is only an error', async () => {
  const before = commits()
  const r = await sweep()

  assert.equal(r.ok, true, r.error)
  assert.equal(r.feeds, 3)
  assert.equal(r.checked, 5, 'three alpha items + two beta entries; the dead feed contributed none')
  assert.equal(r.new, 5)
  assert.equal(r.written, 5)
  assert.equal(commits(), before + 1, 'ONE commit for the whole run, not one per item')

  // The dead feed is recorded with its reason, and cost nothing else.
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /^down: HTTP 502/)

  const pages = tracked('Wiki/Sources')
  assert.equal(pages.length, 5)
  const alpha3 = pages.find((p) => p.includes('news-alpha-3-'))
  const md = readVault(alpha3)
  assert.match(md, /^---\ntype: source\nsource: news\nfeed: alpha\n/)
  assert.match(md, /url: "https:\/\/alpha\.test\/3"/)
  assert.match(md, /# Alpha 3/)
  assert.match(md, /A stub summary of "Alpha 3"/)
  assert.match(md, /## From the feed\n\n> Alpha item 3 body\./, 'the feed’s own text, verbatim')
  assert.match(md, /- Alpha Feed — `https:\/\/alpha\.test\/feed\.xml`/, 'the feed’s own <title> filled the missing config title')

  const digest = readVault('Wiki/News-Digest.md')
  assert.match(digest, /# News digest/)
  assert.match(digest, /## Alpha Feed/)
  assert.match(digest, /## Beta Feed/)
  assert.match(digest, /\[\[news-beta-2-[0-9a-f]{8}\|Beta 2\]\]/)
  assert.match(digest, /- `down` —/, 'the feed that failed is still listed — a broken feed must not vanish from the page that says what is followed')

  assert.equal(git(vault, 'status', '--porcelain'), '', 'the vault is left clean')
  assert.match(git(remote, 'log', '-1', '--pretty=%s'), /^news: 5 item\(s\) from 2 feed\(s\)$/, 'pushed, not just committed')
  assert.equal(Object.keys(readState().seen).length, 5, 'marked seen only now that the commit landed')
})

/* --- 2. dedupe — the whole point of the state file ------------------------- */

test('a second sweep over unchanged feeds summarizes nothing and commits nothing', async () => {
  const before = commits()
  let called = 0
  const r = await sweep({ summarizeImpl: async (a) => (called++, summarizeImpl(a)) })

  assert.equal(r.ok, true)
  assert.equal(r.new, 0)
  assert.equal(r.written, 0)
  assert.equal(called, 0, 'not one model call for items already filed — this is the cost control')
  assert.equal(commits(), before, 'no commit, so no empty churn on the vault')
})

test('a newly published item is the only thing picked up', async () => {
  bodies.set(ALPHA, rss([1, 2, 3, 4]))
  const r = await sweep()
  assert.equal(r.new, 1)
  assert.equal(r.items[0].title, 'Alpha 4')
  assert.ok(tracked('Wiki/Sources').some((p) => p.includes('news-alpha-4-')))
  assert.match(readVault('Wiki/News-Digest.md'), /\[\[news-alpha-4-[0-9a-f]{8}\|Alpha 4\]\]/, 'the digest is rewritten with it')
  assert.equal(Object.keys(readState().seen).length, 6)
})

/* --- 3. the caps ---------------------------------------------------------- */

test('the caps bound a run round-robin across feeds, and what they held back is REPORTED', async () => {
  fs.rmSync(process.env.ATLAS_NEWS_STATE_FILE) // a fresh box facing a backlog
  process.env.ATLAS_NEWS_MAX_ITEMS = '3'
  process.env.ATLAS_NEWS_MAX_PER_FEED = '2'
  const r = await sweep()
  delete process.env.ATLAS_NEWS_MAX_ITEMS
  delete process.env.ATLAS_NEWS_MAX_PER_FEED

  assert.equal(r.new, 3, 'the per-run cap, not the feeds, decides how much a sweep costs')
  assert.equal(r.deferred, 3, '6 unseen items, 3 taken → 3 deferred to the next sweep, counted before the per-feed cap because they are still unseen')
  const feeds = r.items.map((i) => i.feed)
  assert.ok(feeds.includes('alpha') && feeds.includes('beta'), 'round-robin: one busy feed cannot eat the whole run')
})

test('a feed that repeats an entry buys ONE model call, not two', async () => {
  const dupFeeds = path.join(root, 'feeds-dup.json')
  const DUP = 'https://dup.test/feed.xml'
  fs.writeFileSync(dupFeeds, JSON.stringify({ feeds: [{ url: DUP, tag: 'dup' }] }))
  bodies.set(DUP, `<rss version="2.0"><channel><title>Dup Feed</title>${rssItem(1)}${rssItem(1)}</channel></rss>`)
  fs.rmSync(process.env.ATLAS_NEWS_STATE_FILE)
  process.env.ATLAS_NEWS_FEEDS_FILE = dupFeeds

  let calls = 0
  const r = await sweep({ summarizeImpl: async (a) => (calls++, summarizeImpl(a)) })
  process.env.ATLAS_NEWS_FEEDS_FILE = feedsFile

  assert.equal(r.checked, 2, 'the feed really did serve the entry twice')
  assert.equal(r.new, 1)
  assert.equal(calls, 1)
})

/* --- 4. degraded, never dropped ------------------------------------------- */

test('an item whose summary fails is still filed, and the page says so', async () => {
  fs.rmSync(process.env.ATLAS_NEWS_STATE_FILE)
  bodies.set(BETA, atom([1, 2, 3]))
  summaryMode = 'fail'
  const r = await sweep()
  summaryMode = 'ok'

  assert.equal(r.ok, true, 'a model failure is not a run failure')
  assert.equal(r.written, 7)
  assert.equal(r.errors.filter((e) => /no summary for/.test(e)).length, 7)
  const page = readVault(tracked('Wiki/Sources').find((p) => p.includes('news-beta-3-')))
  assert.match(page, /No summary was written for this item — claude -p exited 1/)
  assert.match(page, /> Beta entry 3 body\./, 'the feed’s own text is the half that must never be lost')
})

/* --- 5. when the vault says no -------------------------------------------- */

test('a failed commit marks NOTHING as seen — the items are retried, not lost', async () => {
  const seenBefore = Object.keys(readState().seen).length
  process.env.ATLAS_NEWS_VAULT = 'broken' // exists, but is not a git repo
  bodies.set(ALPHA, rss([1, 2, 3, 4, 5]))
  const r = await sweep()
  delete process.env.ATLAS_NEWS_VAULT

  assert.equal(r.ok, false)
  assert.match(r.error, /retried next sweep/)
  assert.equal(Object.keys(readState().seen).length, seenBefore, 'not one item was marked seen')
  const last = readState().runs.at(-1)
  assert.equal(last.ok, false, 'the failure is in the run log, not only in the return value')
  assert.equal(last.written, 0)
})

test('no feed list at all is a loud, fatal refusal — there is nothing a run could do', async () => {
  process.env.ATLAS_NEWS_FEEDS_FILE = path.join(root, 'absent.json')
  const r = await sweep()
  process.env.ATLAS_NEWS_FEEDS_FILE = feedsFile
  assert.equal(r.ok, false)
  assert.match(r.error, /no usable feeds/)
  assert.match(r.errors[0], /copy feeds.example.json/)
})

/* --- 6. the routes and the manifest --------------------------------------- */

async function serve() {
  const app = express()
  app.use(registerAddon().routes)
  const server = await new Promise((res) => {
    const s = app.listen(0, '127.0.0.1', () => res(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    get: async (p) => {
      const r = await fetch(base + p)
      return { status: r.status, body: await r.json() }
    },
    post: async (p, token) => {
      const r = await fetch(base + p, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} })
      return { status: r.status, body: await r.json() }
    },
    close: () => new Promise((res) => server.close(res)),
  }
}

test('GET /api/news serves what was ingested, its feeds and the last run', async () => {
  const app = await serve()
  const { status, body } = await app.get('/api/news')
  assert.equal(status, 200)
  assert.equal(body.items.length, Object.keys(readState().seen).length)
  assert.ok(body.items[0].page.startsWith('Wiki/Sources/news-'))
  assert.deepEqual(body.feeds.map((f) => f.tag), ['alpha', 'beta', 'down'])
  assert.equal(body.digest, 'Wiki/News-Digest.md')
  assert.equal(body.lastRun.ok, false, 'the last run failed — a card that hid that would be lying')
  assert.ok(body.errors.length >= 1)

  const one = await app.get('/api/news?limit=1')
  assert.equal(one.body.items.length, 1)
  await app.close()
})

test('POST /api/news/sweep gates itself on the bearer — an addon router gets no core auth', async () => {
  const app = await serve()
  assert.equal((await app.post('/api/news/sweep')).status, 401)
  assert.equal((await app.post('/api/news/sweep', 'wrong-token')).status, 401)
  assert.equal((await app.post('/api/news/sweep', 'test-tokenXXX')).status, 401, 'a length mismatch is still just unauthorized')
  await app.close()
})

test('the manifest declares only what it uses — no search leg, no evidence leg, no scorecard', () => {
  const m = registerAddon()
  assert.deepEqual(Object.keys(m).sort(), ['cron', 'description', 'routes', 'status'])
  assert.equal(m.cron.length, 1)
  assert.match(m.cron[0].schedule, /^\d+ \* \* \* \*$/)
  assert.match(m.cron[0].command, /^bash addons\/news-ingest\/sweep\.sh/)

  const s = m.status()
  assert.equal(s.feeds, 3)
  assert.deepEqual(s.feedErrors, [])
  assert.equal(s.digest, 'Wiki/News-Digest.md')
  assert.equal(s.ingested, Object.keys(readState().seen).length)
})

test.after(() => fs.rmSync(root, { recursive: true, force: true }))
