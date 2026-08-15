/* ------------------------------------------------------------------ *
 * URL admission, cookie resolution, argv and the NDJSON parse — the pure half
 * of the yt-dlp seam (api/ytdlp.mjs). No network, no yt-dlp.
 *
 * What this pins, and why each one is a real failure:
 *   · WHAT IS INGESTIBLE IS THE ABUSE BOUNDARY. A profile/hashtag/story URL must
 *     be REFUSED, not "tried anyway" — admitting one is how a one-post filer
 *     becomes a crawler;
 *   · a CONFIGURED-BUT-MISSING cookie file must THROW, never silently fall back
 *     to cookie-less: the fallback turns one clear error into every post failing
 *     at the login wall with the wrong explanation;
 *   · `--ignore-no-formats-error` must be on the metadata call — without it a
 *     PHOTO post fails outright instead of describing itself;
 *   · THE CAPTION IS NEVER DROPPED: `description`, else `title`, across every
 *     NDJSON object including the playlist wrapper a carousel emits.
 *
 * Run: node --test addons/instagram-ingest/test/ytdlp.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parsePostUrl, cookieArgs, metaArgs, mediaArgs, classifyFailure, parseInfo, collectImages, detailOf } from '../api/ytdlp.mjs'

/* --- admission ------------------------------------------------------------ */

test('a single post/reel/tv permalink is admitted and canonicalised', () => {
  const cases = [
    ['https://www.instagram.com/p/CxYz-123_a/', 'p', 'CxYz-123_a'],
    ['https://instagram.com/reel/AbCdE12345', 'reel', 'AbCdE12345'],
    ['https://www.instagram.com/reels/AbCdE12345/', 'reel', 'AbCdE12345'], // /reels/ → /reel/
    ['https://www.instagram.com/tv/AbCdE12345/', 'tv', 'AbCdE12345'],
    ['https://www.instagram.com/someone.else/p/AbCdE12345/?igsh=trackingjunk', 'p', 'AbCdE12345'],
  ]
  for (const [input, kind, code] of cases) {
    const got = parsePostUrl(input)
    assert.deepEqual(got, { kind, code, url: `https://www.instagram.com/${kind}/${code}/` }, input)
  }
})

test('anything that is not ONE post is refused — the no-crawl boundary', () => {
  const refused = [
    'https://www.instagram.com/someone.else/', // a profile
    'https://www.instagram.com/explore/tags/bread/', // a hashtag
    'https://www.instagram.com/stories/someone/123/', // a story
    'https://www.instagram.com/p/', // no code
    'https://instagram.com.evil.example/p/AbCdE12345/', // lookalike host
    'https://www.facebook.com/p/AbCdE12345/',
    'file:///etc/passwd',
    'not a url',
    '',
    null,
  ]
  for (const u of refused) assert.equal(parsePostUrl(u), null, String(u))
})

/* --- cookies -------------------------------------------------------------- */

test('a configured cookie file that does not exist THROWS, it does not degrade', () => {
  assert.throws(() => cookieArgs({ file: '/no/such/cookies.txt' }), /does not exist/)
})

test('cookie modes: file wins over browser, and says so', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-cookies-'))
  const file = path.join(tmp, 'cookies.txt')
  fs.writeFileSync(file, '# Netscape HTTP Cookie File\n')

  const f = cookieArgs({ file, browser: '' })
  assert.deepEqual(f.args, ['--cookies', file])
  assert.equal(f.mode, 'file')
  assert.equal(f.warning, '')

  const both = cookieArgs({ file, browser: 'firefox' })
  assert.equal(both.mode, 'file')
  assert.match(both.warning, /file wins/)

  const b = cookieArgs({ file: '', browser: 'chrome:Default' })
  assert.deepEqual(b.args, ['--cookies-from-browser', 'chrome:Default'])
  assert.equal(b.mode, 'browser')

  const none = cookieArgs({ file: '', browser: '' })
  assert.deepEqual(none.args, [])
  assert.equal(none.mode, 'none')
  assert.match(none.warning, /login wall/)

  assert.throws(() => cookieArgs({ file: '', browser: 'not a browser spec' }), /browser spec/)
  fs.rmSync(tmp, { recursive: true, force: true })
})

/* --- argv ----------------------------------------------------------------- */

test('the metadata call carries --ignore-no-formats-error, so a PHOTO post still answers', () => {
  const args = metaArgs('https://www.instagram.com/p/X/', ['--cookies', '/c.txt'])
  assert.ok(args.includes('--dump-json'))
  assert.ok(args.includes('--ignore-no-formats-error'))
  assert.deepEqual(args.slice(-3), ['--cookies', '/c.txt', 'https://www.instagram.com/p/X/'])
})

test('the media call fetches STILLS ONLY — never the video', () => {
  const args = mediaArgs('https://www.instagram.com/reel/X/', '/tmp/out', [])
  assert.ok(args.includes('--skip-download'), 'no video is ever downloaded')
  assert.ok(args.includes('--write-thumbnail'))
  assert.deepEqual(args.slice(args.indexOf('-P'), args.indexOf('-P') + 2), ['-P', '/tmp/out'])
  assert.ok(!args.includes('--dump-json'), '--dump-json implies --simulate and would write no files')
})

/* --- failure classification ----------------------------------------------- */

test('the login wall is ONE bucket, and the hint differs by what the operator can do', () => {
  const wall = 'ERROR: Requested content is not available, rate-limit reached or login required'
  assert.match(classifyFailure(wall, 'none'), /Configure your own cookies/)
  assert.match(classifyFailure(wall, 'file'), /expired/)
  // Private / geo / deleted are indistinguishable from out here, and the hint says so
  // rather than picking one confidently.
  assert.match(classifyFailure('ERROR: This account is private', 'browser'), /private, deleted, or blocked/)
  assert.equal(classifyFailure('ERROR: ffmpeg exited with code 1', 'file'), '', 'an unrelated failure gets no invented hint')
  assert.equal(classifyFailure('', 'none'), '')
})

test('the detail a human reads merges BOTH streams — yt-dlp prints failures to stdout too', () => {
  assert.equal(detailOf({ stdout: 'out  line', stderr: 'ERROR: nope\n' }), 'ERROR: nope | out line')
  assert.equal(detailOf({ stdout: '', stderr: '' }), '')
})

/* --- the NDJSON parse ----------------------------------------------------- */

const entry = (o) => JSON.stringify(o)

test('the caption survives: description first, title as the fallback', () => {
  const withDesc = parseInfo(entry({ id: 'a', description: 'Rye, 20% starter.\nBaked 45 min.', title: 'Video by someone' }))
  assert.equal(withDesc.caption, 'Rye, 20% starter.\nBaked 45 min.')

  const titleOnly = parseInfo(entry({ id: 'a', description: '', title: 'The whole point of the post' }))
  assert.equal(titleOnly.caption, 'The whole point of the post')

  const none = parseInfo(entry({ id: 'a' }))
  assert.equal(none.caption, '')
})

test('a carousel: the caption is taken across ALL objects, including the playlist wrapper', () => {
  const out = [
    entry({ _type: 'playlist', id: 'ABC', title: 'the shared caption', uploader: '@someone' }),
    entry({ id: 'ABC-1', description: '', thumbnail: 'https://cdn.example/1.jpg' }),
    entry({ id: 'ABC-2', description: '', thumbnail: 'https://cdn.example/2.jpg' }),
  ].join('\n')
  const info = parseInfo(out)
  assert.equal(info.caption, 'the shared caption')
  assert.equal(info.entries, 2, 'the playlist wrapper is not an entry')
  assert.equal(info.uploader, 'someone', 'the @ is stripped for the page')
  assert.equal(info.hasVideo, false)
})

test('a video post is distinguishable from a photo post by its formats', () => {
  assert.equal(parseInfo(entry({ id: 'a', formats: [{ format_id: '1' }] })).hasVideo, true)
  assert.equal(parseInfo(entry({ id: 'a', formats: [] })).hasVideo, false)
})

test('garbage lines are skipped, and no output at all is null (not an empty post)', () => {
  const info = parseInfo(`WARNING: something\n${entry({ id: 'a', description: 'kept', upload_date: '20260801' })}\n{oops`)
  assert.equal(info.caption, 'kept')
  assert.equal(info.uploadDate, '20260801')
  assert.equal(parseInfo(''), null)
  assert.equal(parseInfo('WARNING: only noise'), null)
})

/* --- what landed on disk -------------------------------------------------- */

test('only image files are collected, in yt-dlp autonumber order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-media-'))
  for (const n of ['002-x.jpg', '001-x.webp', '001-x.mp4', '003-x.png', 'x.info.json']) fs.writeFileSync(path.join(dir, n), 'x')
  fs.mkdirSync(path.join(dir, '004-x.jpg')) // a directory named like an image
  assert.deepEqual(
    collectImages(dir).map((p) => path.basename(p)),
    ['001-x.webp', '002-x.jpg', '003-x.png'],
  )
  assert.deepEqual(collectImages(path.join(dir, 'gone')), [])
  fs.rmSync(dir, { recursive: true, force: true })
})
