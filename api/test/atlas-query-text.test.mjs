/* ------------------------------------------------------------------ *
 * The Atlas typed query engine's hybrid `text` leg and its completeness
 * defaults (api/src/atlas-query.mjs).
 *
 * `query_atlas` sells one thing — COMPLETE, EXACT answers over the typed layer
 * (Atlas Guide §7) — and two defects were quietly breaking it, neither of which
 * announces itself at runtime because both fail by returning FEWER rows:
 *
 *   1. the `text` filter was `p._text.includes(lc(spec.text))`, a raw contiguous
 *      substring, so `3d scene` and `scene 3d` answered the same question
 *      differently and every compound-language query missed. Quoting was broken
 *      too: the quote CHARACTERS went into the substring, so `"scene 3d"`
 *      searched for pages that literally print the quotes;
 *   2. the default limit of 50 truncated any larger answer — silently, in an
 *      engine whose whole promise is completeness.
 *
 * Four properties have to hold, and none of them is visible from a passing call:
 * word ORDER must not matter; the filter must stay a FILTER (all terms present —
 * widening it into an OR would trade one silent lie for another); the window
 * must not bite before the ceiling does; and where the window DOES bite, the
 * rows kept must be the relevant ones rather than the alphabetically lucky.
 *
 * Hermetic: a fixture vault in a temp dir, no box state, no real vault.
 * Run: node --test api/test/atlas-query-text.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { queryAtlas } from '../src/atlas-query.mjs'

/* --- a miniature Atlas ---------------------------------------------- */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-query-'))
const write = (rel, body) => {
  const abs = path.join(ROOT, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, body)
}

write(
  'Tasks/3d-scene-unavailable-diagnose.md',
  `---
type: task
status: doing
for_project: "[[Example-App]]"
due: 2026-08-10
---

# Liegenschafts-3D nach dem Deploy

Die 3D-Ansicht meldet scene unavailable. Kette: API, Task-Queue, Worker, UI-Zustand.
`,
)
write(
  'Tasks/boundary-delivery.md',
  `---
type: task
status: next
for_project: "[[Example-Dashboard]]"
due: 2026-08-04
---

# Boundary delivery for remote agents

A queued message should land at the next tool call. The bridge does the delivery.
`,
)
write(
  'Wiki/Concepts/NK-Abrechnung-Pruefprozess.md',
  `---
type: concept
---

# NK-Abrechnung — der reale Prüfprozess

Wie eine Nebenkostenabrechnung bei einem grossen Bewirtschafter geprüft wird.
`,
)
write(
  'Wiki/Projects/Example-Dashboard.md',
  `---
type: project
status: doing
---

# Example Dashboard

Scene 3d is written here contiguously, once. ${'Unrelated prose about cards and notes. '.repeat(40)}
`,
)
write(
  'Wiki/Sources/filler-scene.md',
  `---
type: source
---

# A scene from a film

No printers here, only a scene.
`,
)
// 60 open tasks in one project — more than the old default limit of 50, so a
// complete answer is only complete if the window does not bite.
for (let i = 0; i < 60; i++) {
  write(
    `Tasks/bulk-${String(i).padStart(2, '0')}.md`,
    `---
type: task
status: waiting
for_project: "[[Bulk]]"
updated: 2026-07-${String((i % 28) + 1).padStart(2, '0')}
---

# Bulk task ${i}

Filler body for the bulk task ${i}.
`,
  )
}

const q = (spec) => queryAtlas(spec, ROOT)
const paths = (spec) => q(spec).pages.map((p) => p.path).sort()

/* --- defect 1: the text leg ----------------------------------------- */

test('word order does not matter — the measured failure', () => {
  const forward = paths({ text: '3d scene' })
  const reversed = paths({ text: 'scene 3d' })
  assert.ok(forward.includes('Tasks/3d-scene-unavailable-diagnose.md'))
  assert.deepEqual(reversed, forward, 'reversing the words must not change the answer at all')
})

test('the filter stays a FILTER — every term must be present', () => {
  // 'filler-scene' has "scene" and no "3d": an OR would return it, and the
  // engine would stop being the exact half of the pair.
  assert.ok(!paths({ text: '3d scene' }).includes('Wiki/Sources/filler-scene.md'))
  assert.ok(paths({ text: 'scene' }).includes('Wiki/Sources/filler-scene.md'))
})

test('non-adjacent terms match — the hybrid shape the tool is used in', () => {
  assert.deepEqual(paths({ type: 'task', text: 'boundary bridge delivery' }), ['Tasks/boundary-delivery.md'])
})

test('a quoted phrase still means the exact contiguous string', () => {
  // …and the quote characters are no longer part of what is searched for: the
  // old filter looked for pages literally printing `"scene 3d"`.
  assert.deepEqual(paths({ text: '"scene 3d"' }), ['Wiki/Projects/Example-Dashboard.md'])
  assert.ok(paths({ text: 'scene 3d' }).length > paths({ text: '"scene 3d"' }).length, 'quoting must narrow')
  assert.deepEqual(paths({ text: '"scene unavailable in 3d"' }), [])
})

test('German: a term matches the compound it prefixes', () => {
  // 'Nebenkosten' occurs in the fixture only INSIDE 'Nebenkostenabrechnung',
  // and the query says the two words in the opposite order from the page.
  assert.deepEqual(paths({ text: 'Prüfprozess Nebenkosten' }), ['Wiki/Concepts/NK-Abrechnung-Pruefprozess.md'])
})

test('text AND typed filters still compose', () => {
  assert.deepEqual(paths({ type: 'task', status: 'doing', text: 'scene 3d' }), ['Tasks/3d-scene-unavailable-diagnose.md'])
  assert.deepEqual(paths({ type: 'task', status: 'next', text: 'scene 3d' }), [])
})

test('the snippet shows a matched term in context', () => {
  // The old snippet could only find the WHOLE query as one substring, so once
  // matching went per-term it would have returned '' for every multi-term hit.
  const row = q({ text: 'delivery boundary' }).pages[0]
  assert.ok(row.snippet && /boundary|delivery/i.test(row.snippet), row.snippet)
  // No `text` in the spec, no snippet key — the pure typed answer is unchanged.
  assert.equal(q({ type: 'task', status: 'next' }).pages[0].snippet, undefined)
})

/* --- defect 2: completeness ----------------------------------------- */

test('a typed answer comes back COMPLETE by default', () => {
  const r = q({ type: 'task', status: 'waiting' })
  assert.equal(r.count, 60)
  assert.equal(r.pages.length, 60, 'the old default of 50 dropped 10 of these')
  assert.equal(r.truncated, false)
})

test('truncation is the loud exception: count is the FULL match count', () => {
  const r = q({ type: 'task', status: 'waiting', limit: 5 })
  assert.equal(r.pages.length, 5)
  assert.equal(r.count, 60, 'count must report everything that matched, not what was returned')
  assert.equal(r.truncated, true)
})

test('the ceiling clamps a pathological limit', () => {
  const r = q({ limit: 99999 })
  assert.ok(r.pages.length <= 1000)
  assert.equal(r.count, 65, 'the whole fixture vault matched, whatever the window returned')
})

test('relevance orders the window ONLY when the window forces a choice', () => {
  // Two pages carry both terms; only one can be returned. The task note is about
  // them, the project page merely mentions them once in 40 lines of filler.
  const r = q({ text: 'scene 3d', limit: 1 })
  assert.equal(r.count, 2)
  assert.equal(r.truncated, true)
  assert.equal(r.pages[0].path, 'Tasks/3d-scene-unavailable-diagnose.md')
  // An explicit sort is the caller saying what the order means to them — it wins.
  assert.equal(q({ text: 'scene 3d', limit: 1, sort: 'title' }).pages[0].path, 'Wiki/Projects/Example-Dashboard.md')
  // And with room for every match, the default (typed) sort is untouched.
  assert.deepEqual(
    q({ text: 'scene 3d' }).pages.map((p) => p.path),
    q({ text: 'scene 3d', sort: '-updated' }).pages.map((p) => p.path),
  )
})
