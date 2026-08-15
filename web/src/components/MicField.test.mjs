/* ------------------------------------------------------------------ *
 * The zero-addons invariant, held in the UI: with the `voice` addon disabled,
 * MicField must render its child field and NOTHING else — no wrapper element, no
 * mic button, no listener, no request. Four cards wrap fields in it (the Kanban's
 * new-task fields, the task view, the Atlas chat, the agent spawn box), so a
 * regression here is a stray element inside every one of them on every kit that
 * never enables the addon (docs/ADDONS.md).
 *
 * WHY THIS READS THE SOURCE instead of rendering. The web suite runs on `node
 * --test` through type-stripping: there is no JSX transform and no DOM, so a
 * .tsx component cannot be executed here, and the alternative — pulling a
 * renderer + a DOM shim into devDependencies for one assertion — is a heavier
 * dependency than the thing it guards. What is asserted is therefore structural
 * and deliberately narrow: the gate comes first, its branch returns the bare
 * children, and everything with a DOM footprint lives in the other component.
 * The props contract is pinned in the same pass — it is what let the kit ship
 * this file as a pure passthrough in the first place.
 * Run: node --test web/src/components/MicField.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'MicField.tsx'), 'utf-8')

/** The body of a top-level `export function <name>(…) {` — up to the first line
 *  that is a lone `}` in column 0, which is how this file's components end. */
function bodyOf(name) {
  const lines = src.split('\n')
  const start = lines.findIndex((l) => l.startsWith(`export function ${name}(`) || l.startsWith(`function ${name}(`))
  assert.notEqual(start, -1, `${name} is defined at the top level`)
  const end = lines.findIndex((l, i) => i > start && l === '}')
  assert.notEqual(end, -1, `${name} has a terminating brace`)
  return lines.slice(start, end + 1).join('\n')
}

test('the addon-disabled branch is the first thing MicField does, and returns bare children', () => {
  const body = bodyOf('MicField')
  const firstReturn = /return\s+([^\n]+)/.exec(body)
  assert.ok(firstReturn, 'MicField returns something')
  assert.equal(firstReturn[1].trim(), '<>{props.children}</>', 'the first return is the transparent passthrough')

  const gate = body.indexOf("addons.enabled('voice')")
  assert.ok(gate !== -1, 'the gate asks GET /api/addons whether THIS box runs the addon')
  assert.ok(gate < firstReturn.index, 'the gate precedes the passthrough return')
  assert.match(body, /addons\.ready\s*&&/, 'an unanswered /api/addons is treated as "not enabled", so nothing flickers')
})

test('nothing with a DOM footprint lives in the gated component', () => {
  const body = bodyOf('MicField')
  for (const forbidden of ['micfield', '<button', 'useDictation', 'useEffect', 'useRef']) {
    assert.ok(!body.includes(forbidden), `MicField itself must not use ${forbidden} — that is the enabled path's job`)
  }
  // …and the enabled path is where all of it actually is.
  const live = bodyOf('LiveMicField')
  assert.ok(live.includes('micfield') && live.includes('<button') && live.includes('useDictation'))
})

test('the props contract the four call sites rely on is unchanged', () => {
  const props = /interface MicFieldProps \{([\s\S]*?)\n\}/.exec(src)
  assert.ok(props, 'the props are declared in one place')
  for (const line of ['value: string', 'onChange: (next: string) => void', 'multiline?: boolean', 'children: ComponentChildren']) {
    assert.ok(props[1].includes(line), `props still carry \`${line}\``)
  }
})
