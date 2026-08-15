/* ------------------------------------------------------------------ *
 * The rendered vault page (api/page.mjs) — what actually gets committed.
 *
 * What this pins:
 *   · THE SOURCE URL IS ON THE PAGE, in the frontmatter AND in the body. A note
 *     whose origin you cannot re-open is a rumour;
 *   · THE CAPTION IS VERBATIM and in its OWN section — never folded into the
 *     model's prose, where a paraphrase would replace what the author wrote;
 *   · a failed analysis still produces a real page (title, caption, media) that
 *     SAYS the analysis is missing, instead of an empty or falsely-complete one;
 *   · frontmatter stays parseable whatever the model returned: tags are bare
 *     scalars, and the caption — arbitrary user text — never reaches the YAML.
 *
 * Run: node --test addons/instagram-ingest/test/page.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderPage, slugFor, pagePathFor, assetsPathFor, assetLink, assetName, fallbackTitle, isoFromUploadDate } from '../api/page.mjs'

const URL = 'https://www.instagram.com/p/AbCdE12345/'
const base = {
  url: URL,
  code: 'AbCdE12345',
  kind: 'p',
  ingestedAt: '2026-08-15T09:41:00.000Z',
}

test('paths are derived from the post code, so a re-ingest updates ONE page', () => {
  assert.equal(slugFor('AbCdE12345'), 'instagram-AbCdE12345')
  assert.equal(pagePathFor('AbCdE12345'), 'Wiki/Sources/instagram-AbCdE12345.md')
  assert.equal(assetsPathFor('AbCdE12345'), 'Wiki/assets/instagram/AbCdE12345')
  // Wiki/Sources/… → ../assets/… — the link must resolve from the PAGE, not the vault root.
  assert.equal(assetLink('AbCdE12345', '2.jpg'), '../assets/instagram/AbCdE12345/2.jpg')
  assert.equal(assetName(0, '/tmp/001-x.WEBP'), '1.webp')
  assert.equal(assetName(2, '/tmp/003-x'), '3.jpg')
})

test('the full page: url twice, caption verbatim in its own section, media linked', () => {
  const caption = 'Rye, 20% starter — "no knead".\n\n#bread #rye'
  const md = renderPage({
    ...base,
    caption,
    analysis: { ok: true, title: 'A 20% rye sourdough', tags: ['baking', 'bread'], body: 'The reel walks through a rye bake.' },
    images: ['1.jpg', '2.jpg'],
    uploader: 'someone',
    postedAt: '2026-08-01',
  })

  assert.match(md, /^---\ntype: source\nsource: instagram\nurl: "https:\/\/www\.instagram\.com\/p\/AbCdE12345\/"\ncreated: 2026-08-15\ntags: \[instagram, baking, bread\]\n---\n/)
  assert.match(md, /\n# A 20% rye sourdough\n/)
  assert.match(md, /The reel walks through a rye bake\./)
  // Verbatim, blockquoted, its own heading — and the hashtags survive.
  assert.match(md, /## Original caption\n\n> Rye, 20% starter — "no knead"\.\n>\n> #bread #rye\n/)
  assert.match(md, /!\[.*1\/2\)\]\(\.\.\/assets\/instagram\/AbCdE12345\/1\.jpg\)/)
  assert.match(md, /!\[.*2\/2\)\]\(\.\.\/assets\/instagram\/AbCdE12345\/2\.jpg\)/)
  assert.match(md, /## Source\n\n- https:\/\/www\.instagram\.com\/p\/AbCdE12345\/\n- Posted by @someone on 2026-08-01\n- Ingested 2026-08-15 by `addons\/instagram-ingest`/)
  assert.ok(!md.includes('[!warning]'), 'a clean ingest carries no warning callout')
})

test('a failed analysis still writes a real page, and says what is missing', () => {
  const md = renderPage({
    ...base,
    caption: 'The whole recipe, in the caption.',
    analysis: { ok: false, error: 'claude -p exited 1: not logged in' },
    images: [],
    warnings: ['no analysis: claude -p exited 1: not logged in', 'no images fetched'],
  })
  assert.match(md, /# The whole recipe, in the caption\./, 'the caption supplies the title')
  assert.match(md, /No analysis was written[^\n]*not logged in/)
  assert.match(md, /> \[!warning\] Incomplete ingest\n> - no analysis[^\n]*\n> - no images fetched/)
  assert.match(md, /The whole recipe, in the caption\./)
  assert.match(md, /tags: \[instagram\]/)
  assert.ok(!md.includes('## Media'), 'no images → no empty Media section')
})

test('a caption-less post says so rather than rendering an empty quote', () => {
  const md = renderPage({ ...base, kind: 'reel', caption: '', analysis: { ok: true, title: 'A wordless clip', tags: [], body: 'Two minutes of a lathe.' }, images: ['1.jpg'] })
  assert.match(md, /## Original caption\n\n\*The post carried no written caption\.\*/)
  assert.equal(fallbackTitle({ caption: '', kind: 'reel', code: 'AbCdE12345' }), 'Instagram reel AbCdE12345')
})

test('a truncated caption is flagged ON THE PAGE, not only in a log', () => {
  const md = renderPage({ ...base, caption: 'x'.repeat(40), captionTruncated: true, analysis: { ok: false } })
  assert.match(md, /caption truncated by the ingest limit/)
})

test('yt-dlp upload dates are normalised, and nonsense is dropped rather than printed', () => {
  assert.equal(isoFromUploadDate('20260801'), '2026-08-01')
  assert.equal(isoFromUploadDate(''), '')
  assert.equal(isoFromUploadDate('yesterday'), '')
})
