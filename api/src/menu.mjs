/* ------------------------------------------------------------------ *
 * menu.mjs — pure parsing of Claude Code's numbered "choice" menu from a
 * terminal tail, plus verified navigation to select an option.
 *
 * Used by the dashboard card, the Telegram messenger, and the workstation
 * bridge, so all three drive/display a pending menu identically: parseChoiceMenu
 * reads the options, the live highlight, and — for a tool-driven AskUserQuestion
 * box — the question/header/per-option descriptions straight off the PANE, and
 * driveSelect turns a target option's TEXT into the arrow-navigate-then-Enter
 * that actually lands on it, confirming by content at every step (digits
 * aren't used to select — verified live, not every Claude Code menu
 * selects on a digit; moving the `❯` highlight + Enter does, and only once
 * it's confirmed there).
 *
 * PANE, not the transcript, is the ONLY live source for a PENDING AskUserQuestion
 * (the root cause of the follow-up incident): Claude Code does not write the
 * AskUserQuestion tool_use to the session `.jsonl` until it's flushed together
 * with the tool_result, AFTER the operator answers — verified on this box by a
 * 1 Hz watcher showing the transcript file frozen byte-for-byte for the entire
 * ~3-minute span a menu sat open, and a live poll of the (correct, deployed)
 * transcript scanner returning null on every tick of that same window. So a
 * still-open menu has no transcript record to read AT ALL; sourcing its
 * question/options from there (an earlier transcript-sourced attempt +
 * `resolveMenuChoice`) was unreachable in practice — every real pending menu
 * fell back to this pane parser, which is why the operator saw options with no
 * question. subagent-scan.mjs's `scanAskUserQuestionResult` (a DIFFERENT
 * function, keyed by a tool_use id) still works: it reads the transcript
 * AFTER an answer lands, when tool_use+tool_result are both on disk together.
 *
 * Pure + IO-free so it is unit-tested (api/test/menu.test.mjs).
 * ------------------------------------------------------------------ */

// tmux capture keeps SGR escapes (the highlight is rendered with them); strip
// them so the glyph/number matching below is clean. The literal `❯` and the
// "1. text" survive — only the color/inverse codes go.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\x1b\][^\x07]*\x07/g

// A past user message Claude Code echoes as `❯` + a REGULAR space + text — the
// same glyph as the menu highlight, so an echo sitting right above a menu must
// NOT be mistaken for the question (the phantom-menu confusion).
const USER_ECHO_RE = /^\s*❯ \S/
// A line made only of box-drawing / rule characters (or blank) — a border, not text.
// NOTE this also matches a blank/whitespace-only line (every char class is
// optional) — callers that need to tell "blank" from "an actual rule" apart
// (boxAbove below) MUST check blankness first.
const BORDER_RE = /^[\s│┃╭╮╰╯┌┐└┘├┤┬┴┼─━═╌╍]*$/
// Strip a box's side borders so a bordered prompt line reads as its inner text.
const stripBorders = (line) => line.replace(/^\s*[│┃]\s?/, '').replace(/\s?[│┃]\s*$/, '').trim()

// The TUI's OWN escape rows, appended after AskUserQuestion's real options —
// detected by label (not position: verified live they sit flush
// after the last real option with NO rule between them, contradicting PR
// #451's assumption that a rule always separates them; only "Chat about
// this" sits past a rule, as its own almost-block — see the trailing-block
// absorption in parseChoiceMenu). Marked `escape: true` rather than passed
// off as an ordinary answerable option. multiSelect drops the period on
// "Type something" — tolerate both (verified live).
const ESCAPE_LABEL_RE = /^(type something\.?|chat about this)$/i

// AskUserQuestion's tab/header row for a multi-question or multiSelect ask —
// e.g. "←  ☐ Frameworks  ✔ Submit  →" (one question, multiSelect) or
// "←  ☐ Color  ☐ Size  ✔ Submit  →" (two questions) — verified live
// in testing. Its mere presence means the menu needs Tab-between-questions
// and/or Space-then-Submit, which the single arrow+Enter flow (driveSelect)
// can't drive — see the `unsupported` flagging in parseChoiceMenu.
const TAB_ROW_RE = /^\s*←\s+(.+?)\s+→\s*$/

// The prompt/question a choice menu asks ABOVE its options (e.g. "Do you want to
// make this edit?"), so the operator can see WHAT they are answering. Only the
// contiguous non-empty block directly above the first option — stop at a blank
// line, a box border, or an echoed user turn so we never absorb the surrounding
// conversation. Best-effort and bounded; '' when there's no adjacent prompt.
function questionAbove(lines, firstIdx) {
  const out = []
  for (let i = firstIdx - 1; i >= 0 && out.length < 4; i--) {
    if (USER_ECHO_RE.test(lines[i]) || BORDER_RE.test(lines[i])) break
    const c = stripBorders(lines[i])
    if (!c) break
    out.unshift(c)
  }
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

// AskUserQuestion's question/header, read from its bordered box (verified live
// in testing): a rule, then either a plain " ☐ <header>" line or a tab row
// (TAB_ROW_RE, multi-question/multiSelect), a BLANK line, the question (one or
// more wrapped lines), another BLANK line, then the options. questionAbove
// above stops dead at that first blank line by design (so permission/plan
// menus — whose question sits directly adjacent, no gap — never absorb
// conversation text); this is the complementary path for when there IS a gap:
// cross exactly that one blank, collect the contiguous question text, then
// look for exactly one more line (the header/tab row) before a hard stop at
// the next border — so assistant prose further up still can't leak in. `{}`
// when the line directly above isn't blank (not this shape; caller falls back
// to questionAbove) or nothing readable turns up.
function boxAbove(lines, firstIdx) {
  let i = firstIdx - 1
  if (i < 0 || lines[i].trim() !== '') return {}
  i--
  const qLines = []
  let hitBorder = false
  while (i >= 0 && qLines.length < 8) {
    const line = lines[i]
    if (!line.trim()) {
      i--
      break // the second blank — the question block ends here
    }
    if (BORDER_RE.test(line)) {
      hitBorder = true
      break // the box's top rule, directly above the question — no header line
    }
    qLines.unshift(stripBorders(line))
    i--
  }
  if (!qLines.length) return {}
  const question = qLines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300)
  if (hitBorder) return { question }
  const headerLine = i >= 0 ? lines[i] : undefined
  if (headerLine == null || !headerLine.trim()) return { question }
  const tab = TAB_ROW_RE.exec(headerLine)
  if (tab) {
    const tabs = tab[1]
      .split(/\s{2,}/)
      .map((t) => t.replace(/^[☐☒✔]\s*/, '').trim())
      .filter(Boolean)
    return { question, tabs }
  }
  const hdr = headerLine.match(/^\s*[☐☒]\s*(.+?)\s*$/)
  return hdr ? { question, header: hdr[1].trim() } : { question }
}

// Parse the numbered options and which one is highlighted (prefixed `❯`), from
// only the LAST contiguous menu BLOCK in the pane. A real menu always sits at
// the bottom (just above the input line); prose above it — including the
// assistant's OWN numbered reasoning directly before it calls a tool (verified
// live in testing: a plain "1. …" / "2. …" list immediately followed by an
// AskUserQuestion box) — must never steal a number or the highlight from the
// real menu below it. That was the first root cause of the incident this fixes: the old
// whole-pane scan kept the FIRST sighting of each number, so the prose's "1."/
// "2." won the dedup and the real highlighted "❯ 1. …" row was silently
// dropped — losing the highlight too, since the `continue` happened before the
// highlight check.
//
// A block is a run of consecutive lines that each match the option pattern.
// A blank line or a border/rule ends a block outright. A non-option,
// non-blank line while a block is open is a CONTINUATION, not the end of one —
// either an AskUserQuestion option's description, sitting on its own
// unindented line right below the option it belongs to (verified live
// in testing: EVERY option shows one, not just the highlighted one) — folded
// onto that option's `description` — or, while no block is open, harmless
// prose. Within a block, a repeated or non-increasing number can never
// continue it — that starts a FRESH block instead of being dropped, so two
// numbered lists sitting back to back with no blank/border between them still
// can't merge into one.
//
// Only the LAST block with ≥2 options counts as the menu. Its trailing rows
// may be the TUI's OWN escape rows ("Type something(.)", "Chat about this") —
// flagged `escape: true` (ESCAPE_LABEL_RE) rather than passed off as ordinary
// options; "Type something(.)" sits IN this same block (contiguous with the
// real options, no rule — verified live, contradicting the
// an earlier transcript-sourced attempt assumption that a rule always separates it), while "Chat about
// this" sits past a rule as its own trailing one-row block, absorbed here
// when its number continues the sequence.
//
// A leading tab/header row (TAB_ROW_RE) above the block means the ask is
// multi-question and/or multiSelect — Tab-between-questions and/or
// Space-then-Submit, which this single arrow+Enter flow can't drive — so
// that shape returns `{ unsupported: true, reason, question?, header? }`
// instead of options, with no attempt to synthesize a wrong drivable menu.
//
// Returns { options: [{ n, text, description?, escape? }], highlighted,
// question?, header? }, an `{ unsupported, reason, question?, header? }`
// (see above), or null when no block qualifies. `highlighted` falls back to
// the block's first option. `question`/`header` come from the pane: directly
// adjacent text (questionAbove, permission/plan dialogs — no gap) or, for an
// AskUserQuestion box, crossing its one blank gap up to the question and one
// more line to a header/tab row (boxAbove) — bounded at the box's own border
// either way, so assistant prose further up the pane still can't leak in.
export function parseChoiceMenu(raw) {
  const lines = String(raw || '').replace(ANSI, '').split('\n')
  const blocks = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (BORDER_RE.test(line) || !line.trim()) {
      cur = null
      continue
    }
    // e.g. "❯ 1. Yes" (highlighted), "  2. No, keep editing", or a multiSelect
    // checkbox row "  3. [ ] Jest" / "❯ 1. [✔] Jest". Number 1–99, a "." or ")"
    // separator, an optional "[ ]"/"[x]"/"[✔]" checkbox, then the label.
    const m = line.match(/^\s*(❯)?\s*(\d{1,2})[.)]\s+(?:\[([ xX✔])\]\s+)?(\S.*?)\s*$/)
    if (!m) {
      // Continuation while a block is open — fold it onto the last option
      // pushed so far as its description (see the block comment above).
      if (cur && cur.options.length) {
        const d = line.trim()
        if (d) {
          const last = cur.options[cur.options.length - 1]
          last.description = (last.description ? `${last.description} ${d}` : d).slice(0, 200)
        }
      }
      continue
    }
    const n = Number(m[2])
    if (!cur || n <= cur.lastN) {
      cur = { options: [], highlighted: null, lastN: 0, firstIdx: i }
      blocks.push(cur)
    }
    cur.options.push({ n, text: m[4].replace(/\s+/g, ' ').trim().slice(0, 120) })
    cur.lastN = n
    if (m[1]) cur.highlighted = n
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    if (b.options.length < 2) continue
    // Absorb a trailing one-row escape block (e.g. "5. Chat about this" past a
    // rule) whose numbering continues this block's sequence.
    const next = blocks[i + 1]
    if (next && next.options.length && next.options[0].n === b.lastN + 1 && next.options.every((o) => ESCAPE_LABEL_RE.test(o.text))) {
      b.options.push(...next.options)
      b.lastN = next.options[next.options.length - 1].n
    }
    for (const o of b.options) if (ESCAPE_LABEL_RE.test(o.text)) o.escape = true
    const box = boxAbove(lines, b.firstIdx)
    if (box.tabs) {
      const nonSubmit = box.tabs.filter((t) => !/^submit$/i.test(t))
      return {
        unsupported: true,
        reason: nonSubmit.length > 1 ? 'multi-question' : 'multi-select',
        ...(box.question ? { question: box.question } : {}),
        ...(nonSubmit[0] ? { header: nonSubmit[0] } : {}),
      }
    }
    const question = questionAbove(lines, b.firstIdx) || box.question
    return {
      options: b.options.map(({ n, text, description, escape }) => ({
        n,
        text,
        ...(description ? { description } : {}),
        ...(escape ? { escape: true } : {}),
      })),
      highlighted: b.highlighted ?? b.options[0].n,
      ...(question ? { question } : {}),
      ...(box.header ? { header: box.header } : {}),
    }
  }
  return null
}

// The option line the ❯ highlight ACTUALLY sits on right now, scanning the
// WHOLE pane (not block-restricted) for the last such marker — the live
// cursor position, full stop, including the TUI's own "Type something."/"Chat
// about this" escape rows (parseChoiceMenu's own `escape` flag identifies
// those within its block-restricted result; this scan doesn't need to, since
// it isn't restricted to one contiguous run in the first place). Used by the
// verified-select flow (driveSelect) to confirm a nav step landed on the
// intended option by TEXT, never by number alone (RC2 — a blind arrow+Enter
// replay computed from a wrong/stale highlight is exactly how a menu answer
// once landed on the wrong option).
const HIGHLIGHT_RE = /^\s*❯\s+(\d{1,2})[.)]\s+(\S.*?)\s*$/
export function currentHighlight(raw) {
  const lines = String(raw || '').replace(ANSI, '').split('\n')
  let found = null
  for (const line of lines) {
    const m = line.match(HIGHLIGHT_RE)
    if (m) found = { n: Number(m[1]), text: m[2].replace(/\s+/g, ' ').trim().slice(0, 120) }
  }
  return found
}

// Drive the ❯ highlight from wherever it is to the option whose TEXT is
// `target`, confirming by CONTENT at every step — never by position alone —
// then press Enter; or, if `target` can't be confirmed within a bounded
// number of steps, give up WITHOUT ever pressing Enter (an unconfirmed pick is
// worse than none: an Enter once landed on option 1 while
// the operator meant to pick option 5). IO is injected (`sendKey`,
// `readHighlight`) so this stays pure/testable and both the box-local executor
// (tmux) and the workstation bridge (docker exec tmux) share the exact same
// navigation logic.
// - `sendKey(key)`: send one 'Up'/'Down'/'Enter' key and settle; resolve false
//   on failure.
// - `readHighlight()`: resolve the pane's current `{ n, text }` (see
//   currentHighlight) or null when the menu isn't there anymore.
// - `hintN`: the target's approximate 1-based row position (e.g. from the
//   transcript's option order), used ONLY to pick an initial direction/step
//   count — never trusted for the final confirmation.
// verified live: Down does not wrap past the last row and Up does
// not wrap past the first (both clamp) — so a wrong initial direction is
// detected (the highlight stops moving) and flipped, at most once.
export async function driveSelect({ target, hintN, sendKey, readHighlight, maxSteps = 24 }) {
  const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase()
  const wantText = norm(target)
  if (!wantText) return { ok: false, error: 'no target text' }
  let cur = await readHighlight()
  if (!cur) return { ok: false, error: 'no menu open' }
  let dir = typeof hintN === 'number' && hintN !== cur.n ? (hintN > cur.n ? 'Down' : 'Up') : 'Down'
  let flipped = false
  for (let step = 0; step < maxSteps; step++) {
    if (norm(cur.text) === wantText) {
      const sent = await sendKey('Enter')
      return sent ? { ok: true } : { ok: false, error: 'send-keys failed' }
    }
    const sent = await sendKey(dir)
    if (!sent) return { ok: false, error: 'send-keys failed' }
    const next = await readHighlight()
    if (!next) return { ok: false, error: 'menu closed unexpectedly' }
    if (next.n === cur.n && next.text === cur.text) {
      // Didn't move — clamped at this end. Try the other direction once.
      if (flipped) return { ok: false, error: `option not found: ${target}` }
      dir = dir === 'Down' ? 'Up' : 'Down'
      flipped = true
    }
    cur = next
  }
  return { ok: false, error: `could not confirm selection: ${target}` }
}

// Map a bare-number reply to one of `options`' numbers, or null when it isn't a
// clean pick. Tolerates "2", "2.", "#2" — but NOT "2 and also do x" (that's a
// real instruction, which must fall through to the prompt path, not a select).
export function parseMenuReply(text, options) {
  const m = String(text || '').trim().match(/^#?\s*(\d{1,2})\s*\.?$/)
  if (!m) return null
  const n = Number(m[1])
  return options?.some((o) => o.n === n) ? n : null
}
