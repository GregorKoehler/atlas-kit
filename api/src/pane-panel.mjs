/* ------------------------------------------------------------------ *
 * pane-panel.mjs — Claude Code's numbered-key PANELS above the input box,
 * read off the live pane, so delivery can refuse to type under one and the
 * card can offer its safe keys as buttons.
 *
 * The incident: an agent called its `SendFeedback` tool and Claude Code
 * 2.1.296 parked a feedback-draft card above the input box —
 *
 *   ╭──────────────────────────────────────────────────────────────────────────╮
 *   │ ✻ Bug report drafted: Model mislabelled a log line as an error…          │
 *   │ │ - What happened: Asked to summarise a log, the model …                 │
 *   │ 1 to review · 2 to send · 0 to dismiss                                   │
 *   ╰──────────────────────────────────────────────────────────────────────────╯
 *
 * — and for five hours every delivery into that chat that was not a short
 * operator line failed its read-back: dozens of `deliver-mangled`, all
 * `presses:0, emptied:true, boxSeen:false`. `emptied` was a lie (the clear
 * failed OPEN on a box it could not see), each refusal left its text in the
 * box, the queue and the client retry typed the next copy onto it, and stacks
 * of 4-20 copies were later submitted as single turns. (A fresh 2.1.296 pane
 * with the same card took the same note cleanly, so WHY the read-back missed
 * there is not pinned down; what is pinned is that nothing should be typed
 * under the card at all.)
 *
 * The card is driven by single DIGITS typed into an EMPTY input box (Claude
 * Code's digit hook fires when the input value becomes exactly one valid
 * digit; it then clears the input). Measured on 2.1.296 and 2.1.300:
 *   • `0` dismisses — and may raise a second panel, "Turn off Claude-drafted
 *     feedback? 0 to turn off · Esc to keep", where another `0` would switch
 *     the feature off for the operator. Esc keeps it.
 *   • `1` opens the "Feedback drafts" list (no input box; Esc closes it).
 *   • `2` arms "Send without reviewing…? 2 to send", and a second `2` SENDS the
 *     draft to Anthropic. Sending feedback is the operator's decision, made in
 *     the terminal — so `2` is never an action here, by construction: actions
 *     are parsed from the panel's own hint row and filtered to SAFE_KEYS and
 *     SAFE_ACTIONS below, and neither admits it.
 * Dismiss only hides the card for the session: the draft file stays in
 * ~/.claude/feedback/drafts for /feedback.
 *
 * Also covered, from the installed binary's strings: the session-quality
 * survey ("How is Claude doing this session? (optional)" over
 * `1: Bad  2: Fine  3: Good  0: Dismiss`) and any other panel that renders the
 * same `<digit> to <action>` hint row. Only Dismiss is offered on the survey —
 * a rating is feedback too.
 *
 * ⚠️ ANCHORED, not grepped. A panel counts only where Claude Code draws it:
 * directly above the input box's top rule, with at most PANEL_GAP_ROWS blank
 * or right-aligned notice rows between (`7% until auto-compact`, `ctrl+g to
 * edit in Vim`, `✔ Update installed · Restart to apply`). An agent QUOTING the
 * card — this very file's incident, discussed in a chat — prints it inside its
 * output, followed by a `✻ Worked for …` line, so it is never adjacent. A
 * false panel PARKS every delivery into that session (the stuck direction), so
 * this must err towards "no panel".
 *
 * Shared by agent-local.mjs and agent-bridge/server.mjs (one rule, both
 * executors) through tui-input.mjs. Pure + IO-free: api/test/pane-panel.test.mjs,
 * on real captures (fixtures/panes/panel-*.txt).
 * ------------------------------------------------------------------ */
import { inputBoxBounds } from './pane-busy.mjs'

// OSC (BEL or ST), CSI, and the 2-byte escapes — same rule as menu.mjs.
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g
const BLANK = /^\s*$/
// A right-aligned status notice between the panel and the box (measured at
// columns 41-57 on an 80-column pane).
const NOTICE = /^\s{20,}\S/
const PANEL_GAP_ROWS = 3
// The tallest card measured is 7 rows (border, title, 3 preview rows, hint,
// border); room for the `+N more queued` variant and a longer preview.
const PANEL_ROWS_MAX = 12
// An unbordered panel is one or two rows (the turn-off prompt; the survey's
// question over its options). Anything taller is conversation.
const PLAIN_PANEL_ROWS_MAX = 2

// `<key> to <action>` chords on a hint row: `1 to review · 2 to send · 0 to
// dismiss`, `0 to turn off · Esc to keep`, `1 to review & retry · Esc to dismiss`.
const CHORD = /(?:^|[\s·?])(Esc|[0-9]) to ([a-z][a-z &]*?)(?=\s*·|\s*$|\s+\+\d)/g
// `<digit>: <Label>` options on a survey row: `1: Bad    2: Fine   0: Dismiss`.
const OPTION = /(?:^|\s)([0-9]): ([A-Z][a-z]+)/g

// The ONLY keys an action may press, and the only actions offered. `2` is in
// neither, on purpose (see the header): it sends feedback to Anthropic.
const SAFE_KEYS = new Set(['0', '1', 'Escape'])
const SAFE_ACTIONS = new Set(['dismiss', 'review', 'keep', 'back', 'close'])

const unbox = (line) => line.replace(/^\s*[│┃]\s?/, '').replace(/\s?[│┃]\s*$/, '').trimEnd()

function hintActions(rows) {
  const out = []
  const add = (id, key) => {
    if (SAFE_ACTIONS.has(id) && SAFE_KEYS.has(key) && !out.some((a) => a.id === id)) out.push({ id, key })
  }
  let hints = 0
  for (const row of rows) {
    const chords = [...row.matchAll(CHORD)]
    const opts = [...row.matchAll(OPTION)]
    // A hint row needs a DIGIT key: `Esc to cancel` alone is every dialog's
    // footer, and a choice menu is menu.mjs's business, not this module's.
    if (chords.some(([, key]) => key !== 'Esc') || opts.length >= 2) hints++
    for (const [, key, action] of chords) add(action.split(/\s/)[0], key === 'Esc' ? 'Escape' : key)
    if (opts.length >= 2) for (const [, key, label] of opts) add(label.toLowerCase(), key)
  }
  return hints ? out : null
}

function kindOf(text) {
  if (/Turn off Claude-drafted feedback\?/.test(text)) return 'feedback-off-prompt'
  if (/ drafted: |Send without reviewing|\b2 to send\b/.test(text)) return 'feedback-draft'
  if (/How (?:is|was) Claude|\b0: Dismiss\b/.test(text)) return 'survey'
  return 'panel'
}

// The block of rows directly above the box's top rule, or null.
function blockAbove(rows, top) {
  let i = top - 1
  for (let gap = 0; i >= 0 && gap < PANEL_GAP_ROWS && (BLANK.test(rows[i]) || NOTICE.test(rows[i])); gap++) i--
  if (i < 0 || BLANK.test(rows[i])) return null
  const end = i
  if (/^\s*╰/.test(rows[end])) {
    for (let j = end - 1; j >= 0 && end - j < PANEL_ROWS_MAX; j--) if (/^\s*╭/.test(rows[j])) return rows.slice(j + 1, end)
    return null
  }
  while (i >= 0 && !BLANK.test(rows[i]) && end - i < PLAIN_PANEL_ROWS_MAX) i--
  // A plain block must be bounded by a blank row (the panel's top margin):
  // anything longer is conversation, not a panel.
  if (i >= 0 && !BLANK.test(rows[i])) return null
  return rows.slice(i + 1, end + 1)
}

// The "Feedback drafts" list `1` opens: full-width, no input box, its key hint
// on the last row.
function reviewList(rows) {
  const lines = rows.filter((r) => !BLANK.test(r))
  if (!lines.length || !/^\s*Enter to review · d to discard · Esc to close\s*$/.test(lines[lines.length - 1])) return null
  if (!lines.slice(-30).some((r) => /^\s*Feedback drafts\s*$/.test(r))) return null
  return { kind: 'feedback-review', text: 'Feedback drafts (review list)', actions: [{ id: 'close', key: 'Escape' }] }
}

/**
 * The panel blocking the session's input, or null.
 *
 * Returns `{ kind, text, actions }`: `kind` ∈ feedback-draft · feedback-off-prompt
 * · feedback-review · survey · panel; `text` is what the panel says, minus its
 * key-hint rows (the actions ARE those keys); `actions` is `[{ id, key }]`, ids
 * from SAFE_ACTIONS, keys from SAFE_KEYS — possibly empty (a panel whose only
 * keys are unsafe still blocks; the operator answers it in the terminal).
 */
export function parsePanel(pane) {
  const rows = String(pane || '').replace(ANSI, '').split('\n').map((r) => r.trimEnd())
  const box = inputBoxBounds(rows)
  if (!box || box.bottom <= box.top) return reviewList(rows)
  const block = blockAbove(rows, box.top)
  if (!block) return null
  const inner = block.map(unbox)
  const actions = hintActions(inner)
  if (!actions) return null
  // The key hints are the actions, so they leave the text — but the words in
  // front of them stay (`Turn off Claude-drafted feedback?` shares its row).
  const text = inner
    .filter((r) => [...r.matchAll(OPTION)].length < 2)
    .map((r) => r.replace(CHORD, '').replace(/\s*·\s*\+\d+ more queued/, '').replace(/[\s·]+$/, '').replace(/^\s*[│┃]\s?/, '').trim())
    .filter(Boolean)
    .join('\n')
  return { kind: kindOf(inner.join('\n')), text, actions }
}

export const PANEL_SAFE_KEYS = SAFE_KEYS
