/* ------------------------------------------------------------------ *
 * The whole pipeline end to end, and the routes on top of it — against a REAL
 * throwaway vault (a bare "origin" + a clone, so the commit queue really pulls,
 * commits and pushes) and STUB `yt-dlp` / `claude` binaries on $PATH.
 *
 * Hermetic by construction: no network, no Instagram, no model, no cookies. The
 * stubs are the same cheap seam upstream uses for this class of pipeline — a
 * fake downloader on $PATH — and they let the failure paths be tested at all,
 * which is most of what there is to get wrong here.
 *
 * What this pins:
 *   · a successful ingest COMMITS the page AND its assets, and the source URL,
 *     the verbatim caption and the analysis are all on the page;
 *   · the model is handed VAULT-RELATIVE IMAGE PATHS that actually resolve —
 *     the one thing a unit test of the prompt cannot prove;
 *   · Instagram refusing (the login wall) is a LOUD 502 with an actionable hint,
 *     leaves NO page and NO assets behind, and is written to the ingest log;
 *   · a fetch that returns no stills still writes the caption page — degraded,
 *     never dropped — and does not delete a previous run's images;
 *   · the write route is BEARER-GATED (an addon router gets no core auth), and a
 *     non-post URL is refused before anything is spawned.
 *
 * Run: node --test addons/instagram-ingest/test/ingest.test.mjs
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

const CODE = 'AbCdE12345'
const POST_URL = `https://www.instagram.com/p/${CODE}/`
const CAPTION = 'Rye, 20% starter — "no knead".\n\n#bread #rye'

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV }).trim()

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-ig-e2e-'))
const remote = path.join(root, 'remote.git')
const vault = path.join(root, 'vault')
git(root, 'init', '--bare', '-q', '-b', 'main', remote)
git(root, 'clone', '-q', remote, vault)
git(vault, 'config', 'user.email', 'test@example.com')
git(vault, 'config', 'user.name', 'Test')
fs.mkdirSync(path.join(vault, 'Wiki'), { recursive: true })
fs.writeFileSync(path.join(vault, 'Wiki', 'Legend.md'), '# Legend\n')
git(vault, 'add', '.')
git(vault, 'commit', '-q', '-m', 'init')
git(vault, 'push', '-q', 'origin', 'main')

/* --- the stubs ------------------------------------------------------------ *
 * Both read their mode from the environment at RUN time, so one pair of scripts
 * covers every case below. */
const bin = path.join(root, 'bin')
fs.mkdirSync(bin)
const infoJson = path.join(root, 'info.ndjson')
fs.writeFileSync(
  infoJson,
  [
    JSON.stringify({ _type: 'playlist', id: CODE, title: 'ignored when a description exists' }),
    JSON.stringify({ id: `${CODE}-1`, description: CAPTION, uploader: '@someone', upload_date: '20260801', thumbnail: 'https://cdn.example/1.jpg' }),
  ].join('\n') + '\n',
)
const promptDump = path.join(root, 'prompt.txt')

fs.writeFileSync(
  path.join(bin, 'yt-dlp'),
  `#!/bin/sh
mode="\${IG_STUB_MODE:-ok}"
case "$*" in
  *--dump-json*)
    if [ "$mode" = "wall" ]; then
      echo "ERROR: Requested content is not available, rate-limit reached or login required" >&2
      exit 1
    fi
    cat "${infoJson}"
    exit 0
    ;;
esac
dir=""; prev=""
for a in "$@"; do
  [ "$prev" = "-P" ] && dir="$a"
  prev="$a"
done
if [ "$mode" = "nomedia" ]; then
  echo "ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests" >&2
  exit 1
fi
mkdir -p "$dir"
printf 'fake-jpeg-1' > "$dir/001-${CODE}.jpg"
[ "$mode" = "one" ] || printf 'fake-jpeg-2' > "$dir/002-${CODE}.jpg"
exit 0
`,
  { mode: 0o755 },
)

fs.writeFileSync(
  path.join(bin, 'claude'),
  `#!/bin/sh
cat > "${promptDump}"
pwd > "${promptDump}.cwd"
if [ "\${IG_CLAUDE_MODE:-ok}" = "fail" ]; then
  echo "Invalid API key · Please run /login" >&2
  exit 1
fi
printf 'TITLE: A 20%% rye sourdough\\nTAGS: baking, sourdough\\n\\nThe reel walks through a rye bake with a 20%% starter.\\n'
`,
  { mode: 0o755 },
)

process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`
// Pin the stub as THE binary, not merely the first `claude` on PATH: the API
// resolves an absolute path once (api/src/claude-bin.mjs) and CLAUDE_BIN is its
// authoritative input, so an operator's own CLAUDE_BIN can't reach this test.
process.env.CLAUDE_BIN = path.join(bin, 'claude')
process.env.ATLAS_IG_YTDLP = path.join(bin, 'yt-dlp')
process.env.VAULT_PATH = vault
process.env.VAULT_DIR = vault
process.env.VAULTS_FILE = path.join(root, 'no-vaults.json') // absent → single-vault fallback
process.env.ATLAS_BRANCH = 'main'
process.env.AGENT_LOCAL_DIR = path.join(root, 'state')
process.env.ATLAS_IG_RECORDS_FILE = path.join(root, 'state', 'ingests.json')
process.env.DASHBOARD_BEARER_TOKEN = 'test-token'
process.env.ATLAS_IG_COOKIES_FILE = ''
process.env.ATLAS_IG_COOKIES_BROWSER = ''

const { ingestInstagram } = await import('../api/ingest.mjs')
const { listRecords } = await import('../api/records.mjs')
const registerAddon = (await import('../api/register.mjs')).default

const pageRel = `Wiki/Sources/instagram-${CODE}.md`
const assetsRel = `Wiki/assets/instagram/${CODE}`
const readPage = () => fs.readFileSync(path.join(vault, pageRel), 'utf-8')
const tracked = (p) => git(vault, 'ls-files', '--', p).split('\n').filter(Boolean)

/* --- 1. the happy path ---------------------------------------------------- */

test('a post is fetched, analyzed, written and COMMITTED — page + assets', async () => {
  const r = await ingestInstagram({ url: `${POST_URL}?igsh=tracking`, requestedBy: 'test' })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.status, 200)
  assert.equal(r.page, pageRel)
  assert.equal(r.images, 2)
  assert.equal(r.analysis, true)

  const md = readPage()
  assert.match(md, /^---\ntype: source\nsource: instagram\nurl: "https:\/\/www\.instagram\.com\/p\/AbCdE12345\/"/, 'the canonical URL, tracking params dropped')
  assert.match(md, /# A 20% rye sourdough/)
  assert.match(md, /> Rye, 20% starter — "no knead"\./, 'the caption is verbatim')
  assert.match(md, /> #bread #rye/)
  assert.match(md, /- Posted by @someone on 2026-08-01/)
  assert.match(md, /\.\.\/assets\/instagram\/AbCdE12345\/1\.jpg/)

  // Committed, not merely written — and pushed to the "remote".
  assert.deepEqual(tracked(pageRel), [pageRel])
  assert.deepEqual(tracked(assetsRel), [`${assetsRel}/1.jpg`, `${assetsRel}/2.jpg`])
  assert.equal(git(vault, 'status', '--porcelain'), '', 'the vault is left clean')
  assert.match(git(remote, 'log', '-1', '--pretty=%s'), /sources: instagram AbCdE12345/)

  const rec = listRecords()[0]
  assert.equal(rec.ok, true)
  assert.equal(rec.page, pageRel)
  assert.equal(rec.images, 2)
})

test('the model got vault-relative image paths that actually resolve, plus the caption', () => {
  const prompt = fs.readFileSync(promptDump, 'utf-8')
  assert.equal(fs.readFileSync(`${promptDump}.cwd`, 'utf-8').trim(), fs.realpathSync(vault), 'cwd is the vault, so the paths resolve')
  for (const n of ['1.jpg', '2.jpg']) {
    const rel = `${assetsRel}/${n}`
    assert.ok(prompt.includes(`- ${rel}`), `prompt names ${rel}`)
    assert.ok(fs.existsSync(path.join(vault, rel)), `${rel} exists where the model was told to look`)
  }
  assert.ok(prompt.includes(CAPTION), 'the caption is steered on, not dropped')
})

/* --- 2. Instagram says no ------------------------------------------------- */

test('the login wall is a loud 502 with a hint, and leaves the vault untouched', async () => {
  process.env.IG_STUB_MODE = 'wall'
  const other = 'https://www.instagram.com/reel/ZzYyXx9876/'
  const r = await ingestInstagram({ url: other, requestedBy: 'test' })
  delete process.env.IG_STUB_MODE

  assert.equal(r.ok, false)
  assert.equal(r.status, 502)
  assert.match(r.error, /login required/)
  assert.match(r.error, /Configure your own cookies/, 'no cookies configured → the actionable hint says so')
  assert.ok(!fs.existsSync(path.join(vault, 'Wiki/Sources/instagram-ZzYyXx9876.md')))
  assert.ok(!fs.existsSync(path.join(vault, 'Wiki/assets/instagram/ZzYyXx9876')))
  assert.equal(git(vault, 'status', '--porcelain'), '')

  const rec = listRecords()[0]
  assert.equal(rec.ok, false, 'the failure is in the ingest log, not only in the HTTP answer')
  assert.match(rec.error, /login required/)
})

/* --- 3. degraded, never dropped ------------------------------------------- */

test('no stills and no analysis still writes the caption page, and says what is missing', async () => {
  process.env.IG_STUB_MODE = 'nomedia'
  process.env.IG_CLAUDE_MODE = 'fail'
  const r = await ingestInstagram({ url: POST_URL, requestedBy: 'test' })
  delete process.env.IG_STUB_MODE
  delete process.env.IG_CLAUDE_MODE

  assert.equal(r.ok, true, r.error)
  assert.equal(r.images, 0)
  assert.equal(r.analysis, false)
  assert.ok(
    r.warnings.some((w) => /no images fetched/.test(w)),
    'the fetch failure is stated',
  )
  assert.ok(
    r.warnings.some((w) => /no analysis/.test(w)),
    'the model failure is stated',
  )

  const md = readPage()
  assert.match(md, /> Rye, 20% starter/, 'the caption is still there — that is the point')
  assert.match(md, /No analysis was written/)
  assert.match(md, /\[!warning\] Incomplete ingest/)
  // A run that fetched nothing must NOT delete the previous run's committed images.
  assert.deepEqual(tracked(assetsRel), [`${assetsRel}/1.jpg`, `${assetsRel}/2.jpg`])
  assert.equal(git(vault, 'status', '--porcelain'), '', 'no tracked deletion is left staged-less')
})

test('a re-ingest with fewer slides drops the orphan, in the same commit', async () => {
  process.env.IG_STUB_MODE = 'one'
  const r = await ingestInstagram({ url: POST_URL, requestedBy: 'test' })
  delete process.env.IG_STUB_MODE

  assert.equal(r.ok, true, r.error)
  assert.equal(r.images, 1)
  assert.deepEqual(tracked(assetsRel), [`${assetsRel}/1.jpg`], '2.jpg is gone, not orphaned')
  assert.equal(git(vault, 'status', '--porcelain'), '')
  assert.equal(listRecords().filter((x) => x.page === pageRel).length, 3, 'one page, one slug — re-ingests update it')
})

/* --- 4. the routes -------------------------------------------------------- */

async function serve() {
  const app = express()
  app.use(registerAddon().routes)
  const server = await new Promise((res) => {
    const s = app.listen(0, '127.0.0.1', () => res(s))
  })
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    post: async (body, token) => {
      const r = await fetch(`${base}/api/ingest/instagram`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      })
      return { status: r.status, body: await r.json() }
    },
    get: async (p) => {
      const r = await fetch(base + p)
      return { status: r.status, body: await r.json() }
    },
    close: () => new Promise((res) => server.close(res)),
  }
}

test('the write route gates itself on the bearer — an addon router gets no core auth', async () => {
  const app = await serve()
  assert.equal((await app.post({ url: POST_URL })).status, 401)
  assert.equal((await app.post({ url: POST_URL }, 'wrong-token')).status, 401)
  assert.equal((await app.post({ url: POST_URL }, 'test-tokenXXX')).status, 401, 'a length mismatch is still just unauthorized')
  await app.close()
})

test('a non-post URL is refused with 400 before anything is spawned', async () => {
  const app = await serve()
  const before = listRecords().length
  for (const url of ['https://www.instagram.com/someone/', 'https://example.com/p/AbCdE12345/', '', undefined]) {
    const r = await app.post({ url }, 'test-token')
    assert.equal(r.status, 400, String(url))
    assert.match(r.body.error, /not a single Instagram post URL/)
  }
  assert.equal(listRecords().length, before, 'a refused URL is not an ingest and is not logged as one')
  await app.close()
})

test('the ingest log is readable, newest first, and bounded by ?limit', async () => {
  const app = await serve()
  const all = await app.get('/api/ingest/instagram/records')
  assert.ok(all.body.records.length >= 4)
  const one = await app.get('/api/ingest/instagram/records?limit=1')
  assert.equal(one.body.records.length, 1)
  assert.equal(one.body.records[0].at, all.body.records[0].at)
  await app.close()
})

test('the manifest declares only what it uses — no leg, no cron, no scorecard', () => {
  const m = registerAddon()
  assert.deepEqual(Object.keys(m).sort(), ['description', 'routes', 'status'])
  const s = m.status()
  assert.equal(s.ytdlp, path.join(bin, 'yt-dlp'))
  assert.match(s.cookies, /none configured/)
  assert.equal(s.ingests.count, listRecords(500).length)
})

test.after(() => fs.rmSync(root, { recursive: true, force: true }))
