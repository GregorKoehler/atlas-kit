/* ------------------------------------------------------------------ *
 * Tests for pasted inline images (agent-attachments.mjs).
 *
 * A message with several screenshots in it, pasted into an agent chat in one
 * go. Before this, every attached path was appended at the END of the prompt,
 * so the agent could not tell which screenshot belonged to which sentence.
 *
 * Focus:
 *  - withImages(): an `[Image N]` marker whose N has an `image-N` file becomes
 *    `[Image N: <path>]` in place; markers without a file (unreadable image,
 *    removed chip) stay as typed; files without a marker keep the old tail;
 *    no marker at all → byte-identical to the old single-tail output.
 *  - BOTH executors import the one implementation (the bridge is not
 *    importable in a test, so its wiring is checked in source).
 *  - the count cap is 20 on the routes and both executors.
 *
 * Run: node --test api/test/agent-attachments.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { withImages, imageNumberOf } from '../src/agent-attachments.mjs'

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf-8')

test('withImages: no marker → byte-identical to the old appended tail', () => {
  assert.equal(
    withImages('look', ['/u/1-0-shot.png']),
    'look [I attached a file at: /u/1-0-shot.png — use the Read tool to view it before responding.]',
  )
  assert.equal(
    withImages('', ['/u/a.png', '/u/b.pdf']),
    '[I attached files at: /u/a.png, /u/b.pdf — use the Read tool to view them before responding.]',
  )
  assert.equal(withImages('just text', []), 'just text')
})

test('withImages: each [Image N] marker gets its own file, in place, paragraphs kept', () => {
  const text = 'Hi,\n\nthe header is off:\n[Image 1]\nand the footer:\n[Image 2]\n[Image 3 unreadable: https://x/y]'
  const paths = ['/u/17-0-image-1.png', '/u/17-1-image-2.jpg']
  assert.equal(
    withImages(text, paths),
    'Hi,\n\nthe header is off:\n[Image 1: /u/17-0-image-1.png]\nand the footer:\n[Image 2: /u/17-1-image-2.jpg]\n' +
      '[Image 3 unreadable: https://x/y] [Use the Read tool to view every referenced image before responding. ' +
      'Each [Image N: <path>] image belongs where its marker sits in the text.]',
  )
})

test('withImages: markers without a file stay as typed; files without a marker keep the tail', () => {
  // [Image 2]'s chip was removed (no file), the 📎-picked PDF has no marker.
  const out = withImages('a [Image 1] b [Image 2] c', ['/u/1-0-image-1.png', '/u/1-1-spec.pdf'])
  assert.match(out, /^a \[Image 1: \/u\/1-0-image-1\.png\] b \[Image 2\] c \[I attached a file at: \/u\/1-1-spec\.pdf — /)
  assert.match(out, /these and the inline ones/)
})

test('withImages: an image file whose marker was deleted from the text still reaches the agent', () => {
  const out = withImages('no markers left', ['/u/1-0-image-4.png'])
  assert.equal(out, 'no markers left [I attached a file at: /u/1-0-image-4.png — use the Read tool to view it before responding.]')
})

test('withImages: a batched delivery of two pasted messages, each counting from Image 1', () => {
  const text = 'first [Image 1]\n\nsecond [Image 1] [Image 2]'
  const out = withImages(text, ['/u/1-0-image-1.png', '/u/2-0-image-1.png', '/u/2-1-image-2.png'])
  assert.match(
    out,
    /^first \[Image 1: \/u\/1-0-image-1\.png\]\n\nsecond \[Image 1: \/u\/2-0-image-1\.png\] \[Image 2: \/u\/2-1-image-2\.png\] \[Use the Read tool/,
  )
})

test('imageNumberOf reads N off a saved path (box and bridge naming)', () => {
  assert.equal(imageNumberOf('/state/uploads/x/1760-3-image-12.png'), 12)
  assert.equal(imageNumberOf('/tmp/agent-uploads/x/1760-0-image-1'), 1)
  assert.equal(imageNumberOf('/tmp/agent-uploads/x/1760-0-screenshot.png'), 0)
})

test('both executors use the ONE withImages — no local copy left to drift', () => {
  for (const [file, spec] of [
    ['../src/agent-local.mjs', './agent-attachments.mjs'],
    ['../../agent-bridge/server.mjs', '../api/src/agent-attachments.mjs'],
  ]) {
    const src = read(file)
    assert.match(src, new RegExp(`import \\{[^}]*\\bwithImages\\b[^}]*\\} from '${spec.replace(/[./]/g, '\\$&')}'`), file)
    assert.doesNotMatch(src, /function withImages\(/, `${file} must not define its own withImages`)
  }
})

test('count cap is 20 on the routes and both executors', () => {
  assert.match(read('../src/agent-routes.mjs'), /AGENT_MAX_IMAGES \|\| 20\)/)
  assert.match(read('../src/agent-local.mjs'), /AGENT_MAX_IMAGES \|\| 20\)/)
  assert.match(read('../../agent-bridge/server.mjs'), /BRIDGE_MAX_IMAGES \|\| 20\)/)
})
