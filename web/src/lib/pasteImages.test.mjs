/* ------------------------------------------------------------------ *
 * Tests for pasting a message with inline screenshots (pasteImages.ts).
 *
 * A chat message with several screenshots in it, pasted into an Atlas or
 * dev-agent chat in one go — paragraphs kept, each image at its place via an
 * `[Image N]` marker, an image that cannot be read flagged in place instead of
 * dropped. Before this there was no paste handler at all: the field was a
 * single-line input, so the text arrived on one line and the images not at all.
 *
 * Pins: the HTML walk (a chat-app-shaped fixture with three images, one an
 * https src the page cannot read; emoji <img>s stay text), when a paste is
 * taken over at all, numbering across pastes and 📎 files, the unreadable
 * marker, and that the composer's marker is exactly what the executors fold.
 * And planTransfer — the one decision behind paste, a drop on the field, a
 * drop beside it and the 📎 picker: images on the field get markers, other
 * files chips, a plain-text paste stays native, and a file over the per-file
 * limit, an empty one or one past the 20-file cap is refused with a visible
 * line, never silently.
 *
 * Run: node --test web/src/lib/pasteImages.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  htmlToMarkedText,
  pastePlan,
  nextImageN,
  unreadableMarker,
  overCapMarker,
  pastedFileName,
  pasteWarnings,
  planTransfer,
  overCapNote,
} from './pasteImages.ts'
import { withImages } from '../../../api/src/agent-attachments.mjs'

// Shaped like what a chat client puts on the clipboard: a fragment wrapper,
// <p> paragraphs, an emoji <img>, entities, and three screenshots — two
// already-readable (data:, blob: as WebKit hands them over) and one behind an
// authenticated https URL. All synthetic.
const CHAT = `<html><head><style>p{margin:0}</style></head><body>
<!--StartFragment--><div class="message-body" itemprop="copy-paste-block">
<p>Hi Alex,</p>
<p>the property list is off on mobile &amp; desktop <img alt="😕" itemtype="http://schema.skype.com/Emoji" src="https://cdn.example.com/x/confused.png" width="20"></p>
<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="image"></p>
<p>and here the filter&nbsp;panel:</p>
<p><img src="blob:https://chat.example.com/0b1c-22" alt="image"><br><img alt="image" src="https://api.example.com/v1/objects/abc/views/imgo?v=1&amp;a=2"></p>
<ul><li>first point</li><li>second point</li></ul>
<p>Thanks,<br>Sam</p>
</div><!--EndFragment--></body></html>`

test('chat HTML → paragraphs kept, one [Image N] per screenshot at its place, emoji stays text', () => {
  const r = htmlToMarkedText(CHAT, 1)
  assert.equal(
    r.text,
    [
      'Hi Alex,',
      '',
      'the property list is off on mobile & desktop 😕',
      '',
      '[Image 1]',
      '',
      'and here the filter panel:',
      '',
      '[Image 2]',
      '[Image 3]',
      '',
      '• first point',
      '• second point',
      '',
      'Thanks,',
      'Sam',
    ].join('\n'),
  )
  assert.deepEqual(r.images, [
    { n: 1, src: 'data:image/png;base64,iVBORw0KGgo=' },
    { n: 2, src: 'blob:https://chat.example.com/0b1c-22' },
    // Entities decoded, so the URL is the real one.
    { n: 3, src: 'https://api.example.com/v1/objects/abc/views/imgo?v=1&a=2' },
  ])
})

test('numbering starts where the draft left off', () => {
  const r = htmlToMarkedText('<div>a<img src="x.png">b</div><div><img src="y.png"></div>', 4)
  assert.equal(r.text, 'a[Image 4]b\n[Image 5]')
  assert.deepEqual(r.images.map((i) => i.n), [4, 5])
})

test('notes-app-style divs: one line per div, blank-line divs kept, no <style> text', () => {
  const html = '<style>.x{}</style><div>one</div><div><br></div><div>two  \n  words</div>'
  assert.equal(htmlToMarkedText(html, 1).text, 'one\n\ntwo words')
})

test('pastePlan: only an image takes the paste over', () => {
  // HTML with an image → ours.
  assert.equal(pastePlan(CHAT, 'Hi Alex…', 0), 'html')
  // A bare OS screenshot: an image file and nothing else.
  assert.equal(pastePlan('', '', 1), 'files')
  // Plain text, and HTML text without an image, stay native…
  assert.equal(pastePlan('', 'hello', 0), 'native')
  assert.equal(pastePlan('<p>hello</p>', 'hello', 0), 'native')
  // …even with a rendered-selection PNG riding along (office apps do that).
  assert.equal(pastePlan('<p>cell</p>', 'cell', 1), 'native')
  // Emoji-only HTML is text.
  assert.equal(pastePlan('<p>ok <img alt="👍" src="https://x/e.png"></p>', 'ok', 0), 'native')
})

test('nextImageN: continues across pastes and counts 📎-picked files; a removed chip frees nothing', () => {
  assert.equal(nextImageN('', []), 1)
  // Two 📎 files, no markers → the first pasted image is Image 3.
  assert.equal(nextImageN('see attached', ['spec.pdf', 'log.txt']), 3)
  // A previous paste left [Image 1]..[Image 3]; the chip for 3 was removed.
  assert.equal(nextImageN('x [Image 1] y [Image 2] z [Image 3]', ['image-1.png', 'image-2.png']), 4)
  // An unreadable marker still holds its number.
  assert.equal(nextImageN('[Image 5 unreadable: https://x]', []), 6)
})

test('a plain screenshot file is named so the executor can place it', () => {
  assert.equal(pastedFileName(1, 'image/png'), 'image-1.png')
  assert.equal(pastedFileName(7, 'image/jpeg'), 'image-7.jpg')
  assert.equal(pastedFileName(2, ''), 'image-2.png')
})

test('unreadable images keep their place and are counted in the warning', () => {
  const long = `https://api.example.com/${'a'.repeat(400)}`
  const m = unreadableMarker(3, long)
  assert.ok(m.startsWith('[Image 3 unreadable: https://api.example.com/'))
  assert.ok(m.endsWith('…]'))
  assert.ok(m.length < 230)
  assert.equal(unreadableMarker(1, 'https://x/a]b c'), '[Image 1 unreadable: https://x/a%5Dbc]')
  assert.equal(unreadableMarker(2, ''), '[Image 2 unreadable: (no source)]')
  const draft = `a ${m} b ${unreadableMarker(4, 'https://y')} ${overCapMarker(21, 20)}`
  assert.deepEqual(pasteWarnings(draft), [
    '2 images unreadable — paste in Safari, or copy each image on its own',
    '1 image not attached — file limit reached',
  ])
  assert.deepEqual(pasteWarnings('[Image 1] fine'), [])
})

test('the composer and the executors speak one contract: marker + file name → path in place', () => {
  const { text } = htmlToMarkedText('<p>see</p><p><img src="data:image/png;base64,AA=="></p>', 1)
  // The executor saves `image-1.png` as `<ts>-<i>-image-1.png`.
  const saved = `/u/1760-0-${pastedFileName(1, 'image/png')}`
  assert.match(withImages(text, [saved]), /^see\n\n\[Image 1: \/u\/1760-0-image-1\.png\] \[Use the Read tool/)
  // Unreadable / over-cap markers are not `[Image N]`, so the executor never
  // places a file there — they stay as typed.
  assert.equal(withImages(unreadableMarker(1, 'https://x'), []), unreadableMarker(1, 'https://x'))
})

// ── planTransfer: paste / drop on the field / drop beside it / 📎 ──────────
const MB = 1024 * 1024
const OPTS = { firstN: 1, room: 20, max: 20, maxBytes: 8 * MB }
const png = (name = 'shot.png', size = 1000) => ({ name, type: 'image/png', size })
const pdf = (name = 'spec.pdf', size = 2000) => ({ name, type: 'application/pdf', size })
const xfer = (files, html = '', plain = '') => ({ html, plain, files })

test('transfer: files dropped on the field → a marker per image at the caret, other files as chips', () => {
  const p = planTransfer(xfer([png('a.png'), pdf(), png('b.png')]), { ...OPTS, drop: true, at: 'field', firstN: 3 })
  assert.deepEqual(p, {
    insert: '[Image 3]\n[Image 4]',
    marked: [{ n: 3, src: 0 }, { n: 4, src: 2 }],
    chips: [1],
    refused: [],
  })
})

test('transfer: a drop is always taken over — the drag text is a name/URL, not typed text', () => {
  // A drag of an image file carries its name as text/plain; a paste with text
  // and an image file is an office app's rendering of the selection and stays native.
  assert.deepEqual(planTransfer(xfer([png()], '', 'shot.png'), { ...OPTS, drop: true, at: 'field' }).insert, '[Image 1]')
  assert.equal(planTransfer(xfer([png()], '', 'some words'), { ...OPTS, drop: false, at: 'field' }), null)
  assert.equal(planTransfer(xfer([], '', 'just text'), { ...OPTS, drop: false, at: 'field' }), null)
  // A drop of non-image files only: chips, no text.
  assert.deepEqual(planTransfer(xfer([pdf()], '', 'spec.pdf'), { ...OPTS, drop: true, at: 'field' }), { insert: '', marked: [], chips: [0], refused: [] })
})

test('transfer: an image dragged out of a web page — html + its file, one to one', () => {
  const html = '<img src="https://example.com/x.png">'
  assert.deepEqual(planTransfer(xfer([png()], html), { ...OPTS, drop: true, at: 'field' }).marked, [{ n: 1, src: 0 }])
  // No matching file: the <img> source is read instead.
  assert.deepEqual(planTransfer(xfer([], html), { ...OPTS, drop: false, at: 'field' }).marked, [{ n: 1, src: 'https://example.com/x.png' }])
})

test('transfer: beside the field (a pane drop, 📎) everything is a chip, images included', () => {
  assert.deepEqual(planTransfer(xfer([png(), pdf()], '<img src="x">'), { ...OPTS, drop: true, at: 'beside' }), {
    insert: '',
    marked: [],
    chips: [0, 1],
    refused: [],
  })
})

test('transfer: over the per-file limit, empty or a folder → refused with a line, the rest still attached', () => {
  const p = planTransfer(xfer([pdf('huge.mov', 8 * MB + 1), pdf('ok.pdf'), png('big.png', 9 * MB), pdf('folder', 0)]), { ...OPTS, drop: true, at: 'field' })
  assert.deepEqual(p.chips, [1])
  assert.deepEqual(p.marked, [], 'an oversize image gets no marker at all')
  assert.deepEqual(p.refused, ['2 files not attached — larger than 8 MB', 'folder not attached — empty, or a folder'])
  assert.deepEqual(planTransfer(xfer([pdf('huge.mov', 9 * MB)]), { ...OPTS, drop: true, at: 'beside' }).refused, ['huge.mov not attached — larger than 8 MB'])
  // A lone oversize screenshot PASTED is refused out loud, not left native.
  assert.deepEqual(planTransfer(xfer([png('big.png', 9 * MB)]), { ...OPTS, drop: false, at: 'field' }), {
    insert: '',
    marked: [],
    chips: [],
    refused: ['big.png not attached — larger than 8 MB'],
  })
  // Exactly the limit is fine (the executors refuse only > max).
  assert.deepEqual(planTransfer(xfer([pdf('edge', 8 * MB)]), { ...OPTS, drop: true, at: 'beside' }).chips, [0])
})

test('transfer: the 20-file cap — markers claim room first, the overflow is visible', () => {
  const p = planTransfer(xfer([png('a.png'), png('b.png'), pdf('c.pdf'), pdf('d.pdf')]), { ...OPTS, drop: true, at: 'field', room: 1 })
  assert.deepEqual(p.marked, [{ n: 1, src: 0 }, { n: 2, src: 1, over: true }])
  assert.deepEqual(p.chips, [])
  assert.deepEqual(p.refused, ['2 files not attached — file limit reached (max 20)'])
  const q = planTransfer(xfer([pdf('a'), pdf('b'), pdf('c')]), { ...OPTS, drop: true, at: 'beside', room: 2 })
  assert.deepEqual(q.chips, [0, 1])
  assert.deepEqual(q.refused, [overCapNote(1, 20)])
  assert.equal(overCapNote(1, 20), '1 file not attached — file limit reached (max 20)')
})
