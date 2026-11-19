/* ------------------------------------------------------------------ *
 * The composer's drop rules, held structurally (AgentAttach.tsx).
 *
 * Rule: a drop only fills the draft. Dropping a file on a chat, the dev spawn
 * form or the Ask form must never send, queue or spawn by itself — the
 * operator still presses Enter or the button. And every composer is a zone,
 * while a drop outside them stays refused at the window (lib/fileDrop.ts).
 *
 * WHY THIS READS THE SOURCE: the web suite runs on `node --test` with type
 * stripping — no JSX transform, no DOM — so a .tsx component cannot run here
 * (see MicField.test.mjs for the same trade-off). The pure decision behind a
 * drop is unit-tested in lib/pasteImages.test.mjs (planTransfer); this pins
 * the wiring around it, narrowly.
 * Run: node --test web/src/components/AgentAttach.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf-8')
const src = read('./AgentAttach.tsx')

/** The text of `const <name>[: T] = (…) => {` up to its closing `  }` at the same indent. */
function arrowBody(name, indent = '  ') {
  const m = new RegExp(`\\n${indent}const ${name}(?:: \\w+)? = \\(`).exec(src)
  assert.ok(m, `${name} exists`)
  const start = m.index
  const end = src.indexOf(`\n${indent}}\n`, start)
  assert.notEqual(end, -1, `${name} ends`)
  return src.slice(start, end)
}

test('the only submit in the composer is Enter on the field — no drop or paste path submits', () => {
  assert.equal(src.match(/requestSubmit\(/g)?.length, 1, 'exactly one requestSubmit')
  assert.match(arrowBody('onKeyDown'), /e\.key !== 'Enter'[\s\S]*requestSubmit\(\)/)
  for (const name of ['take', 'onDrop', 'onPaste']) {
    assert.doesNotMatch(arrowBody(name), /requestSubmit|\.submit\(|onSubmit/, `${name} never submits`)
  }
  // The zone's own drop hands the files to `take` and nothing else.
  const zone = src.slice(src.indexOf('export function useDropZone('), src.indexOf('export type DropZone'))
  const onDrop = zone.slice(zone.indexOf('onDrop: (e: DragEvent) => {'), zone.indexOf('\n    },', zone.indexOf('onDrop: (e: DragEvent) => {')))
  assert.match(onDrop, /take\.current!\(e\.dataTransfer!, null\)/)
  assert.doesNotMatch(onDrop, /submit/i)
})

test('only a drag carrying Files is the zone\'s; a drop the field took is never taken twice', () => {
  assert.match(src, /const ours = \(e: DragEvent\) => !!take\.current && hasFiles\(e\.dataTransfer\)/)
  assert.match(src, /if \(e\.defaultPrevented\) return\s*\n\s*e\.preventDefault\(\)\s*\n\s*take\.current!/)
})

test('every composer is a drop zone: spawn form, chat row, full screen, Ask form', () => {
  const list = read('./cards/AgentList.tsx')
  assert.match(list, /<form className="agents__spawn" onSubmit=\{spawn\} \{\.\.\.drop\.props\}>/)
  assert.match(list, /<li className=\{cls\} \{\.\.\.drop\.props\}>/)
  assert.match(list, /aria-modal="true" ref=\{fullscreenRef\} \{\.\.\.drop\.props\}>/)
  assert.equal(list.match(/\{drop\.overlay\}/g)?.length, 3)
  const kb = read('./cards/KnowledgeAgents.tsx')
  assert.match(kb, /<form className="agents__spawn" onSubmit=\{ask\} \{\.\.\.drop\.props\}>/)
  assert.match(kb, /\{drop\.overlay\}/)
  // The window guard for drops outside every zone stays installed.
  assert.match(read('../main.tsx'), /guardStrayFileDrops\(\)/)
})

test('the client caps mirror the executors\' defaults', () => {
  assert.match(src, /export const MAX_ATTACHMENTS = 20\n/)
  assert.match(src, /export const MAX_ATTACHMENT_BYTES = 8 \* 1024 \* 1024\n/)
  assert.match(read('../../../api/src/agent-local.mjs'), /AGENT_MAX_IMAGE_BYTES \|\| 8 \* 1024 \* 1024\)/)
  assert.match(read('../../../agent-bridge/server.mjs'), /BRIDGE_MAX_IMAGE_BYTES \|\| 8 \* 1024 \* 1024\)/)
})
