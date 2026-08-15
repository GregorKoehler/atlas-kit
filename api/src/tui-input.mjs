/* ── Typing text into an interactive TUI ────────────────────────────────────
 * Both executors deliver a prompt by TYPING it at the agent: `tmux send-keys
 * -t <pane> -l <payload>` writes those bytes to the pty exactly as if the
 * operator had pressed those keys. Claude Code's input therefore PARSES the
 * payload as key input — and an ESC (0x1b) inside it does not mean "the letter
 * escape", it opens a terminal escape SEQUENCE:
 *
 *   ESC [ … <final>   CSI  — consumed silently, self-delimiting (short)
 *   ESC ] … BEL/ST    OSC  — consumed up to its terminator, which is UNBOUNDED
 *
 * That last one is the bug this module exists for. Measured live
 * against a real Claude Code 2.1.227 pane: 427 B in, 77 chars land — an OSC-8
 * hyperlink introducer (`ESC ] 8 ; id=…;file:///…`) with no BEL in the payload
 * ate 350 characters of the operator's own sentence, and the residue was then
 * submitted by the trailing Enter. In the incident this fixes, a 957-char
 * prompt was delivered (the audit log records `action:"prompt" len:957`) and
 * the session recorded a 60-char user turn 23 ms earlier —
 * `Compacted (ctrl+o to see full summary)</local-command-stdout>"`, i.e. the
 * ANSI-STRIPPED tail of a transcript line that had been pasted in. The
 * operator's words were nowhere, and the model answered the residue. Terminal
 * escapes are exactly
 * what a paste of rendered terminal/chat-view output carries, invisibly.
 *
 * So: strip escape sequences BEFORE typing, and never lose a printable
 * character doing it. The rules below only ever remove bytes the operator
 * could not see anyway.
 *
 * ⚠️ The bound on OSC/DCS is load-bearing, and it is where this differs from a
 * terminal on purpose. A terminal swallows to the terminator however far away
 * it is; here a sequence that does not terminate within OSC_MAX_CHARS is NOT a
 * sequence — its lone ESC is dropped and every following character is KEPT as
 * text. Ugly beats lost: a stray `]8;id=…` in a message is visible and the
 * operator can read past it, a swallowed sentence is silent and gone. This is
 * also the only case that can arise from a partial copy, which is the case that
 * actually happened.
 */
import { inputBoxBounds } from './pane-busy.mjs'

/* ── The read-back gate's own regression (this file's second half) ──
 * The gate shipped head-anchored against the WHOLE pane, and that was wrong
 * about where the typed text goes. Measured live against Claude Code
 * 2.1.227 on 80-column panes at heights 24/40/80:
 *
 *   • the input box CAPS its height at 7-8 rows and SCROLLS internally — a
 *     672-char note renders as its LAST 7 rows, ~413 visible chars, and its
 *     HEAD is not on the pane at all. Head-anchored ⇒ refused, every time.
 *   • above ~900 chars Claude Code collapses the box to `[Pasted text #N]`,
 *     which the gate already accepts.
 *   So the gate refused EVERY payload in a ~500-900 char window, whatever it
 *   contained. The incident this fixes is exactly that: 24 consecutive
 *   `deliver-mangled` refusals at 3 s intervals, `len:678 stripped:0` — no
 *   escapes involved — against a live Atlas chat.
 *   • and `C-u` kills ONE DISPLAY ROW, not the logical line. `clearInputKeys`
 *     counted LITERAL newlines (0 here) → 8 presses against a 9-10 row box, so
 *     each refusal left a row of the payload's HEAD behind and the next attempt
 *     typed 678 more chars onto it. Measured residue after each refusal:
 *     65 → 134 → 198 → 267 chars, concatenated mid-word — unbounded. That is
 *     the operator's "~25 truncated copies of the header" verbatim, and it ends
 *     in a submit because a box full of residue eventually reads back as landed.
 *
 * So the gate now reads the INPUT BOX rather than the pane, and clearing is
 * VERIFIED rather than counted (clearInputBox below). One property carries the
 * whole design: THE BOX IS EMPTY BEFORE WE TYPE. Without it a box holding
 * residue+payload is indistinguishable from a correctly scrolled payload —
 * both show the payload's tail in a full box — which is precisely how the
 * accumulation ended in a submit.
 */

// Longest run an OSC/DCS may claim before we stop believing it is one. Real
// ones are short (an OSC-8 hyperlink target is a URL); 256 clears them all.
const OSC_MAX_CHARS = 256
// How much of a delivered payload has to be readable back off the pane for the
// delivery to count as landed, in the FALLBACK path only (see deliveryLanded)
// — non-whitespace characters from the FRONT, where the swallow bites.
const HEAD_CHARS = 32
// Rows the box must be showing before "the head isn't visible" is read as
// SCROLLED rather than SWALLOWED. Measured capacity is 7-8 rows; a mangled
// delivery leaves a SHORT residue (the incident's was 60 chars = 1 row), so
// this is the axis that separates the two. Conservative on the low side: a
// false accept is today's behaviour, a false reject withholds a real message.
const BOX_SCROLLED_MIN_ROWS = 5
// …and the payload size above which we stop asking. Both executors read the
// pane back with captureTail(TAIL_LINES = 32) — 32 rows of an 80-column grid,
// so ~2.5 KB of text at most, and a longer prompt's HEAD has scrolled out of
// that window before we could look for it. Verifying those would reject real
// deliveries (an orchestrator brief runs 2-5 KB), so they are typed exactly as
// they always were. Sanitising, which is the actual fix, applies at every size.
export const TUI_VERIFY_MAX_CHARS = 1500
// The pane LAGS the keystrokes, so one look is not enough: measured on a live
// pane, an immediate capture saw the typed text in 2 of 8 deliveries and a
// capture 100 ms later in 8 of 8. Callers look up to TUI_VERIFY_TRIES times,
// sleeping this long between — the happy path still exits on the first look.
export const TUI_VERIFY_SETTLE_MS = 150
export const TUI_VERIFY_TRIES = 3
// The key that empties the box, and the bound on how many times we press it.
// Ctrl-U (kill to line start) rather than Ctrl-C for a safety reason, not an
// ergonomic one: Ctrl-C on an ALREADY-EMPTY box arms Claude Code's exit confirm
// and a second one inside that window exits the agent — and "empty box" is
// exactly the state this loop converges on. Ctrl-U on an empty box is a
// measured no-op. 40 presses clears a box five times its measured capacity.
export const TUI_CLEAR_KEY = 'C-u'
export const TUI_CLEAR_MAX_PRESSES = 40
// `0`/`false`/`no`/`off` drops the whole read-back apparatus — the pre-type
// clear and the post-type verify — back to the unconditional type-then-Enter: type, then
// Enter, unconditionally. Sanitising is NOT covered by this switch; it is the
// actual fix for the swallow and it can only ever remove invisible bytes.
// Each machine sets it in its own env (a bridge restarts separately from the
// box), exactly like AGENT_SPINNER_WITNESS in pane-busy.mjs.
export const TUI_VERIFY = !/^(0|false|no|off)$/i.test(process.env.AGENT_TUI_VERIFY || '1')

// Order matters: OSC/DCS first (their payload may contain `[`), then CSI, then
// whatever ESC bytes are left over as malformed/partial — those lose only the
// ESC itself. Finally the other C0 controls, which the TUI would swallow or act
// on; \n and \t survive (a newline is inserted as a newline, see the callers).
const OSC = new RegExp(`\\x1b\\][\\s\\S]{0,${OSC_MAX_CHARS}}?(?:\\x07|\\x1b\\\\)`, 'g')
const DCS = new RegExp(`\\x1b[P^_][\\s\\S]{0,${OSC_MAX_CHARS}}?\\x1b\\\\`, 'g')
const CSI = /\x1b\[[0-9;:<=>?]{0,32}[ -/]{0,8}[@-~]/g
const C0 = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/**
 * The bytes it is safe to type at a TUI, for the text a caller wants delivered.
 * Pure. Returns the payload unchanged when there is nothing to strip, so an
 * ordinary prompt is byte-identical to what this path always sent.
 */
export function sanitizeForTyping(text) {
  const s = typeof text === 'string' ? text : ''
  if (!s) return ''
  return s
    .replace(/\r\n?/g, '\n') // CR / CRLF from a pasted excerpt → one newline
    .replace(OSC, '')
    .replace(DCS, '')
    .replace(CSI, '')
    .replace(C0, '')
}

const SGR = /\x1b\[[0-9;:]*m/g
const stripSgr = (s) => String(s).replace(SGR, '')
const nows = (s) => String(s).replace(/\s+/g, '')

/**
 * The box's visible text, with Claude Code's FAINT placeholder removed.
 *
 * An empty box is not blank: idle it renders a rotating hint (`Try "how do I
 * log an error?"`), busy it renders nothing but the `❯` marker. The hint is
 * drawn with SGR 2 and typed text never is (measured on a live `-e` capture),
 * which is the same property the transcript view already relies on to render
 * it muted — so dropping faint runs is what tells "empty" from "residue".
 * A capture taken WITHOUT `-e` simply has no faint runs to drop, so this
 * degrades to the raw text rather than misreading it.
 */
function unfaint(row) {
  let out = '', faint = false, last = 0, m
  const re = new RegExp(SGR.source, 'g')
  while ((m = re.exec(row))) {
    if (!faint) out += row.slice(last, m.index)
    for (const code of m[0].slice(2, -1).split(';')) {
      if (code === '2') faint = true
      else if (code === '' || code === '0' || code === '22') faint = false
    }
    last = re.lastIndex
  }
  if (!faint) out += row.slice(last)
  return out
}

/** The box's content rows (between its two rules), or null if it isn't on screen. */
function boxRows(pane) {
  const raw = String(pane || '').split('\n')
  const b = inputBoxBounds(raw.map(stripSgr))
  if (!b || b.bottom <= b.top) return null
  return raw.slice(b.top + 1, b.bottom)
}

/**
 * What the operator/agent would see sitting in the input box right now —
 * whitespace-collapsed, `❯` marker and faint placeholder stripped. `null` when
 * the box isn't on the capture at all. Empty string = the box is empty.
 */
export function inputBoxText(pane) {
  const rows = boxRows(pane)
  if (!rows) return null
  return nows(rows.map(unfaint).join(' ').replace(/^\s*[❯>]\s?/, ''))
}

/**
 * Did what we typed actually land in the input box? Read BEFORE pressing Enter,
 * so a mangled buffer is refused instead of submitted.
 *
 * Read the BOX, not the pane — the box is where the text is, it caps at 7-8
 * rows and scrolls, and a whole-pane grep also matches our own leftovers
 * elsewhere on screen. Whitespace is dropped from both sides: the pane is a
 * fixed 80-column grid that wraps the box, so the text is the same and the line
 * breaks are not.
 *
 * ⚠️ CALLER CONTRACT: the box was verified EMPTY before typing (clearInputBox).
 * Everything below leans on it — a box holding residue+payload shows the
 * payload's tail in a full box, exactly like a correctly scrolled one, and no
 * amount of reading can separate them.
 *
 * Three deliberate accepts, all the benign direction (a false ACCEPT is the
 * pre-#540 behaviour; a false REJECT withholds a real message forever):
 *  - a collapsed paste placeholder (`[Pasted text #1]`) hides the text Claude
 *    Code is holding, so there is nothing to compare;
 *  - no box on the capture — fall back to the old whole-pane head rule;
 *  - an empty payload has no head.
 */
export function deliveryLanded(pane, payload) {
  const want = nows(payload)
  if (!want) return true
  const p = String(pane || '')
  if (/\[Pasted text #\d+/.test(stripSgr(p))) return true
  const rows = boxRows(p)
  if (!rows) return nows(stripSgr(p)).includes(want.slice(0, HEAD_CHARS))
  const got = inputBoxText(p)
  if (!got) return false
  // Whole payload visible: a FULL equality, which catches a bite taken out of
  // the front, the middle or the tail alike — strictly stronger than the head.
  if (got === want) return true
  // Otherwise the head is off-screen. That is the SCROLLED case only if the box
  // is showing the payload's tail AND is deep enough to be at its capacity; the
  // swallow leaves a suffix too, but a short one (the incident's: 1 row).
  return want.endsWith(got) && rows.length >= BOX_SCROLLED_MIN_ROWS
}

/**
 * Empty the input box and VERIFY it, for a caller about to type (never type
 * onto someone else's text) and for one that typed something it will not submit
 * (text we decline to send STAYS in the box and the next delivery concatenates
 * onto it — the accumulation above).
 *
 * Counting presses is what broke: `C-u` kills one DISPLAY ROW, so the count has
 * to follow the WRAPPED height of whatever is in the box, which the caller does
 * not know. So press and LOOK, up to `max` times. IO is injected so both
 * executors share one implementation and the loop is testable without tmux.
 *
 * ⚠️ SETTLE between the press and the look. The pane lags the keystrokes — the
 * same lag TUI_VERIFY_SETTLE_MS exists for — and reading too early returns the
 * PRE-press frame, which is byte-identical to the last one and reads as the
 * fixpoint below. Measured: without the settle the loop stopped after 1-2
 * presses and left ~420 chars in the box, i.e. it reproduced the very
 * accumulation it is here to prevent. `settle` is injected so the tests can
 * run the loop without paying it.
 *
 * Fails OPEN in the two states it cannot act on, because a gate that blocks
 * every delivery is worse than the bug it guards:
 *  - the box isn't on the capture (`seen:false`) — nothing to clear;
 *  - the box shows text that `C-u` does not change (`fixpoint:true`). Ctrl-U
 *    always removes a row of real content, so an unmovable row is chrome we
 *    don't recognise (a placeholder rendered without SGR 2, say), not text.
 */
export async function clearInputBox({ readPane, pressClear, settle = defaultSettle, max = TUI_CLEAR_MAX_PRESSES }) {
  let prev = null
  for (let presses = 0; ; presses++) {
    const pane = await readPane()
    const rows = boxRows(pane)
    if (!rows) return { ok: true, seen: false, presses }
    const text = inputBoxText(pane)
    if (!text) return { ok: true, seen: true, presses }
    const shown = rows.join('\n')
    if (prev !== null && shown === prev) return { ok: true, seen: true, presses, fixpoint: true }
    if (presses >= max) return { ok: false, seen: true, presses, residue: text.length }
    prev = shown
    await pressClear()
    await settle()
  }
}

const defaultSettle = () => new Promise((r) => setTimeout(r, TUI_VERIFY_SETTLE_MS))

export const TUI_INPUT_HEAD_CHARS = HEAD_CHARS
