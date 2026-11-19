/* ------------------------------------------------------------------ *
 * Tests for auto-linking URLs in every chat view (linkify.ts, and its use in
 * markdown.tsx's renderInline).
 *
 * The ask: every link in every chat view clickable. Before this only an
 * explicit `[text](url)` in an assistant reply was a link — a bare
 * https://github.com/…/pull/42 was text everywhere, and the operator's own
 * bubbles never linked anything. And that
 * one path passed its href through raw, so `[x](javascript:…)` in an agent
 * reply rendered as a live javascript: link.
 *
 * Pins: what is a URL (http/https/mailto, www., <autolinks>) and what is not
 * (bare domains, file names), the trailing punctuation a sentence puts after a
 * URL (incl. typographic „“ quotes and the balanced-paren rule), the scheme
 * allowlist, the terminal view's joining of a hard-wrapped URL, and — through
 * the real renderInline — that code spans, existing links, images and
 * [[wikilinks]] are never (re-)linked.
 *
 * linkify.ts runs directly via node's type-stripping; markdown.tsx is JSX, so
 * it is bundled in-memory with esbuild (already installed, as vite's) and its
 * VNodes inspected — no DOM, no render-to-string dependency.
 * Run: node --test web/src/lib/linkify.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { findLinks, linkify, safeHref, trimUrl } from './linkify.ts'

// The hrefs linkify finds in a text, in order.
const hrefs = (text, opts) => findLinks(text, opts).map((l) => l.href)
// The linked TEXT (what the operator sees underlined), in order.
const texts = (text) => linkify(text).filter((p) => typeof p !== 'string').map((p) => p.text)

test('bare http(s) URLs are links; surrounding text is untouched', () => {
  const s = 'see https://github.com/example-org/example-repo/pull/42 for it'
  assert.deepEqual(hrefs(s), ['https://github.com/example-org/example-repo/pull/42'])
  assert.equal(linkify(s).map((p) => (typeof p === 'string' ? p : p.text)).join(''), s, 'text stays byte-identical')
  assert.deepEqual(hrefs('http://127.0.0.1:3001/api/agents?x=1#frag'), ['http://127.0.0.1:3001/api/agents?x=1#frag'])
})

test('www. hosts link with an https:// href; bare domains and file names do not', () => {
  assert.deepEqual(hrefs('go to www.example.com now'), ['https://www.example.com'])
  assert.deepEqual(texts('go to www.example.com now'), ['www.example.com'])
  for (const s of ['edit markdown.tsx', 'run foo.py', 'example.com', 'www.', 'a www.x b', 'node v22.1.0', 'user@example.com']) {
    assert.deepEqual(hrefs(s), [], s)
  }
})

test('markdown autolinks <https://…> link without their brackets', () => {
  assert.deepEqual(linkify('a <https://x.y/z> b'), ['a ', { text: 'https://x.y/z', href: 'https://x.y/z' }, ' b'])
})

test('trailing sentence punctuation is not part of the URL', () => {
  for (const tail of ['.', ',', ';', ':', '!', '?', '…?', '"', "'", '”', '“', '»']) {
    assert.deepEqual(hrefs(`look at https://x.y/a${tail} next`), ['https://x.y/a'], tail)
  }
  assert.deepEqual(hrefs('(look at https://x.y/a.)'), ['https://x.y/a'])
  assert.deepEqual(hrefs('„https://x.y/a“ sagt er.'), ['https://x.y/a'], 'German quotes')
  assert.deepEqual(hrefs('see https://x.y/a, https://x.y/b.'), ['https://x.y/a', 'https://x.y/b'])
  assert.deepEqual(hrefs('https://x.y/a?b=1&c=2.'), ['https://x.y/a?b=1&c=2'])
})

test('a closing paren stays only when it is balanced (Wikipedia-style)', () => {
  assert.deepEqual(hrefs('https://en.wikipedia.org/wiki/Mercury_(planet)'), ['https://en.wikipedia.org/wiki/Mercury_(planet)'])
  assert.deepEqual(hrefs('(see https://en.wikipedia.org/wiki/Mercury_(planet))'), ['https://en.wikipedia.org/wiki/Mercury_(planet)'])
  assert.deepEqual(hrefs('(see https://x.y/z)'), ['https://x.y/z'])
  assert.deepEqual(hrefs('[see https://x.y/z]'), ['https://x.y/z'])
  assert.equal(trimUrl('https://x.y/z).'), 'https://x.y/z')
})

test('a URL is not taken from the middle of a word, email or path', () => {
  assert.deepEqual(hrefs('xhttps://x.y'), [])
  assert.deepEqual(hrefs('me@www.example.com'), [])
  assert.deepEqual(hrefs('proxy/https://x.y'), [])
})

test('only http(s) and mailto become hrefs', () => {
  assert.equal(safeHref('javascript:alert(1)'), null)
  assert.equal(safeHref('JavaScript:alert(1)'), null)
  assert.equal(safeHref(' javascript:alert(1)'), null)
  assert.equal(safeHref('data:text/html,<b>x</b>'), null)
  assert.equal(safeHref('vbscript:x'), null)
  assert.equal(safeHref('/relative/path'), null)
  assert.equal(safeHref('Concepts/CI-Timing-Trap.md'), null)
  assert.equal(safeHref('https://'), null)
  assert.equal(safeHref('https://x.y/a'), 'https://x.y/a')
  assert.equal(safeHref('mailto:someone@example.com'), 'mailto:someone@example.com')
  assert.equal(safeHref('mailto:'), null)
  assert.deepEqual(hrefs('write mailto:a@b.de.'), ['mailto:a@b.de'])
})

// A pane's expired-login dialog: Ink hard-wraps the ~500-char oauth URL at the
// box width, so each row is its own line in the capture.
const LOGIN_URL =
  'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code' +
  '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile' +
  '+user%3Ainference+user%3Asessions%3Aclaude_code&code_challenge=Rj8vX2mQe0Yf7c1Lq3dW9sKpZtN4bH6uA5gC2xVyE0o' +
  '&code_challenge_method=S256&state=n3Wq8Lr1Zt5Yb7Ke2Vd9Hc0Xp4Mf6Ga1Sj3Uu8Ri2Oo'
const wrapAt = (s, w, pad = '') => s.match(new RegExp(`.{1,${w}}`, 'g')).map((r) => pad + r).join('\n')

test('terminal view: a hard-wrapped URL links whole, with its line breaks kept in the text', () => {
  const pane = [
    ' Browser didn\'t open? Use the url below to sign in',
    '',
    wrapAt(LOGIN_URL, 78, ' '),
    '',
    ' Paste code here if prompted >',
    '─'.repeat(80),
  ].join('\n')
  const links = findLinks(pane, { wrapWidth: 80 })
  assert.equal(links.length, 1)
  assert.equal(links[0].href, LOGIN_URL)
  assert.match(pane.slice(links[0].start, links[0].end), /\n/)
  // Without the width (a chat bubble), each row is its own fragment — which is
  // exactly why the terminal view passes it.
  assert.notEqual(findLinks(pane)[0].href, LOGIN_URL)
})

test('terminal view: a short URL at a row end is never glued to the next row', () => {
  const pane = ['see https://x.y/a', 'nextword', '─'.repeat(80)].join('\n')
  assert.deepEqual(hrefs(pane, { wrapWidth: 80 }), ['https://x.y/a'])
  const full = ['x'.repeat(60) + ' https://x.y/' + 'a'.repeat(7), 'two words', '─'.repeat(80)].join('\n')
  assert.deepEqual(hrefs(full, { wrapWidth: 80 }), ['https://x.y/aaaaaaa'], 'a prose row never continues a URL')
})

/* --- through the real renderInline -------------------------------- */
const md = await (async () => {
  const r = await build({
    entryPoints: [fileURLToPath(new URL('./markdown.tsx', import.meta.url))],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    logLevel: 'silent',
  })
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`)
})()

// Flatten renderInline's output into ['text', {a: href, text}, {code: …}, …].
function shape(nodes) {
  const out = []
  const textOf = (n) => (n == null || typeof n === 'boolean' ? '' : typeof n !== 'object' ? String(n) : Array.isArray(n) ? n.map(textOf).join('') : textOf(n.props?.children))
  const walk = (n) => {
    if (n == null || typeof n === 'boolean') return
    if (Array.isArray(n)) return n.forEach(walk)
    if (typeof n !== 'object') return void out.push(String(n))
    if (n.type === 'a') return void out.push({ a: n.props.href, text: textOf(n) })
    if (typeof n.type === 'function' && n.type.name === 'ExtLink') return void out.push({ a: n.props.href, text: textOf(n.props.children) })
    if (n.type === 'code') return void out.push({ code: textOf(n) })
    if (n.type === 'img') return void out.push({ img: n.props.src })
    if (n.type === 'span' || n.type === 'button') return void out.push({ wiki: textOf(n) })
    if (typeof n.type === 'function' && n.type.name === 'WikiRef') return void out.push({ wiki: textOf(n.props.label) })
    out.push({ [n.type]: shape(n.props.children) })
  }
  walk(nodes)
  return out
}
const inline = (s) => shape(md.renderInline(s, {}))
const links = (s) => JSON.stringify(inline(s)).match(/"a":"[^"]*"/g) ?? []

test('renderInline links bare URLs in plain text', () => {
  assert.deepEqual(inline('PR https://github.com/o/r/pull/583.'), [
    'PR ',
    { a: 'https://github.com/o/r/pull/583', text: 'https://github.com/o/r/pull/583' },
    '.',
  ])
  assert.deepEqual(inline('<https://x.y/z>'), [{ a: 'https://x.y/z', text: 'https://x.y/z' }])
})

test('renderInline: an underscore in a URL is not italics', () => {
  assert.deepEqual(inline('https://x.y/a_b_c/d_e'), [{ a: 'https://x.y/a_b_c/d_e', text: 'https://x.y/a_b_c/d_e' }])
  assert.deepEqual(inline('snake_case https://x.y/a_b'), ['snake_case ', { a: 'https://x.y/a_b', text: 'https://x.y/a_b' }])
  assert.deepEqual(inline('_ok_'), [{ em: ['ok'] }], 'word-bounded _italics_ still work')
})

test('renderInline never links inside code, and never re-links a link, image or wikilink', () => {
  assert.deepEqual(inline('`https://x.y/a`'), [{ code: 'https://x.y/a' }])
  assert.deepEqual(inline('[https://x.y/a](https://x.y/b)'), [{ a: 'https://x.y/b', text: 'https://x.y/a' }])
  assert.deepEqual(inline('![shot](https://x.y/a.png)'), [{ img: 'https://x.y/a.png' }])
  assert.deepEqual(inline('[[https://x.y/a]]'), [{ wiki: 'https://x.y/a' }])
  assert.deepEqual(links('**see https://x.y/a**'), ['"a":"https://x.y/a"'], 'inside bold still links once')
})

test('renderInline: a fenced code block is never linked', () => {
  const vnode = md.Markdown({ source: '```\ncurl https://x.y/a\n```\n\nsee https://x.y/b' })
  const json = JSON.stringify(shape(vnode))
  assert.equal((json.match(/"a":/g) ?? []).length, 1)
  assert.match(json, /"a":"https:\/\/x\.y\/b"/)
  assert.match(json, /curl https:\/\/x\.y\/a/)
})

test('renderInline: [x](javascript:…) renders as text, not a link', () => {
  assert.deepEqual(inline('[x](javascript:alert(1))'), ['[x](javascript:alert(1)', ')'])
  assert.deepEqual(links('[x](javascript:alert(1))'), [])
  assert.deepEqual(links('[x](data:text/html,hi)'), [])
  assert.deepEqual(inline('[x](https://x.y/a)'), [{ a: 'https://x.y/a', text: 'x' }])
})

test('linkNodes (plain bubbles) leaves link-free text as the same string', () => {
  assert.equal(md.linkNodes('no links in markdown.tsx'), 'no links in markdown.tsx')
  assert.deepEqual(shape(md.linkNodes('**not markdown** https://x.y')), ['**not markdown** ', { a: 'https://x.y', text: 'https://x.y' }])
})
