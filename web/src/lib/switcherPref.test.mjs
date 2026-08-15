/* ------------------------------------------------------------------ *
 * Tests for the full-screen switcher preference (switcherPref.ts).
 *
 * The switcher is EXPANDED by default: the one view whose job is NAVIGATION
 * shouldn't cost a tap before it can navigate — on the phone the operator uses
 * that graph to hop between Atlas chats and dev agents. So a MISSING preference
 * means open, and only an explicit 'collapsed' hides the graph.
 *
 * That default must change ONLY the no-preference case: an operator who already
 * tapped to expand keeps expanding, one who explicitly collapsed stays
 * collapsed. All three states are pinned below.
 *
 * Runs the real TS module via node's native type-stripping (no build, no
 * node_modules): switcherPref.ts is self-contained.
 * Run: node --test web/src/lib/switcherPref.test.mjs
 * ------------------------------------------------------------------ */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { SWITCHER_PREF_KEY, defaultSwitcherOpen, persistSwitcherOpen } from './switcherPref.ts'

// The module reads `localStorage` lazily (inside try/catch), so a plain stub is
// enough — no jsdom.
let store
beforeEach(() => {
  store = new Map()
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  }
})

test('no stored preference → OPEN (collapsing is the opt-in)', () => {
  assert.equal(defaultSwitcherOpen(), true)
})

test("a stored 'open' keeps expanding — the default must not override a stored choice", () => {
  store.set(SWITCHER_PREF_KEY, 'open')
  assert.equal(defaultSwitcherOpen(), true)
})

test("a stored 'collapsed' stays collapsed — collapsing is still available and sticky", () => {
  store.set(SWITCHER_PREF_KEY, 'collapsed')
  assert.equal(defaultSwitcherOpen(), false)
})

test('the toggle round-trips through storage in both directions', () => {
  persistSwitcherOpen(false)
  assert.equal(store.get(SWITCHER_PREF_KEY), 'collapsed')
  assert.equal(defaultSwitcherOpen(), false)
  persistSwitcherOpen(true)
  assert.equal(store.get(SWITCHER_PREF_KEY), 'open')
  assert.equal(defaultSwitcherOpen(), true)
})

test('an unavailable localStorage (private mode) degrades to open, not collapsed', () => {
  globalThis.localStorage = {
    get length() {
      throw new Error('SecurityError')
    },
    getItem() {
      throw new Error('SecurityError')
    },
    setItem() {
      throw new Error('SecurityError')
    },
  }
  assert.equal(defaultSwitcherOpen(), true)
  persistSwitcherOpen(false) // must not throw — the toggle still works for this session
})
