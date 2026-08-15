/* ------------------------------------------------------------------ *
 * Tests for the two-witness busy detector (api/src/pane-busy.mjs), shared by
 * BOTH executors (agent-local.mjs and agent-bridge/server.mjs). Its verdict
 * times queue delivery and the ship train, so a false IDLE mistimes a send and
 * bypasses the BOUNDARY_MIN_GAP_MS pacing.
 *
 * Every fixture in api/test/fixtures/panes/ is a REAL `tmux capture-pane` of a
 * live Claude Code agent on the box (in testing), byte-for-byte. Two were
 * produced by a controlled probe of `deliver()`'s own `tmux send-keys` against
 * THIS agent's own pane; no other session was ever written to.
 *
 * WHAT THE PROBE MEASURED (sampling both witnesses every 200 ms):
 *   • delivered text SITTING in the input box — the footer collapses and drops
 *     `esc to interrupt` for as long as it sits there (11.5 s measured), while
 *     the spinner keeps rendering. This is the regime the second witness fixes.
 *   • the ~8 s AFTER a large (2.7 KB) message is submitted — the footer is
 *     replaced by a `paste again to expand` hint and no spinner renders either.
 *     NEITHER witness covers it; see the residual-gap test at the bottom.
 *   • a small message submitted immediately — no false idle at all (97/97
 *     samples kept both witnesses).
 *
 * Run: node --test api/test/pane-busy.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isBusy, spinnerRunning } from '../src/pane-busy.mjs'

const RULE = '─'.repeat(80)
const FOOTER_BUSY = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for age…'
const FOOTER_IDLE = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents'
const FOOTER_COLLAPSED = '  ⏵⏵ bypass permissions on · 1 shell'

// Synthetic but structurally faithful: each reproduces a frame measured on a
// live 80-column Claude Code pane — glyphs, column anchoring, the two `─` rules
// around the input box, and which footer segments survive. Generated here
// rather than checked in as captures, so the kit ships no transcript excerpts.
const PANES = {
  'busy-full-footer': [
    '● Searching for 1 pattern, reading 1 file, running 1 shell command…',
    '  ⎿  src/server.mjs',
    '',
    '✽ Beaming… (2m 28s · ↓ 7.2k tokens)',
    '',
    RULE, '❯ ', RULE, FOOTER_BUSY,
  ],
  'busy-tip-block': [
    '● Running 1 shell command…',
    '',
    '✽ Germinating… (50s · ↓ 2.8k tokens)',
    '  ⎿  Tip: Use Plan Mode to prepare for a complex request before making changes.',
    '     Press shift+tab twice to enable.',
    '',
    RULE, '❯ ', RULE, FOOTER_BUSY,
  ],
  'busy-delivered-draft-no-marker': [
    '', '', '',
    '* Lollygagging… (13m 15s · ↓ 46.9k tokens)',
    '',
    RULE,
    '❯ ↪ **From your Atlas orchestrator** (session `probe`) — an instruction; act',
    '  on it.',
    '',
    '  DELIVERY PROBE — never submitted, cleared with C-u.',
    RULE, FOOTER_COLLAPSED,
  ],
  'idle-at-prompt': [
    '  Folded the recap into the wiki and appended a log entry.',
    '',
    '✻ Worked for 1m 52s',
    '                                         new task? /clear to save 102.2k tokens',
    RULE, '❯ ', RULE, FOOTER_IDLE,
  ],
  'idle-ghost-draft': [
    '  Done — the branch is pushed and the PR is open.',
    '',
    '✻ Brewed for 47s',
    '',
    RULE, '❯ ok, merge it once CI is green', RULE, FOOTER_IDLE,
  ],
  'idle-background-chip': [
    '  Two agent slots are free right now.',
    '',
    '✻ Worked for 25s · 1 monitor still running',
    '',
    RULE, '❯ ', RULE,
    '  ⏵⏵ bypass permissions on · 1 monitor · ← for agents · ↓ to manage',
  ],
  'busy-quoted-spinner-in-output': [
    "  ⎿  $ printf '%s\\n' 'quoting a real captured busy pane:' '✽ Beaming… (2m 28s",
    "     · ↓ 7.2k tokens)'",
    '     tmux capture-pane -t agentbox-demo… (3s · 3 lines)',
    '     (ctrl+b ctrl+b (twice) to run in background)',
    '',
    '✽ Lollygagging… (7m 34s · ↓ 27.8k tokens)',
    '',
    RULE, '❯ ', RULE,
    '  ⏵⏵ bypass permissions on · 1 shell · esc to interrupt · ← for agents',
  ],
  'busy-paste-echo-frame': [
    '    5. Both executors get the same rule; the bridge half takes effect only',
    '    on the next bridge rollout — state that in the PR body.',
    '',
    RULE,
    '❯ Press up to edit queued messages',
    RULE,
    '  paste again to expand',
  ],
}
const pane = (name) => PANES[name].join('\n')

/* --- busy ------------------------------------------------------------- */

test('busy with an intact footer marker (both witnesses agree)', () => {
  const p = pane('busy-full-footer')
  assert.equal(isBusy(p), true)
  assert.equal(spinnerRunning(p), true, 'spinner: ✽ Beaming… (2m 28s · ↓ 7.2k tokens)')
})

test('busy with a `⎿ Tip:` block between the spinner and the input box', () => {
  // The spinner is not always the line directly above the box — SPINNER_LOOKBACK
  // has to clear the tip block and the blank line under it.
  assert.equal(spinnerRunning(pane('busy-tip-block')), true)
})

test('THE FIX: a delivered message collapses the footer, and the spinner holds busy', () => {
  // Probe capture, mid-turn: `⏵⏵ bypass permissions on · 1 shell` — the
  // `esc to interrupt` segment is gone, so the old single-witness detector
  // called this RUNNING agent idle. Measured: 11.5 s in that state.
  const p = pane('busy-delivered-draft-no-marker')
  assert.doesNotMatch(p, /esc to interrupt/, 'fixture must not carry the footer marker')
  assert.equal(spinnerRunning(p), true)
  assert.equal(isBusy(p), true, 'the whole point: idle needs BOTH witnesses absent')
})

test('the input box may be many rows tall (a multi-line delivered draft)', () => {
  // Same fixture: 7 rows between the two rules. The spinner sits above the box
  // TOP rule, so the box-top scan must survive a tall box (BOX_ROWS_MAX).
  const rows = PANES['busy-delivered-draft-no-marker']
  const rules = rows.reduce((n, r) => n + (/^\s*─{10,}\s*$/.test(r) ? 1 : 0), 0)
  assert.equal(rules, 2)
  assert.equal(spinnerRunning(rows.join('\n')), true)
})

/* --- idle ------------------------------------------------------------- */

test('genuinely idle at the prompt — the post-turn line is NOT a spinner', () => {
  // `✻ Worked for 1m 52s`: same glyph, same column, turn OVER. The trailing `…`
  // and the parenthesised duration are what separate the two.
  const p = pane('idle-at-prompt')
  assert.match(p, /✻ Worked for/, 'fixture must carry the post-turn line')
  assert.equal(isBusy(p), false)
})

test('idle with dim ghost-draft text in the input box stays idle', () => {
  // `✻ Brewed for 47s` above, the operator's last line still shown in the box.
  assert.equal(isBusy(pane('idle-ghost-draft')), false)
})

test('idle with a background-shell/monitor footer chip stays idle', () => {
  // `⏵⏵ bypass permissions on · 1 monitor · ← for agents · ↓ to manage` — the
  // chip pushed `(shift+tab to cycle)` out entirely, and the post-turn line
  // reads `✻ Worked for 25s · 1 monitor still running`. Still idle.
  const p = pane('idle-background-chip')
  assert.match(p, /1 monitor/)
  assert.equal(isBusy(p), false)
})

test('an open choice menu is not busy — the menu affordances depend on it', () => {
  // The AskUserQuestion box layout verified live in testing (menu.test.mjs's RC1
  // fixture): its own rules bound the region, and no spinner renders while the
  // agent waits on the operator.
  const p = [
    '● Two things need deciding first:',
    '',
    '────────────────────────────────────────────────────────────────────',
    ' ☐ Capture card',
    '',
    'The Capture card lives only on the Knowledge Base tab. What should happen to it?',
    '',
    '❯ 1. Move it to the Atlas tab (Recommended)',
    '  2. Drop it with the tab',
    '────────────────────────────────────────────────────────────────────',
    '  3. Chat about this',
    '',
    'Enter to select · ↑/↓ to navigate · Esc to cancel',
  ].join('\n')
  assert.equal(isBusy(p), false)
})

/* --- the anchor: spinner-shaped text in the agent's OUTPUT ------------- */

test('a spinner QUOTED in the agent\'s own output does not read as busy', () => {
  // Real capture of this very investigation: the pane holds a `✽ Beaming… (2m
  // 28s · ↓ 7.2k tokens)` quotation AND a near-miss `… (3s · 3 lines)` inside a
  // tool result, both within the lookback window — but indented, while the live
  // spinner starts at column 0. Anchoring is what keeps a whole-pane grep (and
  // with it a permanently-stuck busy, which would freeze delivery) impossible.
  const p = pane('busy-quoted-spinner-in-output')
  const quoted = p.split('\n').filter((l) => /Beaming…|\(3s ·/.test(l))
  assert.ok(quoted.length >= 2, 'fixture must contain the quoted spinner text')
  assert.ok(quoted.every((l) => /^\s/.test(l)), 'quoted lines are indented; the live one is not')
  // It IS busy here — but on its own live spinner + marker, not the quotation.
  assert.equal(isBusy(quoted.join('\n')), false, 'the quoted lines alone are not busy')
  assert.equal(isBusy(p), true)
})

test('spinner-shaped prose far above the input box is out of the window', () => {
  const p = [
    '* Lollygagging… (2m 1s · ↓ 4.0k tokens)',
    '', '', '', '', '', '', '',
    '────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────',
    '  ⏵⏵ bypass permissions on · ← for agents',
  ].join('\n')
  assert.equal(isBusy(p), false)
})

/* --- one implementation, two executors -------------------------------- */

test('both executors import this module — neither keeps its own copy', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  const local = fs.readFileSync(path.join(root, 'api', 'src', 'agent-local.mjs'), 'utf8')
  const bridge = fs.readFileSync(path.join(root, 'agent-bridge', 'server.mjs'), 'utf8')
  assert.match(local, /import \{ isBusy \} from '\.\/pane-busy\.mjs'/)
  assert.match(bridge, /import \{ isBusy \} from '\.\.\/api\/src\/pane-busy\.mjs'/)
  // The bridge is restarted separately from the box, so a second definition
  // there would silently keep the old single-witness rule after a box deploy.
  for (const [name, src] of [['agent-local.mjs', local], ['agent-bridge/server.mjs', bridge]]) {
    assert.doesNotMatch(src, /function isBusy\(/, `${name} must not redefine isBusy`)
    assert.doesNotMatch(src, /esc to interrupt\/i/, `${name} must not keep its own busy marker`)
  }
})

/* --- kill-switch ------------------------------------------------------ */

test('AGENT_SPINNER_WITNESS=0 restores the footer-marker-only behaviour', async () => {
  process.env.AGENT_SPINNER_WITNESS = '0'
  const off = await import('../src/pane-busy.mjs?off=1')
  delete process.env.AGENT_SPINNER_WITNESS
  assert.equal(off.spinnerRunning(pane('busy-delivered-draft-no-marker')), false)
  assert.equal(off.isBusy(pane('busy-delivered-draft-no-marker')), false)
  assert.equal(off.isBusy(pane('busy-full-footer')), true, 'the footer leg is untouched')
})

/* --- residual gap, stated rather than hidden -------------------------- */

test('KNOWN GAP: the paste-echo frame after a LARGE delivery has neither witness', () => {
  // Two real captures of this: the orchestrator's own 2 KB pointer message to
  // this agent, and the 2.7 KB probe. For ~8 s the footer is replaced by
  // `paste again to expand` and no spinner renders, so a running turn still
  // reads idle. Notification-side that is covered by an earlier change's debounced
  // `phase`; delivery-side it is bounded by BOUNDARY_MIN_GAP_MS pacing.
  //
  // REJECTED as a third witness (on evidence, not taste): the box's
  // `❯ Press up to edit queued messages` hint. It means "a message is parked",
  // and a message parked behind a CHOICE MENU stays parked while the agent is
  // genuinely idle waiting on the operator — that would stick busy forever and
  // freeze delivery, the one failure direction worse than a false idle.
  const p = pane('busy-paste-echo-frame')
  assert.match(p, /paste again to expand/)
  assert.equal(isBusy(p), false, 'documents the gap; change this only WITH a witness that covers it')
})
