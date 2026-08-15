/* ------------------------------------------------------------------ *
 * The claude -p seam (api/analyze.mjs): the prompt, the parse, the validation.
 * Pure functions only — the model is never spawned here.
 *
 * What this pins:
 *   · IMAGES ARE PASSED AS VAULT-RELATIVE PATHS with a Read-tool instruction —
 *     the prompt must never be asked to carry image bytes, and a post with no
 *     stills must SAY so rather than leave the model free to invent imagery;
 *   · the prompt STEERS ON THE CAPTION when there is one (it carries the names,
 *     quantities and links the imagery skips) and states its absence when not;
 *   · tags reach YAML frontmatter, so they are reduced to bare scalars — a model
 *     that answers with "#Sourdough Bread!" must not produce unparseable YAML;
 *   · validation is DELIBERATELY WEAK: it rejects an empty/refusal answer, not
 *     prose we happen to dislike.
 *
 * Run: node --test addons/instagram-ingest/test/analyze.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildPrompt, sanitize, parseAnalysis, cleanTags, validate, analyze } from '../api/analyze.mjs'

const URL = 'https://www.instagram.com/p/AbCdE12345/'

test('with stills: the paths go in, the Read tool is named, no bytes are inlined', () => {
  const p = buildPrompt({ url: URL, caption: 'a caption', imageRels: ['Wiki/assets/instagram/AbCdE12345/1.jpg', 'Wiki/assets/instagram/AbCdE12345/2.jpg'] })
  assert.match(p, /open EACH of these with the Read tool/i)
  assert.match(p, /- Wiki\/assets\/instagram\/AbCdE12345\/1\.jpg\n- Wiki\/assets\/instagram\/AbCdE12345\/2\.jpg/)
  assert.match(p, /SAME post \(a carousel or a reel, in order\)/)
  assert.ok(p.includes(URL))
  assert.ok(p.length < 4000, 'the prompt stays a prompt — images are paths, not payload')
})

test('without stills the prompt says so, so the model cannot describe what it cannot see', () => {
  const p = buildPrompt({ url: URL, caption: 'a caption', imageRels: [] })
  assert.match(p, /IMAGES: none could be fetched/)
  assert.match(p, /do not describe imagery you cannot see/)
})

test('the caption steers the prompt when present, and its absence is stated when not', () => {
  const withCap = buildPrompt({ url: URL, caption: 'Rye, 20% starter', imageRels: ['a.jpg'] })
  assert.match(withCap, /routinely carries what the imagery does not/)
  assert.match(withCap, /"""\nRye, 20% starter\n"""/)
  assert.match(buildPrompt({ url: URL, caption: '', imageRels: ['a.jpg'] }), /CAPTION: the post carried no written caption\./)
})

test('a whole-answer markdown fence is stripped, inner code blocks are not', () => {
  assert.equal(sanitize('```markdown\nTITLE: x\n```'), 'TITLE: x')
  assert.equal(sanitize('```\nTITLE: x\n```'), 'TITLE: x')
  assert.equal(sanitize('TITLE: x\n\n```js\ncode\n```'), 'TITLE: x\n\n```js\ncode\n```')
})

test('the answer parses into title, tags and body', () => {
  const { title, tags, body } = parseAnalysis('TITLE: "A 20% rye sourdough"\nTAGS: baking, Sourdough, #rye\n\nThe reel walks through a rye bake.\n\n- 20% starter')
  assert.equal(title, 'A 20% rye sourdough')
  assert.deepEqual(tags, ['baking', 'sourdough', 'rye'])
  assert.equal(body, 'The reel walks through a rye bake.\n\n- 20% starter')
})

test('tags are reduced to bare YAML scalars, deduped and capped', () => {
  assert.deepEqual(cleanTags('#Sourdough Bread!, sourdough-bread, ,a, ONE, two, three, four, five, six'), ['sourdough-bread', 'one', 'two', 'three', 'four', 'five'])
  assert.deepEqual(cleanTags(''), [])
  assert.deepEqual(cleanTags('***'), [])
})

test('validation rejects the empty answer and nothing else', () => {
  assert.equal(validate({ title: 'A title', body: 'x'.repeat(40) }), '')
  assert.match(validate({ title: '', body: 'x'.repeat(40) }), /no TITLE/)
  assert.match(validate({ title: 'A title', body: '   too short   ' }), /empty or near-empty/)
})

test('nothing to analyze → no model spawn at all, and a stated reason', async () => {
  const r = await analyze({ url: URL, caption: '', imageRels: [], cwd: '/tmp' })
  assert.deepEqual(r, { ok: false, error: 'nothing to analyze — no caption and no images' })
})
