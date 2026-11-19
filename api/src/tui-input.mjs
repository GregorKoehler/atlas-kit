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
import { parsePanel, PANEL_SAFE_KEYS } from './pane-panel.mjs'

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
// deliveries (an orchestrator brief runs 2-5 KB), so for those the read-back
// only asks that SOMETHING arrived in the box (typeAndSubmit). Sanitising and the
// post-Enter submit check apply at every size.
export const TUI_VERIFY_MAX_CHARS = 1500
// The pane LAGS the keystrokes, so one look is not enough: measured on a live
// pane, an immediate capture saw the typed text in 2 of 8 deliveries and a
// capture 100 ms later in 8 of 8. clearInputBox settles this long between a
// press and the next look.
export const TUI_VERIFY_SETTLE_MS = 150
// …and the read-backs (typed text landed? Enter submitted?) look again on a
// BACKOFF, ~1.5 s in all. It used to be 3 looks × 150 ms, and a busy or
// repainting pane outlasts that: in the field, `deliver-mangled` lines in the
// audit log were mostly SINGLE misses whose identical payload landed on a
// manual retry seconds later — pane lag, not a mangled buffer. A healthy pane
// still answers on the first or second look (measured 60-190 ms), so only a
// genuinely slow one pays the longer wait.
export const TUI_VERIFY_BACKOFF_MS = [100, 150, 250, 400, 600]
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

/* ── Invisible Unicode ──────────────────────────────────────────────────────
 * One chat refused every send with 502 for 15 minutes, and before that LOST a
 * 2883-char paste four times while the audit log said `ok: true`. The text had
 * been pasted out of a web admin console that wraps values in U+200E
 * LEFT-TO-RIGHT MARK (50 in one paste). Measured against Claude Code 2.1.287 in
 * a throwaway pane:
 * on Enter, Claude Code REMOVES invisible characters itself and shows
 * "Removed N invisible characters · review and press Enter to send" — so that
 * Enter submits NOTHING. A short payload failed our read-back first (the box
 * renders the marks as nothing, the payload still held them → 502); a long one
 * skipped the read-back, so its Enter was eaten and nobody noticed.
 *
 * So strip them BEFORE typing. The set is what that pane held a send on, one
 * class at a time — it is \p{Default_Ignorable_Code_Point} (bidi marks and
 * embeddings/isolates, ZWSP/ZWNJ/ZWJ, word joiner and the invisible operators,
 * BOM, soft hyphen, CGJ, variation selectors, tag characters, Hangul fillers,
 * Mongolian FVS/MVS, the Khmer inherent vowels, the invisible musical symbols)
 * plus the interlinear annotation marks U+FFF9-FFFB — with the three emoji
 * exceptions Claude Code itself keeps, because they are not invisible there:
 * a ZWJ joining two pictographs (👨‍👩‍👧), U+FE0E/FE0F after a pictograph (❤️)
 * or inside a keycap (1️⃣), and the tag run of a subdivision flag (🏴󠁧󠁢󠁥󠁮󠁧󠁿).
 * A dangling ZWJ after an emoji is still held by Claude Code, so it goes.
 * U+2028/2029 held the send WITHOUT the banner; they become the newline they
 * mean. Not held, normalised anyway (spec): non-ASCII spaces (NBSP, narrow
 * NBSP…) become a space, NFD (macOS) becomes NFC, and a Private Use glyph — a
 * Word/Wingdings bullet (U+F0A7) or an icon-font glyph (U+E70F) that renders
 * as tofu — becomes `•` at a line start, where it was a bullet, and is dropped
 * elsewhere, where it was an icon.
 */
const INVISIBLE = /(?<=[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F])\u200D(?=\p{Extended_Pictographic})|(?<=\p{Extended_Pictographic})[\uFE0E\uFE0F]|(?<=[#*0-9])\uFE0F(?=\u20E3)|(?<=\u{1F3F4}[\u{E0020}-\u{E007E}]*)[\u{E0020}-\u{E007F}]|([\p{Default_Ignorable_Code_Point}\uFFF9-\uFFFB])/gu
const LINE_SEP = /[\u2028\u2029]/g
const ODD_SPACE = /(?! )\p{Zs}/gu
const PUA_BULLET = /(^|\n)([ \t]*)\p{Co}/gu
const PUA = /\p{Co}/gu

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
    .normalize('NFC')
    .replace(LINE_SEP, '\n')
    .replace(INVISIBLE, (m, drop) => (drop ? '' : m))
    .replace(ODD_SPACE, ' ')
    .replace(PUA_BULLET, '$1$2•')
    .replace(PUA, '')
}

const SGR = /\x1b\[[0-9;:]*m/g
const stripSgr = (s) => String(s).replace(SGR, '')
// The comparison form of a payload or of the box: whitespace dropped (the box is
// a wrapped 80-column grid), NFC, and every invisible/PUA code point dropped —
// on BOTH sides, so one that survives sanitising (or a box that renders a mark
// as nothing) can never be the difference between "landed" and "mangled".
const nows = (s) => String(s).normalize('NFC').replace(/[\p{Default_Ignorable_Code_Point}\uFFF9-\uFFFB\p{Co}]/gu, '').replace(/\s+/g, '')

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
 * ⚠️ So `ok: true` is "nothing more to do", NOT "the box is empty" — reporting
 * it as `emptied` is exactly the lie typeAndSubmit used to tell (boxEmptied).
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

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))
const defaultSettle = () => sleepMs(TUI_VERIFY_SETTLE_MS)

// Look at the pane until `ok(pane)` holds, on the TUI_VERIFY_BACKOFF_MS
// schedule. The happy path returns on the first look, without sleeping.
async function settled(readPane, ok, sleep) {
  for (let i = 0; ; i++) {
    if (ok(await readPane())) return true
    if (i >= TUI_VERIFY_BACKOFF_MS.length) return false
    await sleep(TUI_VERIFY_BACKOFF_MS[i])
  }
}

/* ── Look BEFORE typing ──────────────────────────────────────────────────────
 * The feedback-draft incident (pane-panel.mjs carries it): a panel sat over
 * an Atlas chat for five hours, and every delivery that failed its read-back
 * left its text in the box — `clearInputBox` fails OPEN on a box it cannot see,
 * and `emptied: post.ok` reported that as emptied. The next attempt (queue
 * flush, the client's one retry) typed onto it; ~10 copies of the operator's
 * question and several fleet notes went in as one turn when the panel closed.
 *
 * So the box is no longer cleared on the way IN — the only text that can be in
 * it is somebody's (an operator typing in the terminal, Claude Code holding a
 * send) or a previous failure of ours, and in neither case is typing on top of
 * it, or silently wiping it, the right answer. Instead, before a key is typed:
 *   • a PANEL above the box (pane-panel.mjs)  → stage 'panel'
 *   • no input box on the capture             → stage 'no-box'
 *   • a box that already holds text           → stage 'box-not-empty'
 * Each refuses with NOTHING typed (TUI_HOLD_STAGES): the caller answers 409
 * with the reason, and the queue PARKS instead of climbing the backoff ladder.
 * `clearDraft` is the one way past the third — an operator's explicit "clear
 * the input & send", and the lifecycle prompts (ship, close/recap, the ingest
 * hand-off) that always cleared first and would otherwise wedge on a draft.
 *
 * And on the way OUT, `emptied` now means what it says: the box was SEEN, and
 * seen empty (boxEmptied). A box we could not see is reported `emptied: false`
 * — and the next attempt then refuses at 'no-box'/'box-not-empty' rather than
 * stacking a second copy. That is the whole no-stacking guarantee: the box is
 * verified empty before every keystroke, so text can never be appended to.
 */
export const TUI_HOLD_STAGES = new Set(['panel', 'no-box', 'box-not-empty'])
const boxEmptied = (c) => c.ok && c.seen && !c.fixpoint

// The 409 both executors answer a held delivery with: `error` is the stage
// (the client keys its wording and its buttons on it), `panel` what is open.
export function holdResponse(d) {
  return { status: 409, ok: false, error: d.stage, detail: d.error, ...(d.panel ? { panel: d.panel } : {}), ...(d.residue ? { boxChars: d.residue } : {}) }
}

/**
 * Type `payload` at the agent and submit it — the one delivery both executors
 * run (agent-local.mjs and agent-bridge/server.mjs differ only in HOW they
 * reach tmux, which is the injected IO):
 *   readPane()      → the box-bearing tail of the pane, SGR kept (`-e`)
 *   typeText(text)  → `send-keys -l text`, resolving { ok, stderr }
 *   pressKey(key)   → `send-keys key`
 *
 * Sanitise → no panel, a box on screen, the box EMPTY (see above) → type →
 * read back (the whole text up to TUI_VERIFY_MAX_CHARS, "something arrived"
 * past it) → Enter → verify it SUBMITTED. Returns { ok: true, stripped,
 * cleared }, or { ok: false, stage, error, … }: a TUI_HOLD_STAGES stage typed
 * nothing; 'mangled'/'unsubmitted' typed and then cleared, and say whether the
 * box was really left empty (`emptied`); 'box-stuck' is a `clearDraft` that
 * could not empty the box. No stage but 'type' submitted anything — which is
 * what the callers' `notDelivered` 502 promises the client.
 *
 * The submit check is the silent-loss fix: the pre-Enter read-back only runs
 * on payloads that fit the capture, so a long paste whose Enter was eaten
 * (Claude Code's invisible-character guard — see INVISIBLE above) was logged
 * `ok: true` with the text still sitting in the box. Submitting empties the
 * box at once — 60-190 ms on a live pane, a busy agent included (the message
 * queues) — so a box that still holds text after the backoff was NOT
 * submitted, at any length.
 */
export async function typeAndSubmit(payload, { readPane, typeText, pressKey, sleep = sleepMs, clearDraft = false }) {
  const safe = sanitizeForTyping(payload)
  const stripped = payload.length - safe.length
  const io = { readPane, pressClear: () => pressKey(TUI_CLEAR_KEY), settle: () => sleep(TUI_VERIFY_SETTLE_MS) }
  let cleared = 0
  if (TUI_VERIFY) {
    const pre = await readPane()
    const panel = parsePanel(pre)
    if (panel) return { ok: false, stage: 'panel', stripped, panel, error: `a Claude Code panel is open in the session (${panel.kind}) — nothing was typed` }
    const box = inputBoxText(pre)
    if (box === null) return { ok: false, stage: 'no-box', stripped, error: "the session's input box is not on screen — nothing was typed" }
    if (box && !clearDraft) return { ok: false, stage: 'box-not-empty', stripped, residue: box.length, error: 'the input box already holds unsent text — nothing was typed' }
    if (box) {
      const c = await clearInputBox(io)
      if (!boxEmptied(c)) return { ok: false, stage: 'box-stuck', stripped, presses: c.presses, residue: c.residue, error: 'input box is not empty and could not be cleared (nothing typed)' }
      cleared = c.presses
    }
  }
  const t = await typeText(safe)
  if (!t.ok) return { ok: false, stage: 'type', stripped, error: String(t.stderr || '').slice(0, 500) || 'send-keys failed' }
  // A payload past the read-back cap cannot be compared (its head scrolls out
  // of the capture), but it must at least SHOW UP before Enter: the box was just
  // verified empty, so a look that beats the pane's repaint sees that same empty
  // box — and would then read as "submitted" after the Enter. Measured: a
  // 2.6 KB paste, Enter, and the first post-Enter look at 32 ms was still the
  // pre-typing frame. No box on the capture (null) passes, as everywhere here.
  const landed = safe.length <= TUI_VERIFY_MAX_CHARS ? (p) => deliveryLanded(p, safe) : (p) => inputBoxText(p) !== ''
  // Both refusals SETTLE once before clearing. The clear's first look is
  // immediate, and text that arrives late (the read-back gave up on a lagging
  // pane) then reads as an empty box: `presses: 0`, and the text stays behind
  // — the single misses seen in the field have exactly that shape.
  if (TUI_VERIFY && !(await settled(readPane, landed, sleep))) {
    await sleep(TUI_VERIFY_SETTLE_MS)
    const post = await clearInputBox(io)
    // `boxSeen: false` = no input box on screen at all — a dialog owns the pane
    // (e.g. a session parked in `/login`) — and then nobody can say the box
    // was emptied.
    return { ok: false, stage: 'mangled', stripped, presses: post.presses, emptied: boxEmptied(post), boxSeen: post.seen, error: 'input did not land in the session (not submitted)' }
  }
  await pressKey('Enter')
  if (TUI_VERIFY && !(await settled(readPane, (p) => !inputBoxText(p), sleep))) {
    const residue = (inputBoxText(await readPane()) || '').length
    await sleep(TUI_VERIFY_SETTLE_MS)
    const post = await clearInputBox(io)
    return { ok: false, stage: 'unsubmitted', stripped, residue, presses: post.presses, emptied: boxEmptied(post), boxSeen: post.seen, error: 'the session did not accept the message (Enter did not submit it; nothing was sent)' }
  }
  return { ok: true, stripped, cleared }
}

/**
 * Answer a Claude Code panel with one of ITS OWN safe keys — the card's
 * Dismiss / Review / Close buttons. `actionId` must be one the panel offers
 * right now (re-parsed here, never taken from the client), so a key the panel
 * does not advertise, and `2` (send to Anthropic) in particular, cannot be
 * pressed from the dashboard at all (pane-panel.mjs SAFE_KEYS).
 *
 * A digit only works on an EMPTY box (Claude Code's hook fires when the input
 * becomes exactly that digit), so a non-empty box refuses; a digit the panel
 * did not take is then plain text in a box that was empty, and is cleared
 * again. Dismissing can raise "Turn off Claude-drafted feedback? 0 to turn off
 * · Esc to keep" — answered with Esc: switching the feature off is the
 * operator's setting, not this button's. Same injected IO as typeAndSubmit.
 * Returns { ok, panel } — `panel` is whatever is open afterwards (null = none).
 */
export async function pressPanelAction(actionId, { readPane, typeText, pressKey, sleep = sleepMs }) {
  const pane = await readPane()
  const panel = parsePanel(pane)
  if (!panel) return { ok: false, panel: null, error: 'no Claude Code panel is open' }
  const a = panel.actions.find((x) => x.id === actionId)
  if (!a || !PANEL_SAFE_KEYS.has(a.key)) return { ok: false, panel, error: `this panel does not offer "${actionId}"` }
  const same = (p) => JSON.stringify(p) === JSON.stringify(panel)
  if (a.key === 'Escape') await pressKey('Escape')
  else {
    if (inputBoxText(pane) !== '') return { ok: false, panel, error: "the input box isn't empty — the panel's keys only work on an empty box" }
    const t = await typeText(a.key)
    if (!t.ok) return { ok: false, panel, error: String(t.stderr || '').slice(0, 500) || 'send-keys failed' }
  }
  await settled(readPane, (p) => !same(parsePanel(p)), sleep)
  let after = await readPane()
  if (a.key !== 'Escape' && inputBoxText(after) === a.key) {
    await clearInputBox({ readPane, pressClear: () => pressKey(TUI_CLEAR_KEY), settle: () => sleep(TUI_VERIFY_SETTLE_MS) })
    after = await readPane()
  }
  let left = parsePanel(after)
  if (actionId === 'dismiss' && left?.kind === 'feedback-off-prompt' && left.actions.some((x) => x.id === 'keep')) {
    await pressKey('Escape')
    await settled(readPane, (p) => parsePanel(p)?.kind !== 'feedback-off-prompt', sleep)
    left = parsePanel(await readPane())
  }
  if (same(left)) return { ok: false, panel: left, error: 'the panel did not respond to the key' }
  return { ok: true, panel: left }
}

// What a failed payload LOOKED like, without its content: length, lines, and
// how many non-ASCII code points of each Unicode general category it carried.
// Two refusal bursts of the same length are undiagnosable when only `len` is
// recorded; this is enough to tell an invisible-mark paste (Cf), a PUA glyph
// (Co) or odd spaces (Zs) from plain accented prose (Ll) without ever writing
// the operator's words to a log.
const CATEGORIES = ['Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'Mn', 'Mc', 'Me', 'Nd', 'Nl', 'No', 'Pc', 'Pd', 'Ps', 'Pe', 'Pi', 'Pf', 'Po', 'Sm', 'Sc', 'Sk', 'So', 'Zs', 'Zl', 'Zp', 'Cc', 'Cf', 'Cs', 'Co', 'Cn']
  .map((gc) => [gc, new RegExp(`^\\p{gc=${gc}}$`, 'u')])
export function payloadFingerprint(text) {
  const s = typeof text === 'string' ? text : ''
  const nonAscii = {}
  for (const ch of s) {
    if (ch.codePointAt(0) < 0x80) continue
    const gc = (CATEGORIES.find(([, re]) => re.test(ch)) || ['?'])[0]
    nonAscii[gc] = (nonAscii[gc] || 0) + 1
  }
  return { len: s.length, lines: s ? s.split('\n').length : 0, nonAscii }
}

export const TUI_INPUT_HEAD_CHARS = HEAD_CHARS
