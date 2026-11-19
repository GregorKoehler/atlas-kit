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
