/* ------------------------------------------------------------------ *
 * Tests for unwrapping Claude Code's `<pasted_content>` wrapper in the chat
 * history (agent-history.mjs unwrapPasted).
 *
 * Claude Code's paste detection wraps a long multi-line input — and the
 * executors TYPE every prompt, so any long send trips it — and the user turn
 * lands on disk wrapped in `<pasted_content id=…>` tags. The chat bubble showed
 * them raw, and a wrapped Atlas steer no longer started with its provenance
 * header. Pinned: matched id-paired blocks unwrap (on the read path only),
 * malformed or unmatched tags stay the text they are, and a wrapped steer still
 * matches its fingerprint.
 *
 * Run: node --test api/test/agent-history-pasted.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTranscript, stitchParsed, steerKey, tagSteered, unwrapPasted } from '../src/agent-history.mjs'

const j = (o) => JSON.stringify(o)
// Claude Code's paste wrapper, exactly as a wrapped user turn reads on disk.
const wrap = (body, id = '657c') => `<pasted_content id="${id}">\n${body}\n</pasted_content id="${id}">`

test('unwrapPasted: one block — the whole turn, as measured on disk', () => {
  assert.equal(unwrapPasted(`\n\n${wrap('line one\n\nline two')}\n`), 'line one\n\nline two')
})

test('unwrapPasted: two blocks, and own words around a block, each become a paragraph', () => {
  assert.equal(unwrapPasted(`${wrap('first', 'a1')}\n${wrap('second', 'b2')}\n`), 'first\n\nsecond')
  assert.equal(unwrapPasted(`${wrap('first', 'a1')}${wrap('second', 'b2')}`), 'first\n\nsecond')
  assert.equal(unwrapPasted(`see this:\n\n${wrap('the paste')}\nthoughts?`), 'see this:\n\nthe paste\n\nthoughts?')
})

test('unwrapPasted: an unmatched or malformed tag stays the text it is', () => {
  for (const t of [
    '<pasted_content id="657c">\nno close',
    'no open\n</pasted_content id="657c">',
    '<pasted_content id="657c">\nids differ\n</pasted_content id="beef">',
    '<pasted_content id=657c>\nunquoted\n</pasted_content id=657c>',
    '<pasted_content>\nno id\n</pasted_content>',
    'quoting the tag `<pasted_content id="` in prose',
  ])
    assert.equal(unwrapPasted(t), t)
  // A good pair next to a stray close: only the pair goes.
  assert.equal(unwrapPasted(`${wrap('ok')}\n</pasted_content id="dead">`), 'ok\n\n</pasted_content id="dead">')
})

test('parseTranscript: a wrapped user turn (and a wrapped mid-turn queued one) reaches the chat unwrapped', () => {
  const text = [
    j({ type: 'user', uuid: 'u1', timestamp: '2026-10-15T10:00:00Z', message: { role: 'user', content: `\n\n${wrap('my long\nmessage')}\n` } }),
    j({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-15T10:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
    j({ type: 'attachment', uuid: 'q1', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: `\n\n${wrap('queued\nlong')}\n`, timestamp: '2026-10-15T10:00:02Z' } }),
  ].join('\n')
  const msgs = parseTranscript(text).messages
  assert.equal(msgs[0].text, 'my long\nmessage')
  assert.equal(msgs[2].text, 'queued\nlong')
})

test('tagSteered: a long steer Claude Code wrapped still matches its fingerprint', () => {
  // The steer is recorded off the text SENT; the transcript holds it wrapped.
  const sent = '↪ **From your Atlas orchestrator** (session `kb-x`)\n\nplease do the thing\nin detail'
  const text = [
    j({ type: 'user', uuid: 'u1', timestamp: '2026-10-15T10:00:00Z', message: { role: 'user', content: `\n\n${wrap(sent)}\n` } }),
    j({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-15T10:00:01Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } }),
  ].join('\n')
  const { messages } = stitchParsed([parseTranscript(text)])
  tagSteered(messages, new Set([steerKey(sent)]))
  assert.equal(messages[0].source, 'atlas')
  assert.ok(messages[0].text.startsWith('↪ **From your Atlas orchestrator**'), 'the provenance header is back at the start')
})
