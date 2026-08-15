/* ------------------------------------------------------------------ *
 * pane-busy.mjs — "is this Claude Code pane in the middle of a turn?"
 *
 * ONE implementation, imported by BOTH executors (api/src/agent-local.mjs and
 * agent-bridge/server.mjs) — like queue-delivery.mjs's `decideDelivery` and
 * agent-capacity.mjs. The verdict gates queue/ship delivery in both, so a
 * second copy would drift and only one would get the next fix.
 *
 * TWO WITNESSES, OR'd — idle is declared only when BOTH are absent.
 *
 *  1. The FOOTER MARKER (`esc to interrupt`). Historically the only witness,
 *     and the reason this module exists: that footer is ONE line rendered to
 *     the pane width out of a dynamic segment list, so it both ellipsizes
 *     (measured live: 79 of 80 columns, `← for age…` already cut) and DROPS
 *     segments to make room (one pane lost `(shift+tab to cycle)` entirely).
 *     ⚠️ Measured by driving `deliver()`'s own `tmux send-keys` at
 *     a pane and sampling every 200 ms, which CORRECTED the assumed mechanism:
 *     it is not only ellipsis. Text SITTING in the input box collapses the
 *     footer to `⏵⏵ bypass permissions on · 1 shell` — the marker is simply
 *     gone, 11.5 s measured, while the turn runs. That false idle fired three
 *     reply receipts (fixed notification-side by
 *     gating on the debounced `phase`); the raw verdict still times queue
 *     delivery and the ship train, which is what this fixes at the source.
 *     ⚠️ KNOWN RESIDUAL: for ~8 s after a LARGE (2.7 KB) message is submitted
 *     the footer is replaced by a `paste again to expand` hint and no spinner
 *     renders either, so that frame still reads idle — see the last test in
 *     api/test/pane-busy.test.mjs for the measurement and for why the obvious
 *     third witness was rejected.
 *
 *  2. The SPINNER line (`✽ Germinating… (50s · ↓ 2.8k tokens)`) — rendered just
 *     above the input box for as long as the turn runs. Glyph and verb both
 *     vary (captured live: `✽ Beaming…`, `· Topsy-turvying…`, `* Lollygagging…`);
 *     what is stable is `<glyph> <Verb…>… (<duration>`. The trailing `…` and
 *     the parenthesised duration are LOAD-BEARING: the post-turn line is
 *     `✻ Worked for 1m 52s` / `✻ Crunched for 51s` — same glyph, same column,
 *     and the agent is IDLE.
 *
 * FAILURE DIRECTIONS ARE NOT SYMMETRIC, and that shapes the anchoring:
 *   • a false BUSY delays one delivery to the next tick/boundary — benign;
 *   • a false IDLE mistimes a send and bypasses the BOUNDARY_MIN_GAP_MS pacing
 *     — the bug class above;
 *   • but a PERMANENTLY stuck busy would freeze delivery altogether, which is
 *     worse than either. So the spinner is matched ONLY in the pane's live
 *     status region — the few lines directly above the input box — never as a
 *     whole-pane grep. Spinner-shaped text inside an agent's OUTPUT (an agent
 *     quoting a pane capture — e.g. the investigation that produced this file)
 *     sits further up and is indented; it must not read as busy.
 * ------------------------------------------------------------------ */

// Witness 1 — unchanged from the original detector, deliberately still a
// whole-(tail-)pane test: that is the behaviour every caller has today, and
// narrowing it would be a delivery-timing change of its own.
const BUSY_MARKER = /esc to interrupt/i

// Witness 2. Anchored at column 0 (measured: the spinner starts there, while
// Claude Code indents message/tool-result body by two spaces), and requiring
// both the `…` and the opening `(<n><h|m|s>` of the duration.
const SPINNER_LINE = /^[✻✽✶✳✢·*]\s+\S[^\n]*…\s*\(\d+[hms]\b/
// The input box is drawn as two full-width `─` rules around the `❯` line.
const BOX_RULE = /^\s*─{10,}\s*$/
// How far above the box the spinner can sit: it is usually the line right
// above, but a `⎿ Tip: …` block and a blank line can come between.
const SPINNER_LOOKBACK = 6
// A multi-line draft makes the box taller; past this we assume the second rule
// belongs to something else and treat the last rule as the box top.
const BOX_ROWS_MAX = 12

/**
 * Locate the input box: the indices of the two `─` rules that bracket it.
 * `null` when no rule is on screen at all (a degenerate/one-line capture).
 * When only ONE rule is visible — the box's top has scrolled out of the capture
 * — `top === bottom`, i.e. no content rows.
 *
 * Exported because tui-input.mjs reads the box's CONTENT off the same geometry
 * (what did the text we typed actually land as?). One locator, two questions:
 * a second copy of "find the rules" would drift and only one would be fixed.
 * ⚠️ Expects rows with no SGR escapes — this module's callers capture without
 * `-e`; tui-input strips them first (it needs `-e` for the faint placeholder).
 */
export function inputBoxBounds(rows) {
  let bottom = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (BOX_RULE.test(rows[i])) { bottom = i; break }
  }
  if (bottom < 0) return null
  let top = bottom
  for (let i = bottom - 1; i >= 0 && bottom - i <= BOX_ROWS_MAX; i--) {
    if (BOX_RULE.test(rows[i])) { top = i; break }
  }
  return { top, bottom }
}

// The rows a live spinner may occupy: the ones directly above the input box.
// With no box on screen at all (a degenerate/one-line capture) fall back to the
// last few rows — still bounded, never the whole pane.
function statusRegion(rows) {
  const box = inputBoxBounds(rows)
  if (!box) return rows.slice(-SPINNER_LOOKBACK)
  return rows.slice(Math.max(0, box.top - SPINNER_LOOKBACK), box.top)
}

// `0`/`false`/`no`/`off` drops back to the footer marker alone — the exact
// pre-hardening behaviour — if a spinner shape ever sticks and freezes
// delivery. Each machine sets it in its own env (a bridge restarts separately
// from the box), like every other per-executor switch here.
const SPINNER_WITNESS = !/^(0|false|no|off)$/i.test(process.env.AGENT_SPINNER_WITNESS || '1')

export function spinnerRunning(pane) {
  if (!SPINNER_WITNESS) return false
  return statusRegion(String(pane).split('\n')).some((ln) => SPINNER_LINE.test(ln))
}

// Claude Code shows BOTH markers only while a turn is actively running; the
// moment it finishes and waits for the next prompt they are gone. So a live
// tmux session showing either = working ('running'); one showing neither = the
// agent is blocked on YOU ('idle' / needs input).
export function isBusy(pane) {
  return BUSY_MARKER.test(pane) || spinnerRunning(pane)
}
