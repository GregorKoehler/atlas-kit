/* ------------------------------------------------------------------ *
 * menu.mjs — pure parsing of Claude Code's numbered "choice" menu from a
 * terminal tail, plus the key sequence to select an option.
 *
 * Used by the Telegram messenger so it can show the operator the menu's options
 * and turn a phone reply of "2" into the SAME arrow-navigate-then-Enter the
 * dashboard card sends over /api/agents/keys (digits aren't used — not every
 * Claude Code menu selects on a digit; moving the `❯` highlight + Enter does).
 * Pure + IO-free so it is unit-tested (api/test/menu.test.mjs).
 * ------------------------------------------------------------------ */

// tmux capture keeps SGR escapes (the highlight is rendered with them); strip
// them so the glyph/number matching below is clean. The literal `❯` and the
// "1. text" survive — only the color/inverse codes go.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\x1b\][^\x07]*\x07/g

// A past user message Claude Code echoes as `❯` + a REGULAR space + text — the
// same glyph as the menu highlight, so an echo sitting right above a menu must
// NOT be mistaken for the question (the phantom-menu confusion, PR #383).
const USER_ECHO_RE = /^\s*❯ \S/
// A line made only of box-drawing / rule characters (or blank) — a border, not text.
const BORDER_RE = /^[\s│┃╭╮╰╯┌┐└┘├┤┬┴┼─━═╌╍]*$/
// Strip a box's side borders so a bordered prompt line reads as its inner text.
const stripBorders = (line) => line.replace(/^\s*[│┃]\s?/, '').replace(/\s?[│┃]\s*$/, '').trim()

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

// Parse the numbered options and which one is highlighted (prefixed `❯`).
// Returns { options: [{ n, text }], highlighted, question? } or null when the
// tail doesn't hold a real (≥2-option) menu. `highlighted` falls back to the
// first option; `question` is the prompt text above the options (omitted if none).
export function parseChoiceMenu(raw) {
  const lines = String(raw || '').replace(ANSI, '').split('\n')
  const options = []
  let highlighted = null
  let firstIdx = -1
  for (let i = 0; i < lines.length; i++) {
    // e.g. "❯ 1. Yes" (highlighted) or "  2. No, keep editing". Number 1–99,
    // a "." or ")" separator, then the label.
    const m = lines[i].match(/^\s*(❯)?\s*(\d{1,2})[.)]\s+(\S.*?)\s*$/)
    if (!m) continue
    const n = Number(m[2])
    if (options.some((o) => o.n === n)) continue // keep the first sighting per number
    if (firstIdx < 0) firstIdx = i
    options.push({ n, text: m[3].replace(/\s+/g, ' ').trim().slice(0, 120) })
    if (m[1]) highlighted = n
  }
  if (options.length < 2) return null
  const question = questionAbove(lines, firstIdx)
  return { options, highlighted: highlighted ?? options[0].n, ...(question ? { question } : {}) }
}

// Keys to move the `❯` highlight from option `from` to option `to`, then confirm.
// Mirrors the dashboard card's respond toolbar (Up/Down + Enter).
export function selectKeys(from, to) {
  const delta = Number(to) - Number(from)
  const dir = delta > 0 ? 'Down' : 'Up'
  return [...Array(Math.abs(delta)).fill(dir), 'Enter']
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
