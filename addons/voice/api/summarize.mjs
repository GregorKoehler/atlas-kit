/* ------------------------------------------------------------------ *
 * The `claude -p` half: one fleet event + the agent's terminal tail → two
 * sentences a browser (or an on-box engine) can read aloud.
 *
 * The kit's standing claude-CLI pattern (see api/src/agent-titles.mjs and
 * addons/news-ingest/api/summarize.mjs): the subscription CLI,
 * `ANTHROPIC_API_KEY` blanked so it can never fall through to API-key billing,
 * prompt on stdin, a hard timeout, both streams merged into the error detail
 * because claude prints some failures to stdout. NO TOOLS: this call reads a
 * terminal tail and writes prose, nothing else.
 *
 * 🔴 THE RUNAWAY-LOOP GUARD IS THE POINT OF THIS FILE.
 * A recap is fired by an EVENT, not by a human — an agent whose status flaps
 * between busy and idle emits events as fast as the dashboard polls. Upstream
 * learned this the expensive way: an unguarded turn-summarizer on the same
 * `claude -p` seam fired 2,753 times in one day where 2–5 was normal, and only a
 * usage audit caught it. A cheap model made that cheap; it would not have been.
 * Three independent guards sit in front of every call, in this order:
 *
 *   1. unchanged tail — the same (cleaned) tail for the same agent means nothing
 *                       new happened, whatever the event says;
 *   2. min interval   — one recap per agent per minute, even on a changed tail,
 *                       so flapping cannot buy more calls;
 *   3. daily budget   — a hard global cap per calendar day across all agents,
 *                       with one log line when it trips.
 *
 * All three are per-process memory: a restart forgets them, which is the right
 * trade for a guard whose job is bounding a loop, not auditing history.
 *
 * ONE SUMMARY PER EVENT, NEVER RECURSIVE. The answer is returned, spoken, and
 * dropped. It is never fed back into a later prompt — no "what I already told
 * you" chain — so a recap can never grow another recap, and the spend per event
 * is exactly one bounded call or none.
 *
 * A TERMINAL TAIL IS UNTRUSTED TEXT. Whatever an agent (or the files it read)
 * prints reaches this prompt, instructions included. The bound is that the call
 * has NO TOOLS, no network and no side effect: its whole output is a few
 * sentences that get read aloud. A hostile tail can produce a silly recap, and
 * can do nothing else.
 * ------------------------------------------------------------------ */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { requireClaudeBin } from '../../../api/src/claude-bin.mjs'
import { model, effort, timeouts, limits } from './config.mjs'

/** The events a recap can be about — anything else is rejected at the route. */
export const EVENTS = ['turn-end', 'ready', 'shipped', 'done', 'error', 'manual']

const WHAT = {
  'turn-end': 'The agent just ended a turn — it is idle and may be waiting on the operator.',
  ready: 'The agent signalled that its work is complete and mergeable (READY-TO-SHIP).',
  shipped: 'The agent merged its pull request (SHIPPED).',
  done: 'The agent session ended.',
  error: 'The agent session ended in an error state.',
  manual: 'The operator asked for a status update on this agent.',
}

const SYSTEM = `You narrate a SHORT spoken status update about a coding agent working in a terminal. You are given the tail of its terminal session.

In 2-3 short sentences of plain, spoken language, say what the agent is doing or just did. If it is waiting on the operator (a question or a menu), say clearly what it is asking. Match the language of the session.

This text is READ ALOUD: no markdown, no code, no bullets, no headings, no URLs or file paths unless they are the point. Output ONLY the spoken update.`

/* Strip tmux/ANSI escapes and the Claude Code TUI's own chrome, so the model
 * reads the agent's output rather than the banner around it — then keep only the
 * tail, bounded by BOTH lines and characters, so one enormous line cannot get
 * past the line cap. */
export function cleanTail(raw, { lines = limits().tailLines, chars = limits().tailChars } = {}) {
  const noAnsi = String(raw || '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
  const noChrome = noAnsi
    .replace(/esc to interrupt/gi, '')
    .replace(/[❯⏵⏎]/g, '')
    .replace(/[─│╭╮╰╯┌┐└┘├┤┬┴┼▌▛▜▝▘▗▖▀▄█]/g, '')
  const trimmed = noChrome
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .slice(-lines)
    .join('\n')
    .trim()
  return trimmed.length > chars ? trimmed.slice(-chars) : trimmed
}

/** The one-shot prompt. The event is stated so the recap opens on what actually
 *  happened rather than on whatever the tail happens to end with. */
export function buildRecapPrompt({ event = 'manual', agent = '', clean = '' } = {}) {
  return [
    SYSTEM,
    '',
    `=== EVENT ===\n${WHAT[event] || WHAT.manual}`,
    ...(agent ? [`=== AGENT ===\n${String(agent).slice(0, 200)}`] : []),
    `=== TERMINAL TAIL ===\n${clean}`,
  ].join('\n\n')
}

/** What comes back is fed to a speech engine, so it is flattened (no fences, no
 *  newlines) and hard-capped: a model that ignores "2-3 sentences" must not turn
 *  into four minutes of audio. */
export function sanitizeSpoken(out, cap = limits().spokenChars) {
  const t = String(out || '').trim()
  const fenced = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(t)
  const flat = (fenced ? fenced[1] : t).replace(/\s+/g, ' ').trim()
  if (flat.length <= cap) return flat
  // Cut at the last sentence end inside the cap, so speech stops on a full stop
  // rather than mid-word; fall back to a hard slice when there is none.
  const head = flat.slice(0, cap)
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '))
  return (stop > cap / 2 ? head.slice(0, stop + 1) : head).trim()
}

/* --- the three guards ----------------------------------------------------- */

const lastHash = new Map() // agentId -> sha256 of the last summarized (cleaned) tail
const lastAt = new Map() // agentId -> ms timestamp of the last call
let budgetDay = ''
let budgetCount = 0
let budgetTripped = false

const hashTail = (clean) => createHash('sha256').update(clean).digest('hex')

/**
 * Should this recap call be SKIPPED for `agentId`? Returns a skip reason, or
 * null to proceed — and when it returns null it also RESERVES the guard state
 * (hash, timestamp, budget slot), so two overlapping calls cannot both pass.
 * Exported so the guards are unit-testable without spawning `claude -p`.
 */
export function recapGuard(agentId, clean, now = Date.now()) {
  const { minIntervalMs, dailyBudget } = limits()
  if (agentId) {
    if (lastHash.get(agentId) === hashTail(clean)) return 'unchanged-tail'
    if (lastAt.has(agentId) && now - lastAt.get(agentId) < minIntervalMs) return 'min-interval'
  }
  const day = new Date(now).toISOString().slice(0, 10)
  if (day !== budgetDay) {
    budgetDay = day
    budgetCount = 0
    budgetTripped = false
  }
  if (budgetCount >= dailyBudget) {
    if (!budgetTripped) {
      budgetTripped = true
      console.warn(`[voice] daily recap budget (${dailyBudget}) tripped for ${day} — no further claude -p calls until it rolls over`)
    }
    return 'daily-budget'
  }
  budgetCount++
  if (agentId) {
    lastHash.set(agentId, hashTail(clean))
    lastAt.set(agentId, now)
  }
  return null
}

/** What the guards have spent today — surfaced by GET /api/addons, so "nothing
 *  is speaking" can be told from "the budget is gone" without reading a log. */
export function budgetState(now = Date.now()) {
  const { dailyBudget } = limits()
  const day = new Date(now).toISOString().slice(0, 10)
  return {
    day,
    spent: day === budgetDay ? budgetCount : 0,
    budget: dailyBudget,
    tripped: day === budgetDay && budgetTripped,
  }
}

/** Test-only: clear the in-process guard state between cases. */
export function resetRecapGuards() {
  lastHash.clear()
  lastAt.clear()
  budgetDay = ''
  budgetCount = 0
  budgetTripped = false
}

/* --- the call ------------------------------------------------------------- */

function runClaude(prompt) {
  const args = ['-p', '--model', model()]
  const e = effort()
  if (e) args.push('--effort', e)
  args.push('--output-format', 'text')
  const ms = timeouts().recap
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(requireClaudeBin(), args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ANTHROPIC_API_KEY: '' }, // subscription auth, never API-key billing
      })
    } catch (err) {
      return reject(new Error(`failed to spawn claude: ${err.message}`))
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`claude -p timed out after ${ms}ms`))
    }, ms)
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`failed to spawn claude: ${err.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        const detail = [stderr, stdout]
          .map((x) => x.replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' | ')
          .slice(0, 300)
        return reject(new Error(`claude -p exited ${code}: ${detail}`))
      }
      resolve(stdout)
    })
    child.stdin.write(prompt)
    child.stdin.end()
  })
}

/**
 * One spoken recap. Never throws:
 *   { ok: true,  text }             — say this
 *   { ok: false, skipped: reason }  — a guard held it back (not an error)
 *   { ok: false, error }            — the call failed; the caller speaks the
 *                                     event line instead, which costs nothing
 *
 * `runImpl` is the seam the tests use — everything above it is pure, and the
 * only thing below it is a subprocess.
 */
export async function recap({ agentId = '', agent = '', event = 'manual', tail = '' } = {}, { runImpl = runClaude, now = Date.now() } = {}) {
  const clean = cleanTail(tail)
  if (!clean) return { ok: false, error: 'no session output to recap yet' }
  const skipped = recapGuard(agentId, clean, now)
  if (skipped) return { ok: false, skipped }
  try {
    const text = sanitizeSpoken(await runImpl(buildRecapPrompt({ event, agent, clean })))
    if (!text) return { ok: false, error: 'claude -p returned an empty recap' }
    return { ok: true, text }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}
