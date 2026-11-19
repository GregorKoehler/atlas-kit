/* ------------------------------------------------------------------ *
 * Tests for the stray-file-drop guard (fileDrop.ts).
 *
 * A file dropped on the dashboard made the browser open it, navigating the tab
 * (on the installed PWA: the whole app) away. Pinned: a drag carrying Files is
 * refused at the window — no copy cursor, no navigation — while a text drag or
 * a Kanban card drag passes untouched, and a drop an element already handled
 * is left to it.
 * Run: node --test web/src/lib/fileDrop.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guardStrayFileDrops, hasFiles } from './fileDrop.ts'

const win = new EventTarget()
guardStrayFileDrops(win)

// A drag event as the browser dispatches it: cancelable, with a DataTransfer.
const drag = (type, types, { handled = false } = {}) => {
  const e = new Event(type, { cancelable: true })
  e.dataTransfer = { types, dropEffect: 'copy' }
  if (handled) e.preventDefault()
  win.dispatchEvent(e)
  return e
}

test('a file drag over the page is refused: no navigation, no copy cursor', () => {
  const over = drag('dragover', ['Files'])
  assert.equal(over.defaultPrevented, true)
  assert.equal(over.dataTransfer.dropEffect, 'none')
  assert.equal(drag('drop', ['Files']).defaultPrevented, true, 'the drop never opens the file')
})

test('a text drag and a Kanban card drag pass through untouched', () => {
  for (const types of [['text/plain'], ['text/plain', 'text/html'], []]) {
    const over = drag('dragover', types)
    assert.equal(over.defaultPrevented, false, JSON.stringify(types))
    assert.equal(over.dataTransfer.dropEffect, 'copy')
    assert.equal(drag('drop', types).defaultPrevented, false)
  }
})

test('a drag an element already handled keeps its own drop effect', () => {
  const over = drag('dragover', ['Files'], { handled: true })
  assert.equal(over.dataTransfer.dropEffect, 'copy')
})

test('hasFiles reads only the drag types', () => {
  assert.equal(hasFiles(null), false)
  assert.equal(hasFiles({ types: ['Files', 'text/uri-list'] }), true)
  assert.equal(hasFiles({ types: ['text/uri-list'] }), false)
})
