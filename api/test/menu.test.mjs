/* ------------------------------------------------------------------ *
 * Tests for the pure menu parsing/selection helpers (menu.mjs): read a pending
 * numbered menu off the TUI pane — its options, the live `❯` highlight, and an
 * AskUserQuestion box's question/header/descriptions — and drive a selection to
 * a named option, confirming by CONTENT at every step before pressing Enter.
 *
 * Run: node --test api/test/menu.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseChoiceMenu, currentHighlight, driveSelect, parseMenuReply } from '../src/menu.mjs'

test('parseChoiceMenu: numbered options + which is highlighted', () => {
  const pane = ['❯ 1. Yes', '  2. No, keep editing', '  3. Show me the diff first'].join('\n')
  const m = parseChoiceMenu(pane)
  assert.deepEqual(m.options, [
    { n: 1, text: 'Yes' },
    { n: 2, text: 'No, keep editing' },
    { n: 3, text: 'Show me the diff first' },
  ])
  assert.equal(m.highlighted, 1)
})

test('parseChoiceMenu: tolerates surrounding ANSI escapes + a ")" separator', () => {
  const pane = '\x1b[7m❯ 1) Approve\x1b[0m\n  2) Reject\n'
  const m = parseChoiceMenu(pane)
  assert.deepEqual(m.options.map((o) => o.n), [1, 2])
  assert.equal(m.options[0].text, 'Approve')
  assert.equal(m.highlighted, 1)
})

test('parseChoiceMenu: highlight defaults to the first option when none is marked', () => {
  const m = parseChoiceMenu('  1. A\n  2. B')
  assert.equal(m.highlighted, 1)
})

test('parseChoiceMenu: not a real menu (<2 options) → null', () => {
  assert.equal(parseChoiceMenu('❯ 1. Only one'), null)
  assert.equal(parseChoiceMenu('just some prose with a 3. in it'), null)
  assert.equal(parseChoiceMenu(''), null)
})

test('parseChoiceMenu: captures the prompt/question directly above the options', () => {
  const pane = ['Do you want to make this edit?', '❯ 1. Yes', '  2. No'].join('\n')
  assert.equal(parseChoiceMenu(pane).question, 'Do you want to make this edit?')
})

test('parseChoiceMenu: multi-line question is joined; conversation above is not absorbed', () => {
  const pane = [
    '● Some earlier assistant output that must NOT be read as the question.',
    '',
    'Apply this large refactor',
    'to auth.ts?',
    '❯ 1. Yes',
    '  2. No',
  ].join('\n')
  assert.equal(parseChoiceMenu(pane).question, 'Apply this large refactor to auth.ts?')
})

test('parseChoiceMenu: an echoed user turn above the menu is not mistaken for the question', () => {
  // `❯ <text>` with a REGULAR space is a past user-message echo (the an earlier change
  // phantom-menu shape), not this menu's prompt — question stays empty.
  const pane = ['❯ ship it via the protocol', '❯ 1. Yes', '  2. No'].join('\n')
  assert.equal(parseChoiceMenu(pane).question, undefined)
})

test('parseChoiceMenu: no adjacent prompt → no question field', () => {
  assert.equal(parseChoiceMenu('❯ 1. Yes\n  2. No').question, undefined)
})

/* --- RC1 regression: the in testing AskUserQuestion incident ------------ *
 * Verified ground truth (transcript tool_use toolu_01VUMiBzcfFpAmb7tMuVufkx,
 * tool_result at 2026-07-21T17:41:15Z — see /tmp/atlas-kit-askuserquestion-menu-spec.md):
 * the assistant's own prose numbered list ("1. The `Capture` card is only on
 * that tab…", "2. `agentFocus.ts:29` routes to a soon-dead tab…") sat directly
 * above the real AskUserQuestion box, whose real menu ALSO numbered from 1
 * ("❯ 1. Move it to the Atlas tab (Recommended)"). The old whole-pane scan
 * (kept the first sighting per number) let the prose steal numbers 1 and 2 —
 * dropping the real highlighted row entirely and losing the highlight with it.
 * The exact box layout (a horizontal rule, a " ☐ <header>" line, the question,
 * a BLANK line, then the options, another rule, then the "Chat about this"
 * escape row past it) is empirically verified live in testing (a scratch
 * `claude` TUI session), not assumed. Re-verified live in testing (this
 * follow-up): the question/header ARE readable by crossing that one blank gap
 * (boxAbove) — updated below from the original's "question stays empty"
 * expectation, which reflected the now-corrected assumption that a pending
 * AskUserQuestion sourced its question from the transcript instead. */
test('parseChoiceMenu: RC1 — assistant prose numbered list directly above a real AskUserQuestion menu does not steal its numbers or highlight, and the box question/header ARE read from the pane', () => {
  const pane = [
    '1. The `Capture` card is only on that tab',
    '2. `agentFocus.ts:29` routes to a soon-dead tab',
    '',
    'Now calling the tool:',
    '────────────────────────────────────────────────────────────────────',
    ' ☐ Capture card',
    '',
    'The Capture card (text / photo / PDF ingest) lives only on the Knowledge Base tab. What should happen to it?',
    '',
    '❯ 1. Move it to the Atlas tab (Recommended)',
    '  2. Drop it with the tab',
    '  3. Merge into LinkIngest',
    '  4. Type something.',
    '────────────────────────────────────────────────────────────────────',
    '  5. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n')
  const m = parseChoiceMenu(pane)
  assert.deepEqual(m.options, [
    { n: 1, text: 'Move it to the Atlas tab (Recommended)' },
    { n: 2, text: 'Drop it with the tab' },
    { n: 3, text: 'Merge into LinkIngest' },
    { n: 4, text: 'Type something.', escape: true },
    { n: 5, text: 'Chat about this', escape: true },
  ])
  assert.equal(m.highlighted, 1, 'the REAL highlighted row, not the prose default')
  assert.equal(m.question, 'The Capture card (text / photo / PDF ingest) lives only on the Knowledge Base tab. What should happen to it?')
  assert.equal(m.header, 'Capture card')
})

test('parseChoiceMenu: a lone trailing escape row past a border is absorbed into the real menu, flagged, not dropped', () => {
  // Its own 1-option block can never qualify as A menu on its own (that
  // guard is unchanged); the fix is that it's no longer silently discarded
  // either — it's folded into the real menu as a flagged escape entry so the
  // card can offer it as a distinct "type your own answer" affordance.
  const pane = ['❯ 1. Red', '  2. Green', '────', '  3. Chat about this'].join('\n')
  assert.deepEqual(parseChoiceMenu(pane).options, [
    { n: 1, text: 'Red' },
    { n: 2, text: 'Green' },
    { n: 3, text: 'Chat about this', escape: true },
  ])
})

test('parseChoiceMenu: a duplicate/out-of-sequence number starts a fresh block instead of being dropped', () => {
  // No blank/border between the two numbered runs — the number resetting to 1
  // is itself what ends the first block.
  const pane = ['1. old prose a', '2. old prose b', '❯ 1. Yes', '  2. No', '  3. Maybe'].join('\n')
  const m = parseChoiceMenu(pane)
  assert.deepEqual(m.options, [{ n: 1, text: 'Yes' }, { n: 2, text: 'No' }, { n: 3, text: 'Maybe' }])
  assert.equal(m.highlighted, 1)
})

/* --- currentHighlight: the live ❯ row, unrestricted by blocks ----------- */
test('currentHighlight: finds the live ❯ row, including past a border (an escape row)', () => {
  const pane = ['  1. Red', '  2. Green', '  3. Blue', '  4. Type something.', '────', '❯ 5. Chat about this'].join('\n')
  assert.deepEqual(currentHighlight(pane), { n: 5, text: 'Chat about this' })
})
test('currentHighlight: null when nothing is highlighted', () => {
  assert.equal(currentHighlight('  1. A\n  2. B'), null)
})

/* --- driveSelect: verified navigation, mocked IO ------------------------ *
 * A tiny in-memory "pane" with a cursor over a fixed row list stands in for
 * tmux — driveSelect only ever sees it through readHighlight/sendKey, so this
 * exercises the exact same logic the box-local executor and the bridge share. */
function mockMenu(rows, startN) {
  let idx = rows.findIndex((r) => r.n === startN)
  const enters = []
  return {
    readHighlight: async () => ({ ...rows[idx] }),
    sendKey: async (key) => {
      if (key === 'Down') idx = Math.min(idx + 1, rows.length - 1)
      else if (key === 'Up') idx = Math.max(idx - 1, 0)
      else if (key === 'Enter') enters.push(rows[idx].n)
      return true
    },
    enters,
  }
}
const ROWS = [
  { n: 1, text: 'Red' },
  { n: 2, text: 'Green' },
  { n: 3, text: 'Blue' },
  { n: 4, text: 'Type something.' },
  { n: 5, text: 'Chat about this' },
]

test('driveSelect: navigates using the hint, confirms by text, then presses Enter exactly once', async () => {
  const mock = mockMenu(ROWS, 1)
  const r = await driveSelect({ target: 'Blue', hintN: 3, ...mock })
  assert.equal(r.ok, true)
  assert.deepEqual(mock.enters, [3])
})

test('driveSelect: no hint still finds the target by content alone (default Down)', async () => {
  const mock = mockMenu(ROWS, 1)
  const r = await driveSelect({ target: 'blue', ...mock }) // case/whitespace-insensitive match too
  assert.equal(r.ok, true)
  assert.deepEqual(mock.enters, [3])
})

test('driveSelect: a wrong initial direction is detected (clamped) and flipped', async () => {
  // Start at the LAST row with no hint (defaults Down) — Down clamps
  // immediately, so it must flip to Up to ever reach 'Red'.
  const mock = mockMenu(ROWS, 5)
  const r = await driveSelect({ target: 'Red', ...mock })
  assert.equal(r.ok, true)
  assert.deepEqual(mock.enters, [1])
})

test('driveSelect: target not found → gives up WITHOUT ever pressing Enter', async () => {
  const mock = mockMenu(ROWS, 1)
  const r = await driveSelect({ target: 'Purple', ...mock })
  assert.equal(r.ok, false)
  assert.ok(r.error)
  assert.deepEqual(mock.enters, [], 'never blind-fired Enter on an unconfirmed pick')
})

test('driveSelect: no menu open → error, no keys sent', async () => {
  const r = await driveSelect({
    target: 'Red',
    readHighlight: async () => null,
    sendKey: async () => true,
  })
  assert.equal(r.ok, false)
})

/* --- parseChoiceMenu: AskUserQuestion pane extraction (in testing follow-up) *
 * Fixtures below reproduce, verbatim (structure, glyphs, and spacing), live
 * scratch `claude` TUI sessions on THIS box, in testing — see
 * /tmp/atlas-kit-ask-pending-question-pane-spec.md. Ground truth confirmed live:
 * the transcript has NO record of a pending AskUserQuestion at all (Claude
 * Code doesn't write that tool_use to disk until it's flushed together with
 * the tool_result, after the operator already answered — see this file's
 * module doc-comment), so the question/header/descriptions can only come from
 * here; the escape row "Type something(.)" sits CONTIGUOUS with the real
 * options with NO rule between them (contradicting an earlier change's assumption that
 * a rule always separates it — only "Chat about this" sits past one);
 * descriptions render for EVERY option, not just the highlighted one; and a
 * tab/header row ("←  ☐ …  ✔ Submit  →") is the live signal for multi-
 * question/multiSelect, which needs its own driving flow this can't provide. */
const RULE = '─'.repeat(80)

test('parseChoiceMenu: AskUserQuestion box — question/header/per-option descriptions, contiguous + trailing escape rows both absorbed and flagged', () => {
  const pane = [
    RULE,
    ' ☐ Color',
    '',
    'Which color do you prefer?',
    '',
    '❯ 1. Red',
    '     warm',
    '  2. Green',
    '     nature',
    '  3. Blue',
    '     cool',
    '  4. Type something.',
    RULE,
    '  5. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n')
  const m = parseChoiceMenu(pane)
  assert.deepEqual(m.options, [
    { n: 1, text: 'Red', description: 'warm' },
    { n: 2, text: 'Green', description: 'nature' },
    { n: 3, text: 'Blue', description: 'cool' },
    { n: 4, text: 'Type something.', escape: true },
    { n: 5, text: 'Chat about this', escape: true },
  ])
  assert.equal(m.highlighted, 1)
  assert.equal(m.question, 'Which color do you prefer?')
  assert.equal(m.header, 'Color')
})

test('parseChoiceMenu: AskUserQuestion box — a wrapped multi-line question is joined', () => {
  const pane = [
    RULE,
    ' ☐ Approach',
    '',
    'Given the tradeoffs between shipping a quick patch now versus taking the time to refactor the underlying module properly so this class of bug cannot recur, which approach would you like me to take for this specific',
    'change?',
    '',
    '❯ 1. Quick patch',
    '     Ship now, revisit later',
    '  2. Full refactor',
    '     Takes longer, fixes root cause',
    '  3. Type something.',
    RULE,
    '  4. Chat about this',
  ].join('\n')
  const m = parseChoiceMenu(pane)
  assert.equal(
    m.question,
    'Given the tradeoffs between shipping a quick patch now versus taking the time to refactor the underlying module properly so this class of bug cannot recur, which approach would you like me to take for this specific change?',
  )
  assert.equal(m.header, 'Approach')
  assert.deepEqual(m.options.map((o) => o.n), [1, 2, 3, 4])
})

test('parseChoiceMenu: multiSelect — the tab/header row flags it unsupported instead of misdriving the checkbox+Submit flow', () => {
  const pane = [
    RULE,
    '←  ☐ Frameworks  ✔ Submit  →',
    '',
    'Which of these testing frameworks should we support?',
    '',
    '❯ 1. [ ] Jest',
    '  Most popular',
    '  2. [ ] Vitest',
    '  Fast, Vite-native',
    '  3. [ ] Mocha',
    '  Older, flexible',
    '  4. [ ] Type something',
    '     Submit',
    RULE,
    '  5. Chat about this',
  ].join('\n')
  const m = parseChoiceMenu(pane)
  assert.deepEqual(m, {
    unsupported: true,
    reason: 'multi-select',
    question: 'Which of these testing frameworks should we support?',
    header: 'Frameworks',
  })
})

test('parseChoiceMenu: multi-question — the tab row lists >1 question tab, flagged unsupported (its own Tab-between-questions flow)', () => {
  const pane = [
    RULE,
    '←  ☐ Color  ☐ Size  ✔ Submit  →',
    '',
    'Which color?',
    '',
    '❯ 1. Red',
    '     Warm tone',
    '  2. Green',
    '     Natural tone',
    '  3. Blue',
    '     Cool tone',
    '  4. Type something.',
    RULE,
    '  5. Chat about this',
  ].join('\n')
  const m = parseChoiceMenu(pane)
  assert.deepEqual(m, {
    unsupported: true,
    reason: 'multi-question',
    question: 'Which color?',
    header: 'Color',
  })
})

test('parseChoiceMenu: no blank gap above the options → the permission/plan pane-only path is unaffected, no header', () => {
  const pane = ['Do you want to make this edit?', '❯ 1. Yes', '  2. No'].join('\n')
  const m = parseChoiceMenu(pane)
  assert.deepEqual(m.options, [{ n: 1, text: 'Yes' }, { n: 2, text: 'No' }])
  assert.equal(m.question, 'Do you want to make this edit?')
  assert.equal(m.header, undefined)
})

test('parseMenuReply: a clean number maps to an option; junk does not', () => {
  const options = [{ n: 1, text: 'Yes' }, { n: 2, text: 'No' }]
  assert.equal(parseMenuReply('2', options), 2)
  assert.equal(parseMenuReply('2.', options), 2)
  assert.equal(parseMenuReply('#2', options), 2)
  assert.equal(parseMenuReply(' 1 ', options), 1)
  assert.equal(parseMenuReply('5', options), null) // out of range
  assert.equal(parseMenuReply('2 and also do x', options), null) // a real instruction, not a pick
  assert.equal(parseMenuReply('yes', options), null)
})
