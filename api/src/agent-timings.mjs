/* ------------------------------------------------------------------ *
 * Dev/knowledge-agent time tracking — phase state-machine, estimator,
 * and an append-only timings log.
 *
 * An agent's life alternates between RUN phases (it's busy — the tmux "esc to
 * interrupt" marker is up) and WAIT phases (idle, the operator's turn).
 * agent-local.mjs samples each box-local session's status (running/idle/done) on
 * its 3s timer and from listSessions; agent-routes.mjs samples each WORKSTATION
 * session's status from the bridge poll (against a shadow session per remote id).
 * Both hand it here via trackPhase(); we turn that stream of statuses into clean
 * phases, freezing the "running" timer the moment the agent blocks on input.
 *
 * Two things are persisted:
 *   • live phase state — written ONTO the session object (so it rides across
 *     restarts and reaches the card via publicView). We only mutate the object
 *     here; the caller owns persistence (agent-local → state.json for box-local
 *     sessions, agent-routes → remote-timings.json for workstation shadows).
 *   • durable history — an append-only JSONL (mirrors audit.log): one `run`
 *     record per completed busy period, one `lifetime` record per agent. This
 *     is the corpus the estimator learns from and the stats card reads. Nothing
 *     here ever touches the vault.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATE_DIR = process.env.AGENT_LOCAL_DIR || path.join(os.homedir(), '.atlas-kit')
const TIMINGS_LOG = path.join(STATE_DIR, 'agent-timings.jsonl')

// How long a new status must persist before we commit a phase transition —
// absorbs spawn-boot lag and the brief busy-marker gap between tool calls so a
// single turn doesn't fragment into spurious micro-phases. Keyed on wall-clock
// (not a tick count) so the 3s timer and the on-demand listSessions poll agree
// even when they fire within the same second.
const DEBOUNCE_MS = Number(process.env.AGENT_PHASE_DEBOUNCE_MS || 7000)
// interrupt()/sendNow() Escape the in-flight turn then re-deliver; the busy
// marker drops for a beat. While a hold is in force we ignore "idle" so a steer
// never looks like the run ended. Set by agent-local; just honoured here.
export const PHASE_HOLD_MS = Number(process.env.AGENT_PHASE_HOLD_MS || 5000)
// Estimator: minimum samples in a bucket before we trust its own history, and
// the cold-start fallback when there's no history at all. The default is ~90s,
// not 6 min: observed runs cluster around a median of ~100s and the few runs that
// fell back to the old 6-min default over-shot by ~4×, so a high default makes
// every brand-new bucket badly pessimistic. `EWMA_ALPHA` is the log-space recency
// weight (higher = trusts recent runs more); 0.3 won a backtest against the plain
// all-history median and adapts as the workload drifts.
const MIN_SAMPLES = Number(process.env.AGENT_ESTIMATE_MIN_SAMPLES || 3)
const DEFAULT_ESTIMATE_MS = Number(process.env.AGENT_ESTIMATE_DEFAULT_MS || 90 * 1000)
const EWMA_ALPHA = Number(process.env.AGENT_ESTIMATE_EWMA_ALPHA || 0.3)
// Bound the estimator's in-memory working set (the file keeps everything).
const MAX_MEM = Number(process.env.AGENT_TIMINGS_MAX_MEM || 2000)
// Stats graphs: trailing window of per-day working time (local days, zero-filled)
// and how many recent runs the actual/estimate accuracy series carries.
const DAILY_DAYS = Number(process.env.AGENT_STATS_DAILY_DAYS || 30)
const ACCURACY_POINTS = Number(process.env.AGENT_STATS_ACCURACY_POINTS || 60)
// Cap stored prompt/task text so a giant paste can't bloat the log.
const MAX_TEXT = 2000

const nowIso = (ms) => new Date(ms).toISOString()

// In-memory tails of past records, loaded once at startup: `runs` feeds the
// estimator + per-bucket stats, `lifetimes` feeds the wait-time / agent-count
// aggregates. Appends keep both in sync.
const { runs, lifetimes } = loadHistory()

function loadHistory() {
  let text
  try {
    text = fs.readFileSync(TIMINGS_LOG, 'utf-8')
  } catch {
    return { runs: [], lifetimes: [] }
  }
  const runs = []
  const lifetimes = []
  for (const line of text.split('\n')) {
    if (!line) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e && e.type === 'run' && typeof e.actualMs === 'number') runs.push(e)
    else if (e && e.type === 'lifetime') lifetimes.push(e)
  }
  return { runs: runs.slice(-MAX_MEM), lifetimes: lifetimes.slice(-MAX_MEM) }
}

function appendLog(rec) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.appendFileSync(TIMINGS_LOG, JSON.stringify(rec) + '\n')
  } catch (e) {
    console.error('[agent-timings] append failed:', e.message)
  }
  const arr = rec.type === 'run' ? runs : rec.type === 'lifetime' ? lifetimes : null
  if (arr) {
    arr.push(rec)
    if (arr.length > MAX_MEM) arr.splice(0, arr.length - MAX_MEM)
  }
}

function median(nums) {
  if (!nums.length) return null
  const s = [...nums].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// Linear-interpolated percentile of an ALREADY-SORTED array (0 ≤ p ≤ 1).
function percentile(sorted, p) {
  if (!sorted.length) return null
  if (sorted.length === 1) return sorted[0]
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

// Exponentially-weighted moving average in LOG space (run durations are
// multiplicative / heavy-tailed, so we average their logs and exponentiate back).
// `samples` must be in chronological order — the most recent run gets the most
// weight. Beats a plain median when the workload drifts.
function logEwma(samples, alpha = EWMA_ALPHA) {
  if (!samples.length) return null
  let m = Math.log(samples[0])
  for (let i = 1; i < samples.length; i++) m = alpha * Math.log(samples[i]) + (1 - alpha) * m
  return Math.exp(m)
}

// Buckets are keyed by (kind, model, effort): a chat's "thinking" times never
// pool with a dev agent's, and Opus·max never pools with Sonnet·high. A finer
// (…, size) key narrows further — the spawn-time t-shirt size of the task (see
// estimateRun) — so an "L" feature isn't estimated off a pile of "S" one-liners.
const bucketKey = (kind, model, effort) => `${kind || 'dev'}|${model || ''}|${effort || ''}`
const sizeKey = (kind, model, effort, size) => `${bucketKey(kind, model, effort)}|${size || ''}`

// Local-time YYYY-MM-DD, so per-day working time lines up with the operator's
// actual days rather than UTC.
function localDayKey(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

// Pick the most specific pool of past runs that still has MIN_SAMPLES, walking
// narrowest → broadest and taking the first that qualifies:
//   config·size·phase → config·phase → config·size → config → all history.
// `first` marks a session's OPENING spawn-task turn, which runs markedly longer
// (~2.5×) than a later steer — the strongest split, so it's kept in the fallback
// longer than size. It's only applied when passed as a boolean (the per-bucket
// stats table omits it → all phases pool). Old records predate the field, so they
// read as steers (`!!r.first` = false); the first-run pool therefore fills only
// from new runs and is conservative until it does. Order stays chronological for
// the EWMA.
function resolveSamples(kind, model, effort, size, first) {
  const ck = bucketKey(kind, model, effort)
  const cfg = (r) => bucketKey(r.kind, r.model, r.effort) === ck
  const hasFirst = typeof first === 'boolean'
  const candidates = []
  if (size && hasFirst) candidates.push((r) => cfg(r) && (r.size || '') === size && !!r.first === first)
  if (hasFirst) candidates.push((r) => cfg(r) && !!r.first === first)
  if (size) candidates.push((r) => cfg(r) && (r.size || '') === size)
  candidates.push(cfg)
  for (const match of candidates) {
    const pool = runs.filter(match)
    if (pool.length >= MIN_SAMPLES) return pool
  }
  return runs.length >= MIN_SAMPLES ? runs : []
}

// Rough estimate for the next busy period of an agent, as a CENTRAL guess plus a
// p25–p75 "typically" band — run durations are heavy-tailed (a single number
// hides a 3–10× spread), so the card shows the range, not just the point. Central
// = log-space EWMA of the resolved sample pool (recency-weighted); band = the
// pool's 25th/75th percentiles. `first` (opening spawn turn vs. later steer)
// further narrows the pool. Falls back to the cold-start default (no band) until
// a bucket has MIN_SAMPLES. Self-improves as history accrues.
export function estimateRun(kind, model, effort, size, first) {
  const samples = resolveSamples(kind, model, effort, size, first)
  if (samples.length < MIN_SAMPLES) return { ms: DEFAULT_ESTIMATE_MS, loMs: null, hiMs: null }
  const acts = samples.map((r) => r.actualMs)
  const sorted = [...acts].sort((a, b) => a - b)
  return {
    ms: Math.round(logEwma(acts)),
    loMs: Math.round(percentile(sorted, 0.25)),
    hiMs: Math.round(percentile(sorted, 0.75)),
  }
}

// Central estimate only (ms) — for the per-bucket stats table.
export function estimateRunMs(kind, model, effort, size) {
  return estimateRun(kind, model, effort, size).ms
}

// The operator input that kicked off the current run (logged for analysis /
// future length-aware estimation). Falls back to the spawn task for run #1.
function runPromptOf(s) {
  return (s.lastPrompt && s.lastPrompt.text) || s.task || ''
}

function openRun(s, atMs) {
  s.phase = 'run'
  s.phaseStartedAt = nowIso(atMs)
  s.runStartedAt = s.phaseStartedAt
  // No run has completed yet → this is the session's opening spawn-task turn,
  // which runs markedly longer than a later steer. Remembered for closePhase to log.
  const first = (s.runCount || 0) === 0
  s.runFirst = first
  const est = estimateRun(s.kind, s.model, s.effort, s.size, first)
  s.runEstimateMs = est.ms
  if (est.loMs != null) s.runEstimateLoMs = est.loMs
  else delete s.runEstimateLoMs
  if (est.hiMs != null) s.runEstimateHiMs = est.hiMs
  else delete s.runEstimateHiMs
  s.runPrompt = runPromptOf(s)
}

function openWait(s, atMs) {
  s.phase = 'wait'
  s.phaseStartedAt = nowIso(atMs)
  delete s.runStartedAt
}

// Close whichever phase is open at `atMs`, recording it. A run becomes a `run`
// history line (+ the session's lastRunMs / running totals); a wait just adds to
// the wait total (it lands in the agent's `lifetime` record when it ends).
function closePhase(s, atMs) {
  if (s.phase === 'run' && s.runStartedAt) {
    const startedAt = s.runStartedAt
    const actualMs = Math.max(0, atMs - Date.parse(startedAt))
    const prompt = (s.runPrompt || '')
    s.lastRunMs = actualMs
    s.totalRunMs = (s.totalRunMs || 0) + actualMs
    s.runCount = (s.runCount || 0) + 1
    appendLog({
      at: nowIso(atMs),
      type: 'run',
      id: s.id,
      repo: s.repo,
      kind: s.kind || 'dev',
      model: s.model || null,
      effort: s.effort || null,
      // Spawn-time t-shirt size of the task (S/M/L), set async by the title agent;
      // null on older runs and on the first run if size hadn't landed yet.
      size: s.size || null,
      // Was this the session's opening spawn-task turn (vs. a later steer)? Opening
      // turns run ~2.5× longer, so the estimator pools them separately.
      first: !!s.runFirst,
      prompt: prompt.slice(0, MAX_TEXT),
      promptLen: prompt.length,
      estimateMs: s.runEstimateMs ?? null,
      actualMs,
      startedAt,
      endedAt: nowIso(atMs),
    })
  } else if (s.phase === 'wait' && s.phaseStartedAt) {
    s.totalWaitMs = (s.totalWaitMs || 0) + Math.max(0, atMs - Date.parse(s.phaseStartedAt))
  }
}

/**
 * Fold one observed status into the session's phase state. Synchronous and
 * idempotent on a repeated status, so it is safe to call from BOTH the 3s timer
 * and the on-demand listSessions poll. Only handles the live run/wait
 * alternation — 'error' is ignored and termination ('done', kill, cleanup) goes
 * through recordLifetime. Returns whether the session changed (caller persists).
 */
export function trackPhase(s, status, now) {
  if (s.lifetimeLogged) return false
  if (status !== 'running' && status !== 'idle') return false
  const want = status === 'running' ? 'run' : 'wait'

  // First observation: anchor the phase at spawn time, so the initial run counts
  // from when the agent actually started working rather than from first poll.
  if (s.phase !== 'run' && s.phase !== 'wait') {
    const anchor = s.startedAt ? Date.parse(s.startedAt) : now
    if (want === 'run') openRun(s, anchor)
    else openWait(s, anchor)
    s.phasePending = null
    return true
  }

  if (want === s.phase) {
    if (s.phasePending != null) {
      s.phasePending = null
      return true
    }
    return false
  }

  // A steer (interrupt/sendNow) momentarily clears the busy marker — don't read
  // that blip as the run ending.
  if (want === 'wait' && s.phaseHold && now < s.phaseHold) {
    if (s.phasePending != null) s.phasePending = null
    return false
  }

  // Debounce: require the new status to persist for DEBOUNCE_MS before committing.
  if (s.phasePending !== want) {
    s.phasePending = want
    s.phasePendingSince = now
    return true
  }
  if (now - s.phasePendingSince < DEBOUNCE_MS) return false

  // Commit. The real boundary is when the new status was FIRST seen, not now
  // (DEBOUNCE_MS later) — so the phase durations stay accurate.
  const boundary = s.phasePendingSince
  closePhase(s, boundary)
  if (want === 'run') openRun(s, boundary)
  else openWait(s, boundary)
  s.phasePending = null
  return true
}

/**
 * Terminal: close any open phase, stamp endedAt, and append the agent's
 * `lifetime` record (initial prompt, model/effort, wall-clock, working vs
 * waiting split, run count). Guarded by `lifetimeLogged` so the four call sites
 * (timer-detected done, kill, cleanup, knowledge reap) stay idempotent
 * regardless of order. Returns whether the session changed.
 */
export function recordLifetime(s, now) {
  if (s.lifetimeLogged) return false
  if (s.phase === 'run' || s.phase === 'wait') closePhase(s, now)
  s.lifetimeLogged = true
  s.phase = 'done'
  s.endedAt = nowIso(now)
  delete s.runStartedAt
  delete s.phasePending
  const spawnedAt = s.startedAt || s.endedAt
  appendLog({
    at: s.endedAt,
    type: 'lifetime',
    id: s.id,
    repo: s.repo,
    kind: s.kind || 'dev',
    model: s.model || null,
    effort: s.effort || null,
    task: (s.task || '').slice(0, MAX_TEXT),
    spawnedAt,
    endedAt: s.endedAt,
    wallMs: Math.max(0, now - Date.parse(spawnedAt)),
    runMs: s.totalRunMs || 0,
    waitMs: s.totalWaitMs || 0,
    runCount: s.runCount || 0,
  })
  return true
}

/**
 * Inverse of recordLifetime: a session that was stamped terminal (tmux gone →
 * recordLifetime ran, leaving `lifetimeLogged`/`phase:'done'`/`endedAt`, plus the
 * listSessions "lost" flag `interrupted`) is observed ALIVE again — it was
 * recovered (its Claude session resumed in a fresh tmux under the same name) or the
 * box came back. Lift the terminal stamp so it tracks as a live agent again, and
 * re-anchor a fresh phase at `now` — NOT at the original spawn (trackPhase's own
 * bootstrap anchors from `startedAt`, which after a long-dead gap would show a
 * bogus multi-hour run). The dead gap is simply not counted as run or wait.
 * Idempotent-ish: returns false (no change) when there was nothing terminal to undo.
 */
export function revivePhase(s, status, now) {
  if (!s.lifetimeLogged && !s.interrupted && s.endedAt == null && s.phase !== 'done') return false
  delete s.lifetimeLogged
  delete s.interrupted
  delete s.endedAt
  delete s.phasePending
  if (status === 'running') openRun(s, now)
  else openWait(s, now)
  return true
}

/**
 * Aggregate the history for the Scorecard's "Agent work" group:
 *  - `totalRunMs` — all-time working time (sum of every recorded busy turn).
 *  - `monthRunMs` — working time in the current local calendar month (all kinds).
 *  - `daily` — per-day working time over the trailing window (local days,
 *    zero-filled so the bar chart has a continuous x-axis); the last entry is
 *    today and grows as runs complete through the day.
 *  - `accuracy` — actual/estimate per run over time (1.0 = on the nose, >1 = the
 *    run took longer than estimated), the most recent ACCURACY_POINTS in order.
 *  - `buckets` — per (kind,model,effort): count · median run · current estimate.
 * All from the in-memory tails.
 */
export function aggregate() {
  const totalRunMs = runs.reduce((a, r) => a + (r.actualMs || 0), 0)

  // Working time in the current LOCAL calendar month (all kinds, matching
  // totalRunMs) — the "this month" figure shown beside the all-time total.
  const ym = localDayKey(new Date()).slice(0, 7)
  let monthRunMs = 0
  const byDay = new Map()
  for (const r of runs) {
    const key = localDayKey(new Date(r.endedAt || r.at))
    byDay.set(key, (byDay.get(key) || 0) + (r.actualMs || 0))
    if (key.slice(0, 7) === ym) monthRunMs += r.actualMs || 0
  }
  const today = new Date()
  const daily = []
  for (let i = DAILY_DAYS - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(today.getDate() - i)
    const key = localDayKey(d)
    daily.push({ date: key, runMs: byDay.get(key) || 0 })
  }
  // Trim leading empty days so the chart spans only the active range (first day
  // with work → today) instead of padding out the whole window. Today is always
  // kept as the last bar (it may carry live in-progress time the client adds).
  let from = daily.findIndex((d) => d.runMs > 0)
  if (from < 0) from = daily.length - 1
  const dailyRange = daily.slice(from)

  const accuracy = runs
    .filter((r) => r.estimateMs > 0)
    .slice(-ACCURACY_POINTS)
    .map((r) => ({ at: r.endedAt || r.at, ratio: r.actualMs / r.estimateMs }))

  const byKey = new Map()
  for (const r of runs) {
    const key = sizeKey(r.kind, r.model, r.effort, r.size)
    let b = byKey.get(key)
    if (!b) {
      b = { kind: r.kind || 'dev', model: r.model || null, effort: r.effort || null, size: r.size || null, samples: [] }
      byKey.set(key, b)
    }
    b.samples.push(r.actualMs)
  }
  const buckets = [...byKey.values()]
    .map((b) => ({
      kind: b.kind,
      model: b.model,
      effort: b.effort,
      size: b.size,
      count: b.samples.length,
      medianRunMs: Math.round(median(b.samples) || 0),
      estimateMs: estimateRunMs(b.kind, b.model, b.effort, b.size),
    }))
    .sort((a, b) => b.count - a.count)

  return { totalRunMs, monthRunMs, daily: dailyRange, accuracy, buckets }
}

// Dev-agent working time in the CURRENT local calendar month, summed per repo —
// for the project cards (a project's `agentRepo` ↔ a run's `repo`). Knowledge
// chats (repo 'vault') are excluded; only dev turns count. Recomputed per call
// off the in-memory tail, so it tracks the agents poll.
export function monthRunMsByRepo() {
  const now = new Date()
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const out = {}
  for (const r of runs) {
    if ((r.kind || 'dev') !== 'dev' || !r.repo) continue
    const d = new Date(r.endedAt || r.at)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    if (key !== ym) continue
    out[r.repo] = (out[r.repo] || 0) + (r.actualMs || 0)
  }
  return out
}
