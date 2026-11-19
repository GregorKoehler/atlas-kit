/* ------------------------------------------------------------------ *
 * Tests for Claude Code's numbered-key panels (pane-panel.mjs) and what
 * delivery does under one (tui-input.mjs).
 *
 * The incident: an agent called SendFeedback, Claude Code 2.1.296 parked a
 * feedback-draft card ("1 to review · 2 to send · 0 to dismiss") above the
 * input box, and for five hours every delivery that failed its read-back left
 * its text behind (`emptied:true, boxSeen:false`, dozens of times). Queue flushes
 * and the client retry typed onto it; three stacks of 4-20 copies were later
 * submitted as single turns.
 *
 * Pins: the card (and the turn-off prompt, the review list, the survey) is
 * found on REAL captures — fixtures/panes/panel-*.txt, taken from throwaway
 * Claude Code 2.1.296 / 2.1.300 sessions asked to call SendFeedback on a
 * harmless test draft, plus the bottom 16 rows of an 800-row-tall pane
 * (panel-feedback-draft-tall*.txt) — and
 * is NOT found on idle/busy/login panes or on an agent quoting the card;
 * delivery refuses under it with nothing typed, however often it is retried;
 * and the card's buttons can press `0`, `1` and Esc but never `2` (send to
 * Anthropic), and never the `0` that would turn the feature off.
 *
 * The captures keep their real frame (rules, borders, widths, SGR); the words
 * of conversation and draft text in them were replaced with neutral ones.
 * The survey fixture is SYNTHETIC — built from the installed binary's strings
 * (`How is Claude doing this session? (optional)`, `1: Bad 2: Fine 3: Good
 * 0: Dismiss`, 10 columns per option) — it could not be triggered on demand.
 *
 * Run: node --test api/test/pane-panel.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parsePanel, PANEL_SAFE_KEYS } from '../src/pane-panel.mjs'
import { typeAndSubmit, pressPanelAction, inputBoxText, TUI_HOLD_STAGES } from '../src/tui-input.mjs'

// The executors' readPane: the pane's last 32 rows (captureTail(s, 32)).
const fixture = (name) => fs.readFileSync(new URL(`./fixtures/panes/${name}.txt`, import.meta.url), 'utf8')
const tail = (p) => p.replace(/\n+$/, '').split('\n').slice(-32).join('\n')
const real = (name) => tail(fixture(name))

const RULE = '─'.repeat(80)
const FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · 1 feedback draft'
const CARD = [
  '╭──────────────────────────────────────────────────────────────────────────╮',
  '│ ✻ Product feedback drafted: Panel probe test draft, please ignore        │',
  '│ │ - What happened: harness test of the feedback draft panel, nothing to  │',
  '│ 1 to review · 2 to send · 0 to dismiss                                   │',
  '╰──────────────────────────────────────────────────────────────────────────╯',
]
const SURVEY = ['● How is Claude doing this session? (optional)', '  1: Bad    2: Fine   3: Good   0: Dismiss']

test('real captures: the feedback-draft card on 2.1.296, 2.1.300, and an 800-row pane (plain and -e)', () => {
  for (const f of [
    'panel-feedback-draft-296', 'panel-feedback-draft-296-ansi',
    'panel-feedback-draft-300', 'panel-feedback-draft-300-ansi',
    'panel-feedback-draft-tall', 'panel-feedback-draft-tall-ansi',
    'panel-feedback-draft-more-queued-296', // `0 to dismiss · +1 more queued`
  ]) {
    const p = parsePanel(real(f))
    assert.equal(p?.kind, 'feedback-draft', f)
    assert.deepEqual(p.actions, [{ id: 'review', key: '1' }, { id: 'dismiss', key: '0' }], f)
    assert.match(p.text, / drafted: /, f)
    assert.doesNotMatch(p.text, /to send|to dismiss/, `${f}: the key hints are the actions, not text`)
  }
  // The tall pane: a right-aligned `7% until auto-compact` notice between
  // the card and the box, the title truncated with `…`.
  assert.match(parsePanel(real('panel-feedback-draft-tall')).text, /^✻ Bug report drafted: Model mislabelled a warning/)
})

test('real capture: text typed under the card — the card is still found', () => {
  const p = real('panel-feedback-draft-typed-300-ansi')
  assert.equal(parsePanel(p)?.kind, 'feedback-draft')
  assert.equal(inputBoxText(p), 'sayhiback,nothingelse')
})

test('real capture: Dismiss raises "Turn off Claude-drafted feedback?" — only Esc (keep) is offered', () => {
  for (const f of ['panel-feedback-off-prompt-296', 'panel-feedback-off-prompt-296-ansi']) {
    const p = parsePanel(real(f))
    assert.equal(p?.kind, 'feedback-off-prompt', f)
    assert.equal(p.text, 'Turn off Claude-drafted feedback?')
    assert.deepEqual(p.actions, [{ id: 'keep', key: 'Escape' }], `${f}: "0 to turn off" is the operator's setting`)
  }
})

test('real capture: Review opens the "Feedback drafts" list (no input box) — Close (Esc) only', () => {
  const p = parsePanel(real('panel-feedback-review-list-300'))
  assert.equal(p?.kind, 'feedback-review')
  assert.deepEqual(p.actions, [{ id: 'close', key: 'Escape' }], '`d` (discard) and Enter (review → send) are not offered')
})

test('transcribed: the incident frame — notice row, stacked box — still reads the card', () => {
  // A transcribed frame: a notice row, and the box holding the stacked copies.
  const pane = [
    ...CARD,
    '                                         ✔ Update installed · Restart to apply',
    RULE,
    '❯ ⚙ **Automatic fleet update from the dashboard** — an OBSERVATION of',
    '  an agent you spawned, …',
    RULE,
    '  ⏵⏵ bypass permissions on (shift+tab to cycle) · 1 feedback draft',
  ].join('\n')
  assert.equal(parsePanel(pane)?.kind, 'feedback-draft')
})

test('synthetic (binary strings): the session survey — Dismiss only, never a rating', () => {
  const p = parsePanel(['some reply', '', '✻ Worked for 3s', '', ...SURVEY, '', RULE, '❯ ', RULE, FOOTER].join('\n'))
  assert.equal(p?.kind, 'survey')
  assert.equal(p.text, '● How is Claude doing this session? (optional)')
  assert.deepEqual(p.actions, [{ id: 'dismiss', key: '0' }])
})

test('the card states that are not idle: confirm-send offers Back, never 2; the error state offers Review', () => {
  const at = (hint) => [...CARD.slice(0, 3), `│ ${hint}`.padEnd(75) + '│', CARD[4], '', RULE, '❯ ', RULE, FOOTER].join('\n')
  const confirm = parsePanel(at('Send without reviewing (full draft + env, no transcript)? 2 to send · Esc to back'))
  assert.equal(confirm.kind, 'feedback-draft')
  assert.deepEqual(confirm.actions, [{ id: 'back', key: 'Escape' }])
  assert.match(confirm.text, /Send without reviewing \(full draft \+ env, no transcript\)\?$/)
  const err = parsePanel(at("✗ Couldn't send feedback. 1 to review & retry · Esc to dismiss"))
  assert.deepEqual(err.actions, [{ id: 'review', key: '1' }, { id: 'dismiss', key: 'Escape' }])
  const more = parsePanel(at('1 to review · 2 to send · 0 to dismiss · +2 more queued'))
  assert.deepEqual(more.actions, [{ id: 'review', key: '1' }, { id: 'dismiss', key: '0' }])
})

test('no panel: idle, busy, tip block, login dialog, queued-hint, residue panes', () => {
  // Synthetic frames in the measured shape (80 columns, the box's two rules,
  // its footer) — every one of them a pane a delivery must NOT park on.
  const box = (...inside) => [RULE, ...inside, RULE, FOOTER]
  const panes = {
    'idle at the prompt': ['● Done — the change is pushed.', '', '✻ Worked for 1m 52s', '                                         new task? /clear to save 102.2k tokens', ...box('❯ ')],
    'busy with a tip block': ['● Running 1 shell command…', '', '✽ Germinating… (50s · ↓ 2.8k tokens)', '  ⎿  Tip: Use Plan Mode to prepare for a complex request before making changes.', '     Press shift+tab twice to enable.', '', ...box('❯ ')],
    'login dialog (no box)': ['', "  Browser didn't open? Use the url below to sign in (c to copy)", '', 'https://claude.com/cai/oauth/authorize?code=true', '', '  Paste code here if prompted >', '', '  Esc to cancel'],
    'residue in the box': ['✻ Worked for 4s', '', ...box('❯ some text the operator typed', '  and its second row')],
    'a reply ending on a list': ['● Two options:', '  1. keep it', '  2. drop it', '', ...box('❯ ')],
  }
  for (const [name, rows] of Object.entries(panes)) assert.equal(parsePanel(rows.join('\n')), null, name)
  assert.equal(parsePanel(real('box-queued-hint-faint-ansi')), null, 'the faint queued-messages hint')
})

test('an agent QUOTING the card is not a panel — it is not directly above the box', () => {
  // This incident, discussed in a chat: the card's rows inside the agent's
  // output, then the turn's `✻ Worked for` line. A false panel would park every
  // delivery into the session, so anchoring must win over pattern-matching.
  const quoted = ['● The pane showed:', ...CARD.map((r) => '  ' + r), '', '✻ Worked for 12s · done 5:20 PM', '', RULE, '❯ ', RULE, FOOTER]
  assert.equal(parsePanel(quoted.join('\n')), null)
  // …nor a hint row as the last line of a longer prose block.
  const prose = ['', 'first line of a reply', 'second line', 'third line', 'and then: 1 to review · 2 to send · 0 to dismiss', '', RULE, '❯ ', RULE, FOOTER]
  assert.equal(parsePanel(prose.join('\n')), null)
  // …nor a dialog footer that only names Esc.
  assert.equal(parsePanel(['', 'Enter to select · Esc to cancel', '', RULE, '❯ ', RULE].join('\n')), null)
})

test('`2` is never an action key — not in the allow-list, not on any real panel', () => {
  assert.ok(!PANEL_SAFE_KEYS.has('2'))
  for (const f of fs.readdirSync(new URL('./fixtures/panes/', import.meta.url)).filter((n) => n.startsWith('panel-'))) {
    for (const a of parsePanel(real(f.replace(/\.txt$/, '')))?.actions || []) assert.ok(['0', '1', 'Escape'].includes(a.key), `${f}: ${a.key}`)
  }
})

/* ── Delivery under a panel ─────────────────────────────────────────────────
 * A Claude Code pane with the card, behaving as measured on 2.1.296/2.1.300:
 * the card's hook takes a DIGIT only when the input becomes exactly that digit
 * (then clears it); `0` dismisses and raises the turn-off prompt; `1` opens the
 * review list; `2` arms send-without-review and a second `2` SENDS. Esc closes
 * whatever panel is up. Recorded so the tests can assert what never happened.
 */
class PanelTui {
  constructor({ panel = 'card', content = '', takesDigits = true } = {}) {
    Object.assign(this, { panel, content, takesDigits, typed: [], keys: [], submitted: [], sent: false, turnedOff: false })
  }
  render() {
    if (this.panel === 'review') return tail(fixture('panel-feedback-review-list-300'))
    const above = this.panel === 'card' ? CARD : this.panel === 'off' ? ['Turn off Claude-drafted feedback? 0 to turn off · Esc to keep'] : this.panel === 'confirm' ? [...CARD.slice(0, 3), '│ Send without reviewing (full draft + env, no transcript)? 2 to send · Esc to back │', CARD[4]] : []
    const box = this.content ? `❯ ${this.content}` : '\x1b[39m❯ \x1b[2m/feedback\x1b[0m'
    return ['✻ Worked for 4s · done 5:20 PM', '', ...above, '', RULE, box, RULE, FOOTER].join('\n')
  }
  digit(d) {
    if (!this.takesDigits) return
    if (this.panel === 'card' && d === '0') this.panel = 'off'
    else if (this.panel === 'card' && d === '1') this.panel = 'review'
    else if (this.panel === 'card' && d === '2') this.panel = 'confirm'
    else if (this.panel === 'confirm' && d === '2') { this.sent = true; this.panel = null }
    else if (this.panel === 'off' && d === '0') { this.turnedOff = true; this.panel = null }
    else return
    this.content = ''
  }
  io() {
    return {
      readPane: async () => this.render(),
      typeText: async (t) => { this.typed.push(t); this.content += t; if (/^[0-9]$/.test(this.content)) this.digit(this.content); return { ok: true } },
      pressKey: async (k) => {
        this.keys.push(k)
        if (k === 'Escape') this.panel = this.panel === 'confirm' ? 'card' : null
        if (k === 'C-u') this.content = ''
        if (k === 'Enter' && this.content) { this.submitted.push(this.content); this.content = '' }
      },
      sleep: async () => {},
    }
  }
}

test('typeAndSubmit under the card: refused with the panel, NOTHING typed — on every retry', async () => {
  const tui = new PanelTui()
  for (let attempt = 0; attempt < 12; attempt++) {
    const r = await typeAndSubmit('⚙ **Automatic fleet update** — a note with 33s and 4560 in it', tui.io())
    assert.equal(r.ok, false)
    assert.equal(r.stage, 'panel')
    assert.ok(TUI_HOLD_STAGES.has(r.stage), 'a hold, not a failure: the queue parks')
    assert.equal(r.panel.kind, 'feedback-draft')
  }
  assert.deepEqual(tui.typed, [], 'not one keystroke reached the pane')
  assert.deepEqual(tui.keys, [])
  assert.equal(tui.content, '')
})

test('…and on the tall pane, too', async () => {
  const p = real('panel-feedback-draft-tall-ansi')
  const r = await typeAndSubmit('can you unlock the whole example.org domain?', {
    readPane: async () => p, typeText: async () => { throw new Error('must not type') }, pressKey: async () => { throw new Error('must not press') }, sleep: async () => {},
  })
  assert.equal(r.stage, 'panel')
})

test('Dismiss: types `0`, answers the turn-off prompt with Esc, and the queued text then delivers', async () => {
  const tui = new PanelTui()
  const r = await pressPanelAction('dismiss', tui.io())
  assert.equal(r.ok, true)
  assert.equal(r.panel, null)
  assert.deepEqual(tui.typed, ['0'])
  assert.deepEqual(tui.keys, ['Escape'], 'the turn-off prompt is KEPT, never a second 0')
  assert.equal(tui.turnedOff, false)
  const d = await typeAndSubmit('the parked question', tui.io())
  assert.equal(d.ok, true)
  assert.deepEqual(tui.submitted, ['the parked question'])
})

test('Review: types `1` and reports the review list it opened; Close leaves with Esc', async () => {
  const tui = new PanelTui()
  const r = await pressPanelAction('review', tui.io())
  assert.equal(r.ok, true)
  assert.equal(r.panel?.kind, 'feedback-review')
  const c = await pressPanelAction('close', tui.io())
  assert.equal(c.ok, true)
  assert.equal(c.panel, null)
  assert.deepEqual(tui.typed, ['1'])
  assert.deepEqual(tui.keys, ['Escape'])
})

test('"send" is not an action, from any state — and confirm-send only goes Back', async () => {
  for (const panel of ['card', 'confirm', 'off', 'review']) {
    const tui = new PanelTui({ panel })
    for (const a of ['send', '2']) {
      const r = await pressPanelAction(a, tui.io())
      assert.equal(r.ok, false, `${panel}/${a}`)
    }
    assert.equal(tui.sent, false)
    assert.deepEqual(tui.typed, [])
  }
  const tui = new PanelTui({ panel: 'confirm' })
  assert.equal((await pressPanelAction('dismiss', tui.io())).ok, false, 'confirm-send offers no dismiss')
  const back = await pressPanelAction('back', tui.io())
  assert.equal(back.ok, true)
  assert.equal(back.panel?.kind, 'feedback-draft', 'back on the idle card')
  assert.equal(tui.sent, false)
})

test('a digit needs an EMPTY box: a draft refuses; a digit the panel ignored is taken back out', async () => {
  const drafted = new PanelTui({ content: 'half a sentence' })
  const r = await pressPanelAction('dismiss', drafted.io())
  assert.equal(r.ok, false)
  assert.deepEqual(drafted.typed, [])
  assert.equal(drafted.content, 'half a sentence')
  const deaf = new PanelTui({ takesDigits: false })
  const d = await pressPanelAction('dismiss', deaf.io())
  assert.equal(d.ok, false, 'the panel did not respond')
  assert.equal(deaf.content, '', 'the stray 0 does not stay in the box')
})

test('no panel → nothing pressed', async () => {
  const tui = new PanelTui({ panel: null })
  const r = await pressPanelAction('dismiss', tui.io())
  assert.equal(r.ok, false)
  assert.deepEqual([...tui.typed, ...tui.keys], [])
})

/* ── Both executors, one rule ────────────────────────────────────────────────
 * The box (agent-local.mjs) and every bridge (agent-bridge/server.mjs) import
 * the detector and the key driver; neither may grow its own copy. ⚠️ A bridge
 * only picks this up when THAT machine runs scripts/restart-agent-bridge.sh —
 * until then it 404s POST /panel (the card shows the error) and delivers as
 * before.
 */
const src = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8')
const executors = { box: src('../src/agent-local.mjs'), bridge: src('../../agent-bridge/server.mjs') }
for (const [name, s] of Object.entries(executors)) {
  test(`${name}: imports the shared detector and driver — no copy`, () => {
    assert.match(s, /import \{ parsePanel \} from '[^']*pane-panel\.mjs'/)
    assert.match(s, /import \{[^}]*pressPanelAction[^}]*\} from '[^']*tui-input\.mjs'/)
    assert.doesNotMatch(s, /drafted: |to dismiss/, 'no panel pattern of its own')
  })

  test(`${name}: the queue PARKS under a panel — before the backoff ladder, never on it`, () => {
    const flush = s.slice(s.indexOf('async function flushQueued('))
    const park = flush.indexOf("holdQueue(s, { reason: 'panel', kind: panel.kind })")
    const hold = flush.indexOf('if (!d.ok && TUI_HOLD_STAGES.has(d.stage)) {')
    const ladder = flush.indexOf('s.deliverFailures = (s.deliverFailures || 0) + 1')
    assert.ok(park > 0 && hold > park && ladder > hold, 'panel check, then hold stages, then the backoff')
    assert.match(flush, /holdQueue\(s, null\)/, 'a delivery releases the hold')
  })

  test(`${name}: raw keys are refused while a panel is up; its actions go through panelAction`, () => {
    const keys = s.slice(s.indexOf('function keys('))
    assert.ok(keys.indexOf('parsePanel(await captureTail(s, TAIL_LINES))') < keys.indexOf("'send-keys', '-t', s.tmux, ...ks"))
    assert.match(s, /function panelAction\(\{ id, action \}\)[\s\S]{0,600}pressPanelAction\(action, \{/)
  })

  test(`${name}: a held send answers 409 with the reason — not the notDelivered 502`, () => {
    assert.match(s, /return holdResponse\(d\)/)
  })
}

test('the routes: POST /api/agents/panel forwards {id, action} only — never a key', () => {
  const routes = src('../src/agent-routes.mjs')
  const r = routes.slice(routes.indexOf("router.post('/api/agents/panel'"))
  assert.match(r.slice(0, 900), /callBridgeForId\('POST', '\/panel', \{ id, action \}/)
  assert.match(executors.bridge, /'\/panel': panelAction/)
})
