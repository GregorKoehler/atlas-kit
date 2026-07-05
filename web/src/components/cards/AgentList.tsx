import { type VNode } from 'preact'
import { createPortal, memo } from 'preact/compat'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { EmptyState } from '../Card'
import { useAgentFocus, agentFocusConsumed, consumeAgentFocus } from '../../lib/agentFocus'
import {
  spawnAgent,
  promptAgent,
  interruptAgent,
  queueAgent,
  unqueueAgent,
  shipAgent,
  unshipAgent,
  sendQueuedNowAgent,
  sendAgentKeys,
  killAgent,
  cleanupAgent,
  abortAgentClose,
  reviveAgent,
  reviveAllAgents,
  scheduleAgent,
  unscheduleAgent,
  fetchAgentOutput,
  fetchAgentHistory,
  isTypedVault,
  type AgentAttachment,
  type AgentHistory,
  type AgentHistoryMessage,
  type AgentSession,
  type AgentStatus,
  type ScheduledAction,
} from '../../lib/api'
import { AgentsOverview } from './AgentsOverview'
import { Markdown } from '../../lib/markdown'
import { useDraft } from '../../lib/useDraft'
import { lockBodyScroll } from '../../lib/scrollLock'
import { MicField } from '../MicField'
import { ScheduleButton } from '../ScheduleButton'

// Atlas Kit ships without the self-deploy button and without voice/dictation, so
// these are inert stubs (the surrounding ship/prompt logic is otherwise unchanged).
const kickDeploy = () => {}
const scrollFieldToEnd = (..._a: unknown[]) => {}
const useDictation = (_v: string, _set: (s: string) => void) => ({
  recording: false,
  busy: false,
  error: '' as string,
  toggle: () => {},
})

// A pending scheduled time → a short, friendly local label ("in 2h", "Tue 14:30").
export function fmtSchedAt(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  const mins = Math.round((d.getTime() - Date.now()) / 60000)
  if (mins <= 0) return 'now'
  if (mins < 60) return `in ${mins}m`
  const hrs = mins / 60
  const sameDay = d.toDateString() === new Date().toDateString()
  const hhmm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (sameDay) return hrs < 12 ? `in ${Math.round(hrs)}h · ${hhmm}` : `today ${hhmm}`
  const wd = d.toLocaleDateString([], { weekday: 'short' })
  return `${wd} ${hhmm}`
}

// Cap on attachments per prompt (mirrors the API's AGENT_MAX_IMAGES).
const MAX_IMAGES = 6

/* --- transcript view preference ----------------------------------------- *
 * The transcript pane's DEFAULT view. 'chat' (the on-disk history as rendered
 * chat bubbles) unless the operator flipped to the terminal. The 📜/>_ toggle
 * is STICKY — flipping it persists the choice as the default for every card —
 * which is also the zero-deploy way back to TUI-as-default if chat-by-default
 * turns out unwanted. */
const VIEW_PREF_KEY = 'atlas-kit-transcript-view'
function defaultHistMode(): boolean {
  try {
    return localStorage.getItem(VIEW_PREF_KEY) !== 'tui'
  } catch {
    return true
  }
}
function persistHistMode(chat: boolean) {
  try {
    localStorage.setItem(VIEW_PREF_KEY, chat ? 'chat' : 'tui')
  } catch {
    /* private mode etc. — the toggle still works for this session */
  }
}

/* Format a message's ISO timestamp as a local HH:MM clock time for the bubble's
 * "sent at" caption. Every real message carries `ts` from its Claude Code JSONL
 * event; returns '' when it's missing or unparseable so the caption is skipped. */
function fmtMsgTime(ts: string | null | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/* One chat bubble of the history view. Memoized on the message's identity —
 * messages are append-only on disk, so during the live poll only NEW bubbles
 * mount; existing ones skip their markdown re-render entirely. */
const HistMsg = memo(
  function HistMsg({ m }: { m: AgentHistoryMessage }) {
    // An Atlas orchestrator steered this agent — the injected prompt lands as a
    // user turn but isn't the operator's, so mark it apart (see agent-history.mjs).
    const steered = m.source === 'atlas'
    return (
      <div className={`agent__msg agent__msg--${m.role}${steered ? ' agent__msg--steered' : ''}`}>
        {steered ? <div className="agent__msg-from">↪ steered by Atlas</div> : null}
        {/* Assistant replies are markdown — render them (headings, code blocks,
            lists…) via the shared wiki renderer. Operator prompts stay literal
            pre-wrap text: they're not authored as markdown, and a stray #/* in
            a pasted path or log must not restyle the message. */}
        {m.text ? (
          m.role === 'assistant' ? (
            <div className="agent__msg-md">
              <Markdown source={m.text} />
            </div>
          ) : (
            <div className="agent__msg-text">{m.text}</div>
          )
        ) : null}
        {m.tools.length ? (
          <div className="agent__msg-tools">
            {m.tools.map((t, j) => (
              <span key={j} className="agent__msg-tool" title={t.summary}>
                🔧 {t.name}
                {t.summary ? <span className="agent__msg-tool-arg"> {t.summary}</span> : null}
              </span>
            ))}
          </div>
        ) : null}
        {fmtMsgTime(m.ts) ? (
          <time className="agent__msg-time tnum" dateTime={m.ts ?? undefined}>
            {fmtMsgTime(m.ts)}
          </time>
        ) : null}
      </div>
    )
  },
  (prev, next) =>
    prev.m.role === next.m.role &&
    prev.m.source === next.m.source &&
    prev.m.ts === next.m.ts &&
    prev.m.text === next.m.text &&
    prev.m.tools.length === next.m.tools.length,
)

/* A choice menu the operator just resolved. The TUI menu (and the answer) never
 * land in the on-disk transcript, so once answered it would silently vanish —
 * we record the resolved pick client-side and echo it into the chat as its own
 * bubble, so there's a visible record of what was asked and what was chosen. */
type AnsweredMenu = { ts: string; question: string; n: number; text: string }

/* The "you answered ⟨n. text⟩" bubble echoed into the chat after a menu is
 * resolved (Defect: a picked option used to leave no trace). Matches HistMsg's
 * bubble shape; amber like the other menu affordances. */
function AnsweredMsg({ a }: { a: AnsweredMenu }) {
  return (
    <div className="agent__msg agent__msg--answered">
      <div className="agent__msg-from">✓ you answered</div>
      {a.question ? <div className="agent__answered-q">{a.question}</div> : null}
      <div className="agent__answered-pick">
        <span className="agent__history-opt-n tnum">{a.n}.</span> {a.text}
      </div>
      {fmtMsgTime(a.ts) ? (
        <time className="agent__msg-time tnum" dateTime={a.ts}>
          {fmtMsgTime(a.ts)}
        </time>
      ) : null}
    </div>
  )
}

// The parked-prompts queue as a list, tolerant of a bridge that predates the
// multi-queue upgrade and still sends a single object instead of an array.
type QueuedMsg = NonNullable<AgentSession['queued']>[number]
const queuedList = (q: AgentSession['queued']): QueuedMsg[] =>
  Array.isArray(q) ? q : q ? [q as unknown as QueuedMsg] : []

// Read a File/Blob into a `data:…;base64,…` URL (image upload).
function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

const STATUS_LABEL: Record<AgentStatus, string> = {
  running: 'running',
  idle: 'needs input',
  done: 'done',
  error: 'error',
  // Stranded by a tmux-server death (reboot/OOM); worktree intact, revivable.
  dormant: 'dormant',
}

// Knowledge chats read as a conversation, not a work queue — 'idle' is simply
// your turn, not a blocked agent.
const KNOWLEDGE_STATUS_LABEL: Record<AgentStatus, string> = {
  running: 'thinking',
  idle: 'ready',
  done: 'ended',
  error: 'error',
  dormant: 'dormant',
}

// Tooltip per background-job chip (the ⚙ strip).
const JOB_STATUS_TITLE: Record<'running' | 'done' | 'failed', string> = {
  running: 'running in the background',
  done: 'finished (exit 0)',
  failed: 'failed (non-zero exit)',
}

// Compact token count: 47318 → "47k", 8400 → "8.4k", 980 → "980",
// 1000000 → "1m" (a 1M context window reads "1m", not "1000k").
function fmtK(n: number): string {
  if (n < 1000) return String(n)
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return `${Number.isInteger(m) ? m : m.toFixed(1)}m`
  }
  const k = n / 1000
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`
}

// Compact duration: 12s → "12s", 138s → "2m18s", 3840s → "1h04m" (seconds drop
// past the hour). Used by the per-row run timer / estimate / alive clock, and by
// the Scorecard's "Agent work" totals.
export function fmtDur(ms: number): string {
  let s = Math.round((Number.isFinite(ms) ? ms : 0) / 1000)
  if (s < 0) s = 0
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

// A 1s ticking clock, but only while `active` — so idle/done rows don't re-render
// every second once their timers are frozen. Mirrors Hero.tsx's useClock.
// Exported so the Scorecard can live-tick today's working-time bar.
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [active])
  return now
}

// The session carries the resolved model ID (`claude-opus-4-8[1m]`); show just
// the family name the spawn picker used. Unknown IDs fall back to the raw value.
export function modelLabel(model: string): string {
  const m = model.toLowerCase()
  if (m.includes('opus')) return 'Opus'
  if (m.includes('sonnet')) return 'Sonnet'
  if (m.includes('haiku')) return 'Haiku'
  if (m.includes('fable')) return 'Fable'
  return model
}
// Effort level → the picker's label ('xhigh' reads as "Very high").
export const EFFORT_LABEL: Record<string, string> = { high: 'High', xhigh: 'Very high', max: 'Max' }

// The transcript is captured with `tmux capture-pane -e`, so it carries the
// pane's SGR escape codes. We strip the colours (the transcript renders plain)
// but honour *faint* (ESC[2m … ESC[0m/22m) so Claude Code's dim input-box
// placeholder shows muted instead of reading as a real, pending message.
const SGR = /\x1b\[([0-9;]*)m/g
function renderTranscript(raw: string): (string | VNode)[] {
  const nodes: (string | VNode)[] = []
  let faint = false
  let cursor = 0
  let key = 0
  const push = (text: string) => {
    // Drop any stray non-SGR escapes so they never leak as literal garbage.
    const clean = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    if (!clean) return
    nodes.push(faint ? <span className="agent__dim" key={key++}>{clean}</span> : clean)
  }
  SGR.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = SGR.exec(raw))) {
    push(raw.slice(cursor, m.index))
    cursor = SGR.lastIndex
    for (const code of m[1].split(';')) {
      if (code === '2') faint = true
      else if (code === '' || code === '0' || code === '22') faint = false
    }
  }
  push(raw.slice(cursor))
  return nodes
}

/**
 * Per-agent context-window meter: a little bar showing how much of the model's
 * context is filled, in k tokens. Fed by the box-local executor reading the
 * agent's transcript (workstation agents omit these fields → no bar). The fill
 * warms amber past 75% and red past 90% — a cue that auto-compaction is near.
 */
function ContextMeter({ tokens, window }: { tokens: number; window: number }) {
  const pct = Math.max(0, Math.min(1, tokens / window))
  const level = pct >= 0.9 ? 'full' : pct >= 0.75 ? 'warn' : 'ok'
  return (
    <span
      className="agent__ctx"
      title={`context: ${tokens.toLocaleString()} / ${window.toLocaleString()} tokens (${Math.round(pct * 100)}%)`}
    >
      <span className="agent__ctx-bar">
        <span className={`agent__ctx-fill agent__ctx-fill--${level}`} style={{ width: `${pct * 100}%` }} />
      </span>
      <span className="agent__ctx-label tnum">
        {fmtK(tokens)}/{fmtK(window)}
      </span>
    </span>
  )
}

// Stat values arrive as arbitrary numbers (counts, rates, scores) — compact
// integers via fmtK, floats trimmed to a sensible precision.
const fmtStat = (n: number) => (Number.isInteger(n) ? fmtK(n) : n.toFixed(Math.abs(n) < 10 ? 2 : 1))

/**
 * One live-stat tile on a session row — numbers the agent publishes itself
 * while it works (its background jobs rewrite a JSON file; the box samples it
 * and accumulates each counter's history). A `[done,total]` entry renders as a
 * completion bar; a plain counter gets a mini area sparkline of its history —
 * the scorecard's cumulative-contributions look, shrunk to chip size. `gid`
 * keys the gradient def (SVG ids are document-global, and several tiles can be
 * on screen at once).
 *
 * Exported so the Scorecard can re-render the same tiles inside a per-agent
 * frame — the operator's central view of every plot a dev agent is publishing.
 */
export function AgentStat({ stat, gid }: { stat: { label: string; value: number; max?: number; points?: number[] }; gid: string }) {
  const pct = stat.max != null && stat.max > 0 ? Math.max(0, Math.min(1, stat.value / stat.max)) : null
  const pts = stat.max == null && stat.points && stat.points.length >= 2 ? stat.points : null
  let spark = null
  if (pts) {
    const W = 60
    const H = 16
    const PAD = 2 // keep the trough/peak (and end-dot) off the edges so they aren't clipped
    // Auto-zoom to the series' own min..max rather than a 0 baseline: a counter
    // that starts large and creeps upward (e.g. a deep crawl already millions in)
    // would otherwise look flat, its movement a tiny fraction of its magnitude.
    const lo = Math.min(...pts)
    const span = Math.max(...pts) - lo || 1
    const pt = (i: number) =>
      `${((i / (pts.length - 1)) * W).toFixed(2)},${(PAD + (H - 2 * PAD) * (1 - (pts[i] - lo) / span)).toFixed(2)}`
    const line = pts.map((_, i) => pt(i)).join(' ')
    const end = pt(pts.length - 1).split(',')
    spark = (
      <svg className="agent__stat-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(34,211,238,0.35)" />
            <stop offset="100%" stop-color="rgba(34,211,238,0)" />
          </linearGradient>
        </defs>
        <polygon points={`0,${H} ${line} ${W},${H}`} fill={`url(#${gid})`} />
        <polyline className="spark__line" points={line} />
        <circle className="spark__dot" cx={end[0]} cy={end[1]} r="1.4" />
      </svg>
    )
  }
  return (
    <span
      className="agent__stat"
      title={
        pct != null
          ? `${stat.label}: ${stat.value.toLocaleString()} of ${stat.max!.toLocaleString()} (${Math.round(pct * 100)}%)`
          : `${stat.label}: ${stat.value.toLocaleString()}`
      }
    >
      <span className="agent__stat-value tnum">
        {fmtStat(stat.value)}
        {pct != null ? <span className="agent__stat-max">/{fmtStat(stat.max!)}</span> : null}
      </span>
      {pct != null ? (
        <span className="agent__stat-bar">
          <span className="agent__stat-fill" style={{ width: `${pct * 100}%` }} />
        </span>
      ) : (
        spark
      )}
      <span className="agent__stat-label hud-label">{stat.label}</span>
    </span>
  )
}

// The ship prompt delivered (verbatim) into the serial ship train — restated
// here so both the per-row Ship button and the card's "Ship N ready" enqueue the
// same wording. The re-sync is restated even though the agent synced before:
// with parallel agents, master moves between an agent's last rebase and its
// merge. selfDeploy projects (only the dashboard) deploy via the Deploy-master
// button after the merge; everywhere else the merge IS the delivery.
export function buildShipPrompt(selfDeploy: boolean): string {
  const tail = selfDeploy
    ? 'Do not build or restart anything — I deploy from the dashboard.'
    : "Merging the PR is the delivery — there's no separate deploy run, so don't build, deploy, or restart anything."
  return (
    'Ship now: 1) re-run your sync protocol against a fresh git fetch origin — rebase onto origin/master and push --force-with-lease — even if you synced earlier (master may have moved); 2) open or update your PR; 3) if the rebase was clean and the PR is mergeable, merge it with gh pr merge --merge, report the PR number + merged SHA, and end that reply with a line that is exactly "ATLAS:SHIPPED PR #<number> <merged SHA>" (alone on its own line — the dashboard watches for it). If anything is risky, conflicted, or checks fail: STOP, do not merge, and summarize it for me. ' +
    tail
  )
}

/**
 * Sessions + spawn form, shared by the global Dev Agents card and the
 * per-project cards. With a fixed `repo` it shows only that repo's sessions and
 * a task-only spawn box (repo implied); with no `repo` it's the global card —
 * all sessions, and the spawn box asks for a repo too. Filtering is purely
 * client-side off the shared GET /api/agents view (no bridge/proxy change).
 */
export function AgentList({
  sessions,
  repo,
  github,
  selfDeploy = false,
  scheduled,
  onChanged,
}: {
  sessions: AgentSession[]
  repo?: string
  /** Project GitHub URL — enables a per-branch PR/compare link on each row. */
  github?: string
  /** This project deploys via the dashboard's Deploy-master button (only the
   *  dashboard itself does). When false, Ship means just sync + merge — the
   *  merge is the delivery and there's no separate deploy run to mention. */
  selfDeploy?: boolean
  /** Pending scheduled actions (GET /api/agents) — scoped spawns for this repo
   *  render as a pending list; prompt jobs flow down to their target's AgentRow. */
  scheduled?: ScheduledAction[]
  onChanged: () => void
}) {
  // Task + repo drafts persist across tab switches (which unmount this card) so
  // a half-written spawn isn't lost on navigation. Keyed per card instance.
  const [task, setTask] = useDraft(`agent-task:${repo ?? 'global'}`)
  const [repoInput, setRepoInput] = useDraft('agent-repo')
  // Model/effort survive across spawns (a per-card preference, unlike the task).
  const [model, setModel] = useState('opus')
  const [effort, setEffort] = useState('xhigh')
  // Files attached to the spawn prompt (mirrors a running agent's prompt box) —
  // folded into the agent's opening task so it can Read them on the first turn.
  const [images, setImages] = useState<AgentAttachment[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  // Attach picked files (capped at MAX_IMAGES total), reading each to a data URL.
  // Mirrors AgentRow.addImages; the input is cleared so re-picking the same file fires.
  const addImages = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement
    const files = Array.from(input.files || [])
    input.value = ''
    if (!files.length) return
    const read = await Promise.all(
      files.map(async (f) => ({ name: f.name, dataUrl: await readAsDataUrl(f) })),
    )
    setImages((prev) => [...prev, ...read].slice(0, MAX_IMAGES))
  }

  const scoped = repo !== undefined
  // The Atlas's autonomous passes (kind 'atlas-pass') are surfaced only in the
  // Overview / constellation — they're bare `claude -p` runs with no executor
  // session, so they must never get a dev-agent row (kill/ship/prompt would 404).
  const shown = (scoped ? sessions.filter((s) => s.repo === repo) : sessions).filter((s) => s.kind !== 'atlas-pass')

  // Agents the operator can ship in one go: flagged READY-TO-SHIP and not already
  // in the ship train. The "Ship N ready" button enqueues them all — the backend
  // serial train merges them one at a time, so this is safe to fire at once.
  const readyToShip = shown.filter((s) => s.kind !== 'knowledge' && s.shipState === 'ready' && !s.shipQueue)
  const [shipAllBusy, setShipAllBusy] = useState(false)
  const shipAllReady = async () => {
    if (shipAllBusy || !readyToShip.length) return
    setShipAllBusy(true)
    for (const s of readyToShip) await shipAgent({ id: s.id, text: buildShipPrompt(selfDeploy) })
    setShipAllBusy(false)
    onChanged()
    if (selfDeploy) kickDeploy()
  }

  // Agents a tmux-server death (reboot/OOM) parked as 'dormant' — revivable in one
  // click. The backend "Revive all" is memory-aware (newest first, stops before the
  // box runs low), so firing it at once is safe even with a big stranded fleet.
  const dormantAgents = shown.filter((s) => s.status === 'dormant')
  const [reviveAllBusy, setReviveAllBusy] = useState(false)
  const reviveAll = async () => {
    if (reviveAllBusy || !dormantAgents.length) return
    setReviveAllBusy(true)
    const r = await reviveAllAgents()
    setReviveAllBusy(false)
    if (r.ok && r.held) setErr(`Revived ${r.revived ?? 0}; held ${r.held} back — box low on memory. Close an agent, then revive the rest.`)
    onChanged()
  }

  const spawn = async (e: Event) => {
    e.preventDefault()
    const t = task.trim()
    const r = scoped ? repo! : repoInput.trim()
    if (!t || !r || busy) return
    setBusy(true)
    setErr('')
    const res = await spawnAgent({ task: t, repo: r, model, effort, images: images.length ? images : undefined })
    setBusy(false)
    if (res.ok) {
      setTask('')
      setRepoInput('')
      setImages([])
      onChanged()
    } else {
      setErr(res.error || 'spawn failed')
    }
  }

  // Schedule this spawn for `at` instead of starting it now (the ⏱ button). The
  // task/repo/model/effort are captured into the job; attachments aren't carried.
  const scheduleSpawn = async (at: string) => {
    const t = task.trim()
    const r = scoped ? repo! : repoInput.trim()
    if (!t || !r) return { ok: false, error: 'enter a task (and repo)' }
    const res = await scheduleAgent({ action: 'spawn', at, payload: { task: t, repo: r, model, effort } })
    if (res.ok) {
      setTask('')
      setRepoInput('')
      setImages([])
      onChanged()
    }
    return res
  }
  // Pending scheduled spawns for this card's repo (scoped) or all (global).
  const pendingSpawns = (scheduled ?? []).filter(
    (j) => j.action === 'spawn' && j.kind !== 'knowledge' && (!scoped || j.repo === repo),
  )
  const cancelSchedule = async (id: string) => {
    const r = await unscheduleAgent(id)
    if (r.ok) onChanged()
  }

  return (
    <div className="agents">
      <form className="agents__spawn" onSubmit={spawn}>
        <MicField value={task} onChange={setTask}>
          <input
            className="capture__input capture__input--sm"
            placeholder="task (e.g. flaky-test-triage)"
            value={task}
            onInput={(e) => setTask(e.currentTarget.value)}
          />
        </MicField>
        {!scoped ? (
          <input
            className="capture__input capture__input--sm"
            placeholder="repo"
            value={repoInput}
            onInput={(e) => setRepoInput(e.currentTarget.value)}
          />
        ) : null}
        <select
          className="capture__input capture__input--sm agents__select"
          value={model}
          onChange={(e) => setModel(e.currentTarget.value)}
          title="Model for this agent (always the 1M-context variant)"
        >
          <option value="fable">Fable</option>
          <option value="opus">Opus</option>
          <option value="sonnet">Sonnet</option>
        </select>
        <select
          className="capture__input capture__input--sm agents__select"
          value={effort}
          onChange={(e) => setEffort(e.currentTarget.value)}
          title="Thinking effort for this agent"
        >
          <option value="high">High</option>
          <option value="xhigh">Very high</option>
          <option value="max">Max</option>
        </select>
        <label
          className={`agent__attach${images.length >= MAX_IMAGES ? ' agent__attach--full' : ''}`}
          title={images.length >= MAX_IMAGES ? `max ${MAX_IMAGES} files` : 'attach file(s) — any type'}
        >
          📎
          <input
            type="file"
            multiple
            hidden
            disabled={busy || images.length >= MAX_IMAGES}
            onChange={addImages}
          />
        </label>
        <button
          type="submit"
          className="btn btn--approve"
          disabled={!task.trim() || (!scoped && !repoInput.trim()) || busy}
        >
          {busy ? 'Spawning…' : 'Spawn'}
        </button>
        <ScheduleButton
          onSchedule={scheduleSpawn}
          disabled={!task.trim() || (!scoped && !repoInput.trim()) || busy}
          title="schedule this spawn for later"
        />
      </form>
      {pendingSpawns.length ? (
        <div className="agents__scheduled" role="list" aria-label="scheduled spawns">
          {pendingSpawns.map((j) => (
            <div className="agent__queued agent__queued--sched" role="listitem" key={j.id}>
              <span className="agent__queued-label hud-label">⏱ {fmtSchedAt(j.at)}</span>
              <span className="agent__queued-text" title={j.label}>
                spawn{!scoped && j.repo ? ` · ${j.repo}` : ''} — {j.label}
              </span>
              <button
                type="button"
                className="agent__queued-rm"
                onClick={() => cancelSchedule(j.id)}
                title="cancel scheduled spawn"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {images.length ? (
        <div className="agent__imgs" role="group" aria-label="attached files">
          {images.map((img, i) => (
            <span className="agent__img" key={`${img.name}-${i}`} title={img.name}>
              {img.dataUrl.startsWith('data:image/') ? (
                <img className="agent__img-thumb" src={img.dataUrl} alt={img.name} />
              ) : (
                <span className="agent__img-thumb agent__img-thumb--file" aria-hidden="true">
                  📄
                </span>
              )}
              <span className="agent__img-name">{img.name}</span>
              <button
                type="button"
                className="agent__img-rm"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                disabled={busy}
                title="remove attachment"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {err ? <div className="agents__err">✗ {err}</div> : null}

      {readyToShip.length >= 2 ? (
        <div className="agents__shipall">
          <button
            type="button"
            className="btn btn--approve agents__shipall-btn"
            onClick={shipAllReady}
            disabled={shipAllBusy}
            title="Queue every READY-TO-SHIP agent into the ship train — they merge one at a time, each re-syncing onto the previous merge."
          >
            {shipAllBusy ? 'Queueing…' : `Ship ${readyToShip.length} ready ⤴`}
          </button>
          <span className="agents__shipall-hint">one at a time — each re-syncs onto the last merge</span>
        </div>
      ) : null}

      {dormantAgents.length >= 2 ? (
        <div className="agents__shipall agents__reviveall">
          <button
            type="button"
            className="btn agents__reviveall-btn"
            onClick={reviveAll}
            disabled={reviveAllBusy}
            title="Revive every dormant agent that still fits in RAM — newest first, one at a time, stopping before the box runs low on memory."
          >
            {reviveAllBusy ? 'Reviving…' : `Revive ${dormantAgents.length} dormant ↻`}
          </button>
          <span className="agents__shipall-hint">stranded by a restart — memory-aware, brings back as many as safely fit</span>
        </div>
      ) : null}

      {shown.length === 0 ? (
        <EmptyState>No agents running — spawn one above.</EmptyState>
      ) : (
        <ul className="agents__list">
          {shown.map((s) => (
            <AgentRow key={s.id} s={s} scoped={scoped} github={github} selfDeploy={selfDeploy} scheduled={scheduled} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * Per-agent time readout under the head: while running, a live elapsed timer vs
 * the rough estimate with a thin bar (amber once over); when idle, the frozen
 * "last run …"; and always the total time alive (since spawn, frozen once done).
 * Box-local agents only — the timing fields are absent on workstation sessions,
 * so the line renders nothing there. `knowledge` only tweaks the wording.
 */
function AgentTimer({ s, knowledge }: { s: AgentSession; knowledge: boolean }) {
  const ended = s.status === 'done' || s.status === 'error' || s.phase === 'done' || !!s.endedAt
  const running = s.status === 'running'
  // Tick only while alive; once done the alive clock + last-run stay frozen.
  const now = useNow(!ended)

  // No box-local timing on this session (e.g. a workstation agent) — stay clean.
  if (s.phase == null && s.runStartedAt == null && s.lastRunMs == null) return null
  const startMs = Date.parse(s.startedAt)
  if (!Number.isFinite(startMs)) return null
  const aliveMs = (s.endedAt ? Date.parse(s.endedAt) : now) - startMs

  const est = s.runEstimateMs
  const lo = s.runEstimateLoMs
  const hi = s.runEstimateHiMs
  // A real p25–p75 "typically" band once both ends are present (the bucket has
  // enough history); otherwise just the single cold-start estimate. Durations are
  // heavy-tailed, so a range is far more honest than one number.
  const band = lo != null && hi != null && hi > 0
  const elapsed = running && s.runStartedAt ? now - Date.parse(s.runStartedAt) : null
  // Reference for the bar + "over": the TOP of the typical band (p75) when we have
  // one, so "over" means genuinely into the long tail rather than merely past the
  // median (which fires on ~half of all runs). Falls back to the point estimate.
  const ref = band ? hi! : est
  const over = elapsed != null && ref != null && elapsed > ref
  const pct = elapsed != null && ref ? Math.min(1, elapsed / ref) : 0
  // Tick marking the central (median) estimate inside a band bar.
  const markPct = band && est != null ? Math.min(100, (est / hi!) * 100) : null
  const verb = knowledge ? 'thinking' : 'running'

  return (
    <div className="agent__timer hud-label">
      {elapsed != null ? (
        <>
          <span
            className={`agent__timer-run tnum${over ? ' agent__timer-run--over' : ''}`}
            title={
              band
                ? `${verb} for ${fmtDur(elapsed)} · typically ${fmtDur(lo!)}–${fmtDur(hi!)} (~${fmtDur(est!)} median) over past ${knowledge ? 'chat' : 'dev'} turns at this model/effort/size — rough, durations vary a lot`
                : est != null
                  ? `${verb} for ${fmtDur(elapsed)} · rough estimate ~${fmtDur(est)} (no per-bucket history yet)`
                  : `${verb} for ${fmtDur(elapsed)}`
            }
          >
            ⏱ {fmtDur(elapsed)}
            {band ? ` / ${fmtDur(lo!)}–${fmtDur(hi!)}` : est != null ? ` / ~${fmtDur(est)}` : ''}
          </span>
          {ref != null ? (
            <span className="agent__timer-bar">
              <span
                className={`agent__timer-fill${over ? ' agent__timer-fill--over' : ''}`}
                style={{ width: `${pct * 100}%` }}
              />
              {markPct != null ? (
                <span
                  className="agent__timer-mark"
                  style={{ left: `${markPct}%` }}
                  title={`~${fmtDur(est!)} median`}
                />
              ) : null}
            </span>
          ) : null}
        </>
      ) : s.lastRunMs != null && !ended ? (
        <span className="agent__timer-run tnum" title="duration of the last completed run">
          ⏱ last run {fmtDur(s.lastRunMs)}
        </span>
      ) : null}
      <span
        className="agent__timer-alive tnum"
        title={ended ? 'total time the agent was alive' : 'total time alive since spawn'}
      >
        {ended ? 'ran ' : 'alive '}
        {fmtDur(aliveMs)}
      </span>
    </div>
  )
}

export function AgentRow({
  s,
  scoped,
  github,
  selfDeploy,
  knowledge = false,
  startFullscreen = false,
  scheduled,
  onChanged,
}: {
  s: AgentSession
  scoped: boolean
  github?: string
  selfDeploy: boolean
  /** Knowledge chat (vault-grounded, no branch/PR) — hides the dev-only
   *  branch/PR/sync/ship/cleanup chrome; everything else is identical. */
  knowledge?: boolean
  /** Mount straight into the full-screen split view. The Atlas Agent card sets
   *  this when the operator clicks a chat tab, so switching chats jumps the
   *  picked one to full screen (the row remounts per tab, so it only seeds the
   *  initial state — the operator can still toggle out with ⛶/Esc). */
  startFullscreen?: boolean
  /** Pending scheduled actions — this row shows the prompt jobs aimed at it. */
  scheduled?: ScheduledAction[]
  onChanged: () => void
}) {
  // The unsent message to this agent persists per session across tab switches.
  const [text, setText] = useDraft(`agent-msg:${s.id}`)
  const [images, setImages] = useState<AgentAttachment[]>([])
  const [busy, setBusy] = useState(false)
  const [sendErr, setSendErr] = useState('')
  // Set when the operator tries to send free text while a choice menu is open —
  // the send is held back (it would be swallowed as an "accept the preselect")
  // and the card asks them to pick an option or explicitly dismiss & send.
  const [menuWarn, setMenuWarn] = useState(false)
  const [expanded, setExpanded] = useState(startFullscreen)
  const [fullscreen, setFullscreen] = useState(startFullscreen)
  // Show the live-app pane beside the transcript in full-screen (toggleable). On
  // by default so an agent's app appears the moment you full-screen it.
  const [showApp, setShowApp] = useState(true)
  // When NOTHING is serving on the slot, the operator opts in (◧) to reveal the
  // empty-slot pane (which port/base-path the app must bind) — off by default so
  // the many app-less coding agents keep a full-width transcript in full-screen.
  const [appPeek, setAppPeek] = useState(false)
  // App-ONLY full-screen: just the agent's live app, no transcript. The primary
  // way to use it on mobile (where the side-by-side split is too cramped) and a
  // focus mode on desktop. Independent of `fullscreen` (they're swapped, not
  // stacked — see openAppFull).
  const [appFull, setAppFull] = useState(false)
  // External "open this agent" signal — from the Atlas constellation, the hero
  // agents overview, or the full-screen switcher strip: clicking an agent node
  // jumps to its tab (AppShell) and opens that row's full-screen split view.
  // The module-level high-water mark fires it once per click — not again each
  // time this row remounts on tab switches. A fresh signal aimed at ANOTHER
  // agent closes this row's overlays (that's the full-screen→full-screen swap);
  // `focusSeen` is seeded at mount so a stale pre-mount signal can't close a
  // view that just opened via startFullscreen.
  const focus = useAgentFocus()
  const focusSeen = useRef(focus?.n ?? 0)
  useEffect(() => {
    if (!focus) return
    const fresh = focus.n > focusSeen.current
    focusSeen.current = focus.n
    if (focus.id === s.id) {
      if (focus.n <= agentFocusConsumed()) return
      consumeAgentFocus(focus.n)
      setExpanded(true)
      setFullscreen(true)
      // Node clicks land on the PLAIN full screen (transcript only) — the live
      // app pane stays opt-in via the ◧ toggle, unlike the manual ⛶ enter.
      setShowApp(false)
      setAppPeek(false)
    } else if (fresh) {
      setFullscreen(false)
      setAppFull(false)
    }
  }, [focus?.n, focus?.id, s.id])
  const [transcript, setTranscript] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const preRef = useRef<HTMLPreElement>(null)
  const histRef = useRef<HTMLDivElement>(null)
  // Chat view (the DEFAULT): the complete conversation reconstructed from the
  // agent's on-disk `.jsonl` transcript(s) (stitched across resume-forked files),
  // rendered as markdown chat bubbles in place of the live tmux tail. Live-polled
  // while the agent is alive; the >_/📜 toggle (sticky, see VIEW_PREF_KEY) swaps
  // to the raw terminal.
  const [histMode, setHistMode] = useState(defaultHistMode)
  const [history, setHistory] = useState<AgentHistory | null>(null)
  const [histBusy, setHistBusy] = useState(false)
  const [histErr, setHistErr] = useState('')
  // Choice menus this operator resolved on this card (in this browser session).
  // The TUI menu never reaches the transcript, so we keep the picks here and
  // stitch them into the chat by timestamp — see AnsweredMenu / the timeline.
  const [answered, setAnswered] = useState<AnsweredMenu[]>([])
  const recordAnswer = (opt: { n: number; text: string }) =>
    setAnswered((prev) => [...prev, { ts: new Date().toISOString(), question: s.menuQuestion ?? '', n: opt.n, text: opt.text }])
  // Poll bookkeeping as refs so the poll closure never acts on stale state: the
  // last-seen disk fingerprint (echoed so unchanged polls skip the payload) and
  // whether anything is on screen yet (gates the loading/error notes).
  const histRevRef = useRef('')
  const hasHistRef = useRef(false)
  // Whether the viewer is pinned to the bottom. Auto-scroll only follows new
  // output while pinned; once you scroll up it stays put, and scrolling back to
  // the bottom resumes following. Re-opening the viewer starts pinned.
  const pinnedRef = useRef(true)
  const onTranscriptScroll = () => {
    const el = preRef.current
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }
  // Same pinning for the chat view's scroll container (the two panes are
  // mutually exclusive, so they can share pinnedRef).
  const onHistScroll = () => {
    const el = histRef.current
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  // Voice: 🔊 speaks a `claude -p` recap (TTS); 🎤 dictates a prompt (STT → box, the
  // shared live-transcription hook). They share the mic, so they stay mutually exclusive.
  const dict = useDictation(text, setText)
  // Keep dictated text's tail in view in the reply box too (same live-ASR behavior as
  // the spawn field); unfocused-only, so manual editing keeps its caret.
  const promptRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    scrollFieldToEnd(promptRef.current, false)
  }, [text])

  // When this agent's ship actually LANDS — its shipState flips to 'shipped' as
  // the poll picks up ATLAS:SHIPPED — the merge has just bumped master's ahead-
  // count. Kick the Deploy-master poll at that moment so "Deploy master · N ahead"
  // catches up the instant it lands. The enqueue-time kick in ship() is only a
  // ~2-min burst guess; a queued or slow ship merges after it expires, leaving the
  // count to lag until a reload. selfDeploy (the dashboard) is the only project
  // whose merges feed that button.
  const wasShipped = useRef(s.shipState === 'shipped')
  useEffect(() => {
    const shipped = s.shipState === 'shipped'
    if (selfDeploy && shipped && !wasShipped.current) kickDeploy()
    wasShipped.current = shipped
  }, [s.shipState, selfDeploy])

  // Clamp + scroll the spawn prompt in the header when it spills past ~2 lines,
  // so a long initial prompt doesn't swallow the card. Short prompts stay on one
  // baseline (no scroll container) — the common case is untouched. Measured (not
  // a char-count guess), so it's right at every card width.
  const taskRef = useRef<HTMLSpanElement>(null)
  const [taskClamp, setTaskClamp] = useState(false)
  useEffect(() => {
    const el = taskRef.current
    if (!el) return
    const measure = () => {
      const lh = parseFloat(getComputedStyle(el).lineHeight) || 0
      setTaskClamp(lh > 0 && el.scrollHeight > lh * 2 + 1)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [s.title, s.task, fullscreen])

  // When an agent flips to "needs input", auto-open the transcript so the
  // question/options it's blocked on are visible (and answerable). Only on the
  // transition — if you then collapse it, it stays collapsed until the next ask.
  const prevStatus = useRef(s.status)
  useEffect(() => {
    if (s.status === 'idle' && prevStatus.current !== 'idle') setExpanded(true)
    prevStatus.current = s.status
  }, [s.status])

  // Also open it the moment a menu/autocomplete is detected (it can appear while
  // already idle — e.g. an @/ dropdown opens), so the options are in view.
  const prevMenu = useRef(s.menu)
  useEffect(() => {
    if (s.menu && !prevMenu.current) setExpanded(true)
    prevMenu.current = s.menu
  }, [s.menu])

  // While expanded, pull the fuller transcript; keep refreshing while the agent
  // is alive — 'running' (working) or 'idle' (its menu changes as you navigate).
  // `reloadNonce` forces an immediate reload right after a keypress. Stops once
  // the session is done. (The list view only carries the last line.)
  useEffect(() => {
    if (!expanded || histMode) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const load = async () => {
      const out = await fetchAgentOutput(s.id)
      if (!alive) return
      if (out != null) setTranscript(out)
      if (s.status === 'running' || s.status === 'idle') timer = setTimeout(load, 5000)
    }
    load()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [expanded, histMode, s.id, s.status, reloadNonce])

  // Chat view data: fetch on open, then keep polling while the agent is alive
  // (same 5s cadence as the terminal poll). Each poll echoes the last `rev`, so
  // an unchanged transcript costs the server a few stats and the wire ~nothing;
  // on change the memoized bubbles mean only NEW messages re-render. A transient
  // poll failure keeps the current view (the next tick retries) — the error note
  // only shows when there's nothing on screen yet.
  useEffect(() => {
    if (!expanded || !histMode) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    setHistBusy(!hasHistRef.current)
    setHistErr('')
    const load = async () => {
      let h: Awaited<ReturnType<typeof fetchAgentHistory>> = null
      try {
        h = await fetchAgentHistory(s.id, histRevRef.current || undefined)
      } catch {
        h = null
      }
      if (!alive) return
      if (h && 'unchanged' in h) {
        // nothing new on disk — keep what's shown
      } else if (h) {
        histRevRef.current = h.rev || ''
        hasHistRef.current = true
        setHistErr('') // a retry after a transient failure clears the note
        setHistory(h)
      } else if (!hasHistRef.current) {
        setHistErr('Could not load history')
      }
      setHistBusy(false)
      if (s.status === 'running' || s.status === 'idle') timer = setTimeout(load, 5000)
    }
    load()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [expanded, histMode, s.id, s.status, reloadNonce])

  // Re-pin to the bottom whenever the viewer (re)opens OR its container changes —
  // entering/leaving full-screen and showing/hiding the app pane each mount a
  // FRESH <pre> (the body is portaled into a different parent, and the split-wrap
  // swaps in/out), which the browser starts at scrollTop 0. Without re-pinning, a
  // toggle would strand a previously scrolled-up pane at the top. This is a layout
  // effect (not passive) and declared BEFORE the snap below so, on the same commit,
  // the re-pin lands first and the snap then reads pinnedRef === true. It re-runs
  // only when the container actually changes (not on every transcript poll), so
  // reading scrollback mid-stream is preserved.
  useLayoutEffect(() => {
    if (expanded) pinnedRef.current = true
  }, [expanded, histMode, fullscreen, showApp, appPeek])

  // Follow the latest output as it streams in — but only while pinned to the
  // bottom, so reading scrollback isn't interrupted by new output. This MUST be
  // a layout effect, not a passive one: each poll swaps the whole <pre> for a
  // fresh tmux snapshot, and a shorter snapshot makes the browser clamp scrollTop
  // toward 0 and fire a scroll event. A passive (rAF-flushed) effect runs *after*
  // the browser's scroll steps, so onTranscriptScroll would read that clamped
  // (near-top) position first and flip pinnedRef false — suppressing this snap and
  // stranding the pane at the top. Running synchronously at commit beats the scroll
  // event, so our scroll-to-bottom lands first and the event then reads "pinned".
  // `fullscreen`/`showApp` are deps too: a full-screen (or app-pane) toggle mounts
  // a brand-new <pre> at scrollTop 0, and [transcript, expanded] alone don't change
  // on that toggle — so without them the snap never fires for the new element and
  // the pane stays at the TOP (start of session) until the next content change, or
  // forever if the agent is idle and its output is unchanged (Preact bails the
  // re-render when setTranscript gets an identical string). This is the mobile
  // symptom, where full-screen is the primary way the card is used. `histMode` is a
  // dep for the same reason: flipping the 📜 toggle back to live swaps the history
  // <div> out for a fresh <pre> at scrollTop 0, so it must re-snap to the bottom.
  useLayoutEffect(() => {
    if (expanded && pinnedRef.current && preRef.current)
      preRef.current.scrollTop = preRef.current.scrollHeight
  }, [transcript, expanded, histMode, fullscreen, showApp, appPeek])

  // The chat view opens scrolled to the BOTTOM — the latest turn — mirroring the
  // live tail, and then FOLLOWS new messages as the live poll appends them, but
  // only while pinned (same rule as the terminal pane: scrolling up to read
  // history must not be yanked back down by the next poll). The re-pin layout
  // effect above runs first on container swaps (full-screen / app-pane toggles
  // portal a fresh <div> at scrollTop 0), so those land at the end again.
  useLayoutEffect(() => {
    if (expanded && histMode && pinnedRef.current && histRef.current)
      histRef.current.scrollTop = histRef.current.scrollHeight
  }, [history, histMode, expanded, fullscreen, showApp, appPeek])

  // Full-screen the viewer: the transcript + controls take over the whole
  // viewport (portaled to <body>, since the card's backdrop-filter would
  // otherwise trap a position:fixed child). Entering forces the transcript open;
  // Esc exits, and the page scroll is locked while it's up (same as NoteReader).
  const toggleFullscreen = () => {
    setFullscreen((v) => {
      if (!v) setExpanded(true)
      return !v
    })
  }
  useEffect(() => {
    if (!fullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false)
    }
    document.addEventListener('keydown', onKey)
    const unlock = lockBodyScroll()
    return () => {
      document.removeEventListener('keydown', onKey)
      unlock()
    }
  }, [fullscreen])
  // Open the app-only full-screen — swap out of the transcript full-screen so the
  // two overlays never stack.
  const openAppFull = () => {
    setFullscreen(false)
    setAppFull(true)
  }
  // Esc exits the app-only full-screen + lock page scroll while it's up (mirrors
  // the transcript full-screen above).
  useEffect(() => {
    if (!appFull) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setAppFull(false)
    }
    document.addEventListener('keydown', onKey)
    const unlock = lockBodyScroll()
    return () => {
      document.removeEventListener('keydown', onKey)
      unlock()
    }
  }, [appFull])

  // Attach picked files (capped at MAX_IMAGES total), reading each to a data URL
  // for upload. Allowlisted by extension (CSV etc. report MIME unreliably). The
  // input is cleared so re-picking the same file fires.
  const addImages = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement
    const files = Array.from(input.files || [])
    input.value = ''
    if (!files.length) return
    const read = await Promise.all(
      files.map(async (f) => ({ name: f.name, dataUrl: await readAsDataUrl(f) })),
    )
    setImages((prev) => [...prev, ...read].slice(0, MAX_IMAGES))
  }

  // One path for all three ways to deliver typed text:
  //  - 'send'      → straight to the prompt (used when the agent is idle)
  //  - 'interrupt' → Esc the current turn, then send now (keeps work so far)
  //  - 'queue'     → park it; the backend delivers it when the turn finishes
  const deliver = async (mode: 'send' | 'interrupt' | 'queue') => {
    const t = text.trim()
    if ((!t && !images.length) || busy) return
    setBusy(true)
    setSendErr('')
    const body = { id: s.id, text: t, images: images.length ? images : undefined }
    const r =
      mode === 'interrupt' ? await interruptAgent(body)
      : mode === 'queue' ? await queueAgent(body)
      : await promptAgent(body)
    setBusy(false)
    if (r.ok) {
      setText('')
      setImages([])
      onChanged()
    } else if (r.error === 'menu') {
      // Backend caught a choice menu the card hadn't seen yet (poll lag) — show
      // the same warning the proactive guard does, and keep the typed text.
      setMenuWarn(true)
      if (!expanded) setExpanded(true)
    } else {
      setSendErr(r.error || `${mode} failed`)
    }
  }

  // Enter / the form's submit picks the safe default for the current state:
  // queue while the agent is running (non-destructive), send when it's idle.
  // BUT if a choice menu is open, a plain send would be typed into it and the
  // trailing Enter accepts the highlighted option — so hold the text back and
  // warn instead (the operator answers via the respond toolbar, or explicitly
  // dismisses the menu and sends).
  const send = (e: Event) => {
    e.preventDefault()
    if (s.status === 'idle' && s.menuKind === 'choice' && (text.trim() || images.length)) {
      setMenuWarn(true)
      if (!expanded) setExpanded(true)
      return
    }
    deliver(s.status === 'running' ? 'queue' : 'send')
  }

  // Schedule the typed text to be queued to this agent at a future time (the ⏱
  // button beside Send/Queue). At fire time it lands in the agent's normal queue,
  // delivered at its next idle — gentle, never mid-turn. Text-only.
  const scheduleSend = async (at: string) => {
    const t = text.trim()
    if (!t) return { ok: false, error: 'type a prompt first' }
    const r = await scheduleAgent({ action: 'prompt', at, payload: { id: s.id, text: t } })
    if (r.ok) {
      setText('')
      onChanged()
    }
    return r
  }
  // Pending scheduled prompts aimed at THIS agent (newest due first via the server).
  const pendingSends = (scheduled ?? []).filter((j) => j.action === 'prompt' && j.targetId === s.id)
  const cancelScheduled = async (id: string) => {
    if (busy) return
    const r = await unscheduleAgent(id)
    if (r.ok) onChanged()
  }

  // The warning's escape hatch: dismiss the open menu (Esc) and, once it's gone,
  // send the typed text as a normal prompt (force past the backend menu guard,
  // since the pane may not have repainted yet). This is the deliberate path for
  // "I didn't want to answer the question — I want to say this instead."
  const dismissMenuAndSend = async () => {
    const t = text.trim()
    if (busy || (!t && !images.length)) return
    setBusy(true)
    setSendErr('')
    await sendAgentKeys({ id: s.id, keys: ['Escape'] })
    await new Promise((r) => setTimeout(r, 300))
    const r = await promptAgent({ id: s.id, text: t, images: images.length ? images : undefined, force: true })
    setBusy(false)
    if (r.ok) {
      setText('')
      setImages([])
      setMenuWarn(false)
      if (!expanded) setExpanded(true)
      onChanged()
    } else {
      setSendErr(r.error || 'send failed')
    }
  }

  // Cancel a parked prompt (the ⏱ chip's ×) — that one by its queue index.
  const cancelQueued = async (index: number) => {
    if (busy) return
    setBusy(true)
    const r = await unqueueAgent(s.id, index)
    setBusy(false)
    if (r.ok) onChanged()
  }

  // Send the NEXT queued prompt now instead of waiting for the turn to end (the ⏱
  // chip's ⏩): interrupts the current turn and delivers the head prompt at once.
  const sendQueuedNow = async () => {
    if (busy) return
    setBusy(true)
    setSendErr('')
    const r = await sendQueuedNowAgent(s.id)
    setBusy(false)
    if (r.ok) onChanged()
    else setSendErr(r.error || 'send now failed')
  }

  // Drive an interactive menu (arrow-select / accept / cancel) without typing —
  // sends a raw key into the TUI, then refreshes so the result shows promptly.
  const sendKey = async (key: string) => {
    if (busy) return
    // Enter on an open choice menu accepts the highlighted option — a resolved
    // choice, so echo it into the chat the same as the option buttons do.
    const accepting = key === 'Enter' && s.menuKind === 'choice'
    const opt = accepting ? s.menuOptions?.find((o) => o.n === (s.menuHighlighted ?? s.menuOptions?.[0]?.n)) : null
    setBusy(true)
    setMenuWarn(false) // answering via the toolbar clears any "menu open" warning
    const r = await sendAgentKeys({ id: s.id, keys: [key] })
    setBusy(false)
    if (r.ok && opt) recordAnswer(opt)
    if (!expanded) setExpanded(true)
    setReloadNonce((n) => n + 1)
    onChanged()
  }

  // Select option `n` in the TUI's numbered choice menu (the chat view's menu
  // buttons): move the ❯ highlight from where it sits and confirm — the same
  // arrow+Enter the respond toolbar and the Telegram bare-number reply send
  // (digits don't select in every menu; moving the highlight always does).
  const pickOption = async (n: number) => {
    if (busy) return
    const opt = s.menuOptions?.find((o) => o.n === n)
    const from = s.menuHighlighted ?? s.menuOptions?.[0]?.n ?? 1
    const delta = n - from
    const keys = [...Array<string>(Math.abs(delta)).fill(delta > 0 ? 'Down' : 'Up'), 'Enter']
    setBusy(true)
    setMenuWarn(false)
    const r = await sendAgentKeys({ id: s.id, keys })
    setBusy(false)
    if (r.ok && opt) recordAnswer(opt) // echo the resolved choice into the chat
    setReloadNonce((x) => x + 1)
    onChanged()
  }

  // Autocomplete confirm: Tab inserts the highlighted item, then Enter submits.
  // They must go as two sends with a gap — batched together the Enter arrives
  // before the dropdown closes and gets swallowed (verified against the TUI).
  const insertAndSend = async () => {
    if (busy) return
    setBusy(true)
    await sendAgentKeys({ id: s.id, keys: ['Tab'] })
    await new Promise((r) => setTimeout(r, 300))
    await sendAgentKeys({ id: s.id, keys: ['Enter'] })
    setBusy(false)
    if (!expanded) setExpanded(true)
    setReloadNonce((n) => n + 1)
    onChanged()
  }

  // Dev agent paired with an Atlas worker: the ✕ is a graceful close (like a
  // knowledge chat) — first asks for a recap that the worker logs to the Atlas.
  const paired = !knowledge && !!s.atlasWorker

  const kill = async () => {
    if (busy) return
    // Plain dev agents: confirm before killing (the ✕ ends the session for good).
    // Knowledge agents AND Atlas-paired dev agents have a graceful two-step close
    // (first ✕ asks for a wrap-up/recap, second forces), so they skip this prompt.
    if (!knowledge && !paired && !window.confirm(`Kill the agent on ${s.branch}?\nThe worktree and branch are kept — this only ends the session.`)) return
    // The graceful close surfaces its wrap-up phases ("wrapping up" / "saving to
    // Atlas") on the card, not in the transcript — so leave full screen to make
    // them visible, same as ship() does for the merge progress.
    if (knowledge || paired) {
      setFullscreen(false)
      setAppFull(false)
    }
    setBusy(true)
    const r = await killAgent(s.id)
    setBusy(false)
    if (r.ok) onChanged()
  }

  // Trigger the agent's baked-in reconcile protocol (rebase onto master).
  // Always queued: parked in the session's queued slot and delivered when the
  // turn finishes, so pressing it mid-work is non-destructive and shows up as
  // the ⏱ queued chip instead of being typed into a busy TUI.
  const sync = async () => {
    if (busy) return
    setBusy(true)
    setSendErr('')
    const r = await queueAgent({
      id: s.id,
      text: 'Sync with master now using your sync protocol: git fetch origin, rebase onto origin/master, push --force-with-lease if clean; if anything is risky or ambiguous, STOP and summarize it for me instead of pushing.',
    })
    setBusy(false)
    if (r.ok) onChanged()
    else setSendErr(r.error || 'sync failed')
  }

  // Ship: enqueue into the SERIAL ship train (agent-local.mjs). The backend
  // delivers the ship prompt when this agent reaches the front AND is idle, then
  // waits for ATLAS:SHIPPED before starting the next — so pressing Ship on
  // several ready agents lines them up instead of racing the shared
  // /workspace/.git (or landing un-integrated on master). For the dashboard
  // (selfDeploy) the merge is taken live by the operator's Deploy-master button;
  // every other project has no deploy run, so the merge IS the delivery.
  const ship = async () => {
    if (busy) return
    // Stay in full screen — the ship/merge progress shows in the full-screen head too,
    // and the switcher strip lets you hop to another agent without leaving. (Ship no
    // longer kicks you out of full screen.)
    setBusy(true)
    setSendErr('')
    const r = await shipAgent({ id: s.id, text: buildShipPrompt(selfDeploy) })
    setBusy(false)
    if (r.ok) {
      onChanged()
      // A self-deploy merge bumps master's ahead-count — kick the Deploy-master
      // button so it catches up within seconds of the merge landing (it polls
      // on its own 30s tick otherwise, which lagged until a reload).
      if (selfDeploy) kickDeploy()
    } else setSendErr(r.error || 'ship failed')
  }

  // Pull this agent back out of the ship train before it ships (the ⤴#N chip's
  // click). The one currently merging can't be cancelled — the backend refuses.
  const unship = async () => {
    if (busy) return
    setBusy(true)
    setSendErr('')
    const r = await unshipAgent(s.id)
    setBusy(false)
    if (r.ok) onChanged()
    else setSendErr(r.error || 'cancel failed')
  }

  // Destructive: kill + remove the worktree + delete the branch (after merge).
  // For an Atlas-paired agent this first runs the graceful recap → ingest (like the
  // ✕), so the session is logged to the Atlas before the worktree/branch are torn
  // down; the card then shows the wrap-up phases until the reaper finishes.
  const cleanup = async () => {
    if (busy) return
    const msg = paired
      ? `Clean up ${s.branch}?\nThe paired Atlas worker logs this session to the Atlas first, then the worktree is removed and the branch DELETED — make sure it's merged. This can't be undone.`
      : `Remove the worktree and DELETE branch ${s.branch}?\nMake sure it's merged — this can't be undone.`
    if (!window.confirm(msg)) return
    // Leave full screen so the wrap-up phases show on the card in the normal view.
    setFullscreen(false)
    setAppFull(false)
    setBusy(true)
    const r = await cleanupAgent(s.id)
    setBusy(false)
    if (r.ok) onChanged()
  }

  // Revive a dormant agent (stranded by a tmux-server death): relaunch its Claude
  // session on the existing worktree. Memory-gated server-side, so surface the
  // refusal ("box low on memory…") rather than silently doing nothing.
  const revive = async () => {
    if (busy) return
    setBusy(true)
    setSendErr('')
    const r = await reviveAgent(s.id)
    setBusy(false)
    if (r.ok) onChanged()
    else setSendErr(r.error || 'revive failed')
  }

  // Abort an in-flight graceful close (✕/⌦ hit by mistake — e.g. on the wrong
  // agent). The safe direction, so no confirm: it stops the wrap-up and clears the
  // closing markers; the agent (worktree + branch + worker) keeps running.
  const abortClose = async () => {
    if (busy) return
    setBusy(true)
    const r = await abortAgentClose(s.id)
    setBusy(false)
    if (r.ok) onChanged()
  }

  const prUrl = github && s.branch ? `${github.replace(/\/$/, '')}/compare/${s.branch}?expand=1` : null

  // A pending CHOICE menu is a decision the agent is blocked on — flag the row so
  // the head dot + status read "needs decision" (more urgent than plain idle), so
  // you notice before typing past it.
  const needsDecision = s.status === 'idle' && s.menuKind === 'choice'
  // Stranded by a tmux-server death (reboot/OOM): worktree intact, just no live
  // session. The card collapses to a Revive button (+ discard) — the work buttons
  // and the prompt composer would only act on a session that isn't there.
  const dormant = s.status === 'dormant'
  // The agent is serving a live app (Streamlit etc.) on its slot — offer the
  // side-by-side pane in full-screen, and a toggle to show/hide it.
  const hasApp = !!s.appUp && !!s.appPath
  // A dev agent always has an app SLOT (a path) even when nothing is serving on
  // it yet. In full-screen the operator can still summon the pane — it then
  // explains why it's empty (which port + base-path the app must bind) instead
  // of the pane silently not existing, which reads as "the feature is broken".
  const canApp = !knowledge && !!s.appPath
  // A serving app auto-shows (showApp); an empty slot is revealed only on demand
  // (appPeek) so it never steals transcript width from app-less agents.
  const paneOpen = hasApp ? showApp : appPeek
  const showAppPane = fullscreen && canApp && paneOpen
  // The base path the agent's app must serve under (appPath without the slashes).
  const appBasePath = (s.appPath || '').replace(/^\/|\/$/g, '')
  const cls = `agent agent--${s.status}${s.interrupted ? ' agent--interrupted' : ''}${s.menu ? ' agent--menu' : ''}${needsDecision ? ' agent--decision' : ''}${expanded ? ' agent--expanded' : ''}${fullscreen ? ' agent--fullscreen' : ''}`
  // Head label: once the spawn-time short title is generated, show THAT (the same
  // label the agents overview uses) instead of the start of the raw prompt; the
  // full prompt moves to the hover tooltip. Until it lands, fall back to the raw
  // task and keep clamping a long prompt so it doesn't swallow the header.
  const headText = s.title || s.task
  const taskTip = s.title || taskClamp ? s.task : undefined
  // The chat is the on-disk messages plus any menus this operator resolved here
  // (which never reach the transcript), stitched together by timestamp so a
  // "you answered" bubble sits where its menu was, before the agent's next turn.
  const timeline = useMemo(() => {
    const items: Array<{ key: string; ts: string; msg?: AgentHistoryMessage; ans?: AnsweredMenu }> = []
    history?.messages.forEach((m, i) => items.push({ key: `m${i}`, ts: m.ts ?? '', msg: m }))
    answered.forEach((a, i) => items.push({ key: `a${i}-${a.ts}`, ts: a.ts, ans: a }))
    return items.sort((x, y) => (x.ts < y.ts ? -1 : x.ts > y.ts ? 1 : 0))
  }, [history, answered])
  // The transcript pane is either the chat view (default: the full on-disk
  // conversation as live-polled markdown bubbles) or the raw tmux terminal (the
  // sticky >_/📜 toggle). Same element in the plain and split-with-app layouts,
  // so define it once.
  const transcriptPane = histMode ? (
    <div ref={histRef} className="agent__history" onScroll={onHistScroll}>
      {histBusy && !history ? <div className="agent__history-note">loading full history…</div> : null}
      {histErr ? <div className="agent__history-note agent__history-note--err">{histErr}</div> : null}
      {history && !history.messages.length && !histBusy ? (
        <div className="agent__history-note">No saved transcript on disk yet.</div>
      ) : null}
      {history && history.sessions > 1 ? (
        <div className="agent__history-note">stitched from {history.sessions} sessions (across revives)</div>
      ) : null}
      {history?.truncated ? (
        <div className="agent__history-note">
          history truncated — showing the most recent {history.messages.length} messages
        </div>
      ) : null}
      {timeline.map((t) =>
        t.msg ? <HistMsg key={t.key} m={t.msg} /> : <AnsweredMsg key={t.key} a={t.ans!} />,
      )}
      {s.status === 'running' ? (
        <div className="agent__history-note agent__history-live">working…</div>
      ) : null}
      {/* A pending numbered menu, as native buttons: the on-disk transcript never
          carries the TUI's interactive prompts, so the sessions poll ships the
          parsed options instead (menuOptions). Clicking replays the same
          arrow+Enter the respond toolbar sends. */}
      {s.status === 'idle' && s.menuKind === 'choice' ? (
        <div className="agent__history-menu">
          <div className="agent__history-menu-title hud-label">⚡ waiting on your choice</div>
          {/* The prompt above the options, so it's clear WHAT is being asked —
              not just bare Yes/No buttons (parsed from the pane, menu.mjs). */}
          {s.menuQuestion ? <div className="agent__history-menu-q">{s.menuQuestion}</div> : null}
          {s.menuOptions?.length ? (
            s.menuOptions.map((o) => (
              <button
                key={o.n}
                type="button"
                className={`agent__history-opt${o.n === s.menuHighlighted ? ' agent__history-opt--hl' : ''}`}
                disabled={busy}
                onClick={() => pickOption(o.n)}
              >
                <span className="agent__history-opt-n tnum">{o.n}.</span> {o.text}
              </button>
            ))
          ) : (
            <div className="agent__history-note">
              a menu is open — its options aren't available here; use the terminal view (&gt;_ above)
            </div>
          )}
        </div>
      ) : null}
      {s.status === 'idle' && s.menuKind === 'complete' ? (
        <div className="agent__history-note">
          an @//slash autocomplete is open — switch to the terminal view (&gt;_ above) to see it
        </div>
      ) : null}
    </div>
  ) : (
    <pre ref={preRef} className="agent__transcript" onScroll={onTranscriptScroll}>
      {transcript == null ? 'loading…' : renderTranscript(transcript)}
    </pre>
  )
  const body = (
    <>
      <div className="agent__head">
        <span className="agent__dot" />
        <span
          ref={taskRef}
          className={`agent__task${taskClamp ? ' agent__task--clamp' : ''}`}
          title={taskTip}
        >
          {headText}
        </span>
        {s.branch ? <span className="agent__branch tnum">{s.branch}</span> : null}
        {/* Repo is redundant when the card is already scoped to one repo. */}
        {!scoped ? <span className="agent__repo">{s.repo}</span> : null}
        {s.model || (s.contextTokens != null && s.contextWindow) ? (
          <span className="agent__run">
            {s.model ? (
              <span
                className="agent__meta"
                title={`model ${s.model} · effort ${s.effort ?? '—'}`}
              >
                {modelLabel(s.model)}
                {s.effort ? ` · ${EFFORT_LABEL[s.effort] ?? s.effort}` : ''}
              </span>
            ) : null}
            {s.contextTokens != null && s.contextWindow ? (
              <ContextMeter tokens={s.contextTokens} window={s.contextWindow} />
            ) : null}
          </span>
        ) : null}
        <span className="agent__status hud-label">
          {s.closing
            ? s.closePhase === 'ingest'
              ? 'saving to Atlas'
              : 'wrapping up'
            : s.interrupted
              ? knowledge
                ? 'interrupted'
                : 'lost'
              : needsDecision
                ? 'needs decision'
                : (knowledge ? KNOWLEDGE_STATUS_LABEL : STATUS_LABEL)[s.status]}
        </span>
        <div className="agent__actions">
          {dormant ? (
            <button
              type="button"
              className="agent__act agent__revive"
              onClick={revive}
              disabled={busy}
              title="revive — relaunch this agent's session on its existing worktree (memory permitting)"
            >
              ↻
            </button>
          ) : null}
          {prUrl ? (
            <a
              className="agent__act agent__pr"
              href={prUrl}
              target="_blank"
              rel="noreferrer"
              title={`open / view PR for ${s.branch}`}
            >
              ↗
            </a>
          ) : null}
          {!dormant && !knowledge ? (
            <button
              type="button"
              className="agent__act agent__sync"
              onClick={sync}
              disabled={busy}
              title="sync: queue a rebase of this branch onto master (delivered when the agent next goes idle)"
            >
              ⟳
            </button>
          ) : null}
          {dormant || knowledge ? null : s.shipState === 'shipped' ? (
            // The agent confirmed its PR merged (ATLAS:SHIPPED) — ship is done.
            <span
              className="agent__act agent__shipped"
              title={`shipped${s.shipInfo ? `: ${s.shipInfo}` : ''} — PR merged by the agent${selfDeploy ? '; deploy stays the Deploy-master button' : ''}`}
            >
              ✓
            </span>
          ) : s.shipQueue?.active ? (
            // At the front of the ship train, merging now — the train moves to the
            // next agent once this one prints ATLAS:SHIPPED.
            <span className="agent__act agent__ship--active" title="shipping… — merging this PR; the ship queue advances when it lands">
              <span className="agent__spin" aria-label="shipping" />
            </span>
          ) : s.shipQueue && s.shipQueue.pos > 1 ? (
            // Genuinely waiting BEHIND other ships — show its place; click to pull it
            // back out. (pos 1 is the head, rendered as "ship pending" below, not a
            // "#1 / 0 ahead" queue position.)
            <button
              type="button"
              className="agent__act agent__shipq"
              onClick={unship}
              disabled={busy}
              title={`#${s.shipQueue.pos} in the ship queue — ships after the ${s.shipQueue.pos - 1} ahead merge; click to cancel`}
            >
              ⤴<sup className="agent__shipq-pos tnum">{s.shipQueue.pos}</sup>
            </button>
          ) : s.shipQueue ? (
            // Head of the train (nothing ahead), not yet merging — the ship is pending:
            // it merges as soon as the agent goes idle. Show it as in-flight rather than
            // as a queue slot; still cancellable until it actually starts merging.
            <button
              type="button"
              className="agent__act agent__shipq"
              onClick={unship}
              disabled={busy}
              title="ship pending — merges as soon as the agent is idle; click to cancel"
            >
              <span className="agent__spin" aria-label="ship pending" />
            </button>
          ) : (
            <button
              type="button"
              className={`agent__act agent__ship${s.shipState === 'ready' ? ' agent__ship--ready' : ''}`}
              onClick={ship}
              disabled={busy}
              title={`${s.shipState === 'ready' ? 'agent reports this is READY TO SHIP — ' : ''}ship: queue re-sync onto latest master → push → merge the PR. Ships one at a time via the ship queue (delivered when the agent next goes idle)${selfDeploy ? '; deploy stays the Deploy-master button' : ''}`}
            >
              ⤴
            </button>
          )}
          {expanded ? (
            <button
              type="button"
              className={`agent__act agent__hist${histMode ? ' agent__hist--active' : ''}`}
              onClick={() => {
                setHistMode((v) => {
                  const chat = !v
                  persistHistMode(chat) // sticky: this choice becomes every card's default
                  return chat
                })
                setExpanded(true)
              }}
              title={
                histMode
                  ? 'show the raw terminal (sticks as the default view)'
                  : 'show the chat view — the full saved conversation, rendered (sticks as the default view)'
              }
            >
              {histMode ? '>_' : '📜'}
            </button>
          ) : null}
          <button
            type="button"
            className="agent__act agent__expand"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'hide full output' : 'show full output'}
          >
            {expanded ? '▾' : '▸'}
          </button>
          <button
            type="button"
            className={`agent__act agent__fs${fullscreen ? ' agent__fs--active' : ''}`}
            onClick={toggleFullscreen}
            title={fullscreen ? 'exit full screen (Esc)' : 'full-screen the viewer'}
          >
            ⛶
          </button>
          {fullscreen && canApp ? (
            <button
              type="button"
              className={`agent__act agent__appbtn${paneOpen ? ' agent__appbtn--active' : ''}${!hasApp ? ' agent__appbtn--empty' : ''}`}
              onClick={() => (hasApp ? setShowApp((v) => !v) : setAppPeek((v) => !v))}
              title={
                !hasApp
                  ? paneOpen
                    ? 'hide the empty app pane'
                    : 'no app is serving — show where it must bind'
                  : showApp
                    ? 'hide the live app pane'
                    : 'show the live app beside the transcript'
              }
            >
              ◧
            </button>
          ) : null}
          {hasApp ? (
            <button
              type="button"
              className="agent__act agent__appfull"
              onClick={openAppFull}
              title="open the live app full-screen (no transcript) — best on mobile"
            >
              ▣
            </button>
          ) : null}
          {!knowledge ? (
            s.closing ? (
              // The graceful close is already running (recap → Atlas ingest → merge,
              // then the worktree/branch teardown). The cleanup POST returns at once
              // and only sets the closing flags, so swap ⌦ for a spinner — the same
              // affordance as the ship train's active spinner — so the operator can
              // see the Atlas save is still in flight (it can take a minute+).
              <span
                className="agent__act agent__cleanup--saving"
                title={
                  s.closePhase === 'ingest'
                    ? 'saving to Atlas — the paired worker is logging this session; the worktree + branch are removed once it merges'
                    : 'wrapping up — waiting for the session recap before the Atlas worker logs it'
                }
              >
                <span className="agent__spin" aria-label="saving to Atlas" />
              </span>
            ) : (
              <button
                type="button"
                className="agent__act agent__cleanup"
                onClick={cleanup}
                disabled={busy}
                title={
                  paired
                    ? 'cleanup: logs the session to the Atlas (recap → ingest), then removes worktree + deletes branch (after merge)'
                    : 'cleanup: remove worktree + delete branch (after merge)'
                }
              >
                ⌦
              </button>
            )
          ) : null}
          {s.closing ? (
            // A graceful close is running — offer a way BACK (the operator may have
            // hit ✕/⌦ on the wrong agent). ↩ stops the wrap-up and keeps the agent;
            // ✕ beside it still forces the close through.
            <button
              type="button"
              className="agent__act agent__abort"
              onClick={abortClose}
              disabled={busy}
              title="abort — cancel the close and keep this agent running (stops the wrap-up; nothing is removed)"
            >
              ↩
            </button>
          ) : null}
          <button
            type="button"
            className="agent__act agent__kill"
            onClick={kill}
            disabled={busy}
            title={
              knowledge
                ? isTypedVault(s.vault)
                  ? s.closing
                    ? 'force-close now (skip the Atlas wrap-up)'
                    : 'end chat — first asks the agent to work any unsaved insights into the Atlas, then closes (press again to force)'
                  : s.closing
                    ? 'force-close now (skip the wrap-up)'
                    : 'end chat — first asks the agent to work any unsaved insights into the vault, then closes (press again to force)'
                : paired
                  ? s.closing
                    ? 'force-close now (skip the Atlas wrap-up)'
                    : 'end session — first asks for a recap, then the paired Atlas worker logs it to the Atlas (press again to force)'
                  : 'kill agent (keeps worktree + branch)'
            }
          >
            ✕
          </button>
        </div>
      </div>
      {!dormant ? <AgentTimer s={s} knowledge={knowledge} /> : null}
      {s.subAgents && s.subAgents.length ? (
        <div className="agent__subs" title="sub-agents this agent spawned via the Task tool">
          <span className="agent__subs-label hud-label">⚡ sub-agents</span>
          {s.subAgents.map((a, i) => (
            <span
              key={i}
              className={`agent__sub${a.active ? ' agent__sub--active' : ' agent__sub--done'}`}
              title={`${a.label} — ${a.active ? 'running' : 'finished'}`}
            >
              {a.micro || a.label}
            </span>
          ))}
        </div>
      ) : null}
      {s.bgJobs && s.bgJobs.length ? (
        <div className="agent__jobs" title="background jobs this agent launched (Bash, run in background)">
          <span className="agent__jobs-label hud-label">⚙ background jobs</span>
          {s.bgJobs.map((j, i) => (
            <span
              key={i}
              className={`agent__job agent__job--${j.status}`}
              title={`${j.label} — ${JOB_STATUS_TITLE[j.status]}${
                j.sub != null && s.subAgents?.[j.sub] ? ` — spawned by sub-agent "${s.subAgents[j.sub].label}"` : ''
              }`}
            >
              <span className="agent__job-dot" />
              {j.micro || j.label}
            </span>
          ))}
        </div>
      ) : null}
      {s.stats && s.stats.length ? (
        <div className="agent__stats" title="live stats published by the agent while it works">
          {s.stats.map((st, i) => (
            <AgentStat key={st.label} stat={st} gid={`agst-${s.id}-${i}`} />
          ))}
        </div>
      ) : null}
      {expanded ? (
        showAppPane ? (
          // Full-screen split: transcript pinned left, the agent's live app
          // (proxied same-origin via /agent-app/<repo>/) embedded on the right.
          <div className="agent__split-wrap">
            {transcriptPane}
            {hasApp ? (
              <iframe className="agent__app" src={s.appPath} title={`${headText} — live app`} />
            ) : (
              // Nothing serving on the slot — name the port + base-path the app
              // must use, so a blank pane is self-explanatory (and a wrong-port
              // app is obvious) instead of just vanishing.
              <div className="agent__app agent__app--empty">
                <div className="agent__app-empty">
                  <div className="agent__app-empty-title">No live app on this slot</div>
                  <p>
                    Nothing is serving on this agent's app slot
                    {s.appPort != null ? (
                      <>
                        {' '}
                        (port <span className="tnum">{s.appPort}</span>)
                      </>
                    ) : null}
                    .
                  </p>
                  <p>
                    Its web app must listen on{' '}
                    <code>{s.appPort != null ? `port ${s.appPort}` : 'its assigned port'}</code> under
                    base path <code>{appBasePath}</code>.
                  </p>
                  <p className="agent__app-empty-hint">If you just started it, give it a few seconds.</p>
                </div>
              </div>
            )}
          </div>
        ) : (
          transcriptPane
        )
      ) : (
        <div className="agent__output">{s.lastOutput}</div>
      )}
      {s.status === 'idle' ? (
        <div className="agent__keys" role="group" aria-label="respond to agent">
          <span className="agent__keys-label hud-label">
            {s.menu ? (
              <span className="agent__keys-bolt" title="interactive menu detected — navigate, then accept or insert">
                ⚡{' '}
              </span>
            ) : null}
            respond
          </span>
          <button
            type="button"
            className="agent__key"
            onClick={() => sendKey('Up')}
            disabled={busy}
            title="move selection up"
          >
            ↑
          </button>
          <button
            type="button"
            className="agent__key"
            onClick={() => sendKey('Down')}
            disabled={busy}
            title="move selection down"
          >
            ↓
          </button>
          {s.menuKind === 'choice' ? (
            <button
              type="button"
              className="agent__key agent__key--accept"
              onClick={() => sendKey('Enter')}
              disabled={busy}
              title="confirm highlighted option (Enter)"
            >
              ⏎ accept
            </button>
          ) : null}
          {s.menuKind === 'complete' ? (
            <button
              type="button"
              className="agent__key agent__key--accept"
              onClick={insertAndSend}
              disabled={busy}
              title="insert highlighted @//slash completion, then send (Tab → Enter)"
            >
              ⏎ insert &amp; send
            </button>
          ) : null}
          <button
            type="button"
            className="agent__key"
            onClick={() => sendKey('Escape')}
            disabled={busy}
            title="cancel / dismiss (Esc)"
          >
            esc
          </button>
        </div>
      ) : null}
      {images.length ? (
        <div className="agent__imgs" role="group" aria-label="attached files">
          {images.map((img, i) => (
            <span className="agent__img" key={`${img.name}-${i}`} title={img.name}>
              {img.dataUrl.startsWith('data:image/') ? (
                <img className="agent__img-thumb" src={img.dataUrl} alt={img.name} />
              ) : (
                <span className="agent__img-thumb agent__img-thumb--file" aria-hidden="true">
                  📄
                </span>
              )}
              <span className="agent__img-name">{img.name}</span>
              <button
                type="button"
                className="agent__img-rm"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                disabled={busy}
                title="remove attachment"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {queuedList(s.queued).map((q, i, all) => (
        <div className="agent__queued" role="status" key={i}>
          <span className="agent__queued-label hud-label">
            ⏱ queued{all.length > 1 ? ` ${i + 1}/${all.length}` : ''}
          </span>
          <span className="agent__queued-text" title={q.kind === 'atlas-brief' ? q.summary : undefined}>
            {q.kind === 'atlas-brief' ? (
              `📚 Atlas briefing${q.summary ? ` — ${q.summary}` : ''}`
            ) : (
              <>
                {q.text || (q.images ? `${q.images} file${q.images > 1 ? 's' : ''}` : '')}
                {q.text && q.images ? ` (+${q.images} file${q.images > 1 ? 's' : ''})` : ''}
              </>
            )}
          </span>
          {i === 0 ? (
            <button
              type="button"
              className="agent__queued-send"
              onClick={sendQueuedNow}
              disabled={busy}
              title="send now — interrupt the current turn and deliver the next queued prompt immediately"
            >
              ⏩
            </button>
          ) : null}
          <button
            type="button"
            className="agent__queued-rm"
            onClick={() => cancelQueued(i)}
            disabled={busy}
            title="cancel queued prompt"
          >
            ×
          </button>
        </div>
      ))}
      {pendingSends.map((j) => (
        <div className="agent__queued agent__queued--sched" role="status" key={j.id}>
          <span className="agent__queued-label hud-label">⏱ {fmtSchedAt(j.at)}</span>
          <span className="agent__queued-text" title={j.label}>
            {j.label}
          </span>
          <button
            type="button"
            className="agent__queued-rm"
            onClick={() => cancelScheduled(j.id)}
            disabled={busy}
            title="cancel scheduled prompt"
          >
            ×
          </button>
        </div>
      ))}
      {dict.error ? <div className="agents__err">✗ {dict.error}</div> : null}
      {sendErr ? <div className="agents__err">✗ {sendErr}</div> : null}
      {menuWarn && s.menuKind === 'choice' ? (
        <div className="agent__menu-warn" role="alert">
          <span className="agent__menu-warn-text">
            ⚡ A menu is open above — typing here won&apos;t answer it (Enter would accept the highlighted
            option). Pick an option with the respond buttons, or:
          </span>
          <button
            type="button"
            className="agent__menu-warn-send"
            onClick={dismissMenuAndSend}
            disabled={busy || (!text.trim() && !images.length)}
            title="dismiss the menu (Esc), then send your text as a normal prompt"
          >
            Dismiss menu &amp; send
          </button>
          <button
            type="button"
            className="agent__menu-warn-x"
            onClick={() => setMenuWarn(false)}
            title="dismiss this warning"
          >
            ✕
          </button>
        </div>
      ) : null}
      {dormant ? null : (
      <form className="agent__prompt" onSubmit={send}>
        <label
          className={`agent__attach${images.length >= MAX_IMAGES ? ' agent__attach--full' : ''}`}
          title={images.length >= MAX_IMAGES ? `max ${MAX_IMAGES} files` : 'attach file(s) — any type'}
        >
          📎
          <input
            type="file"
            multiple
            hidden
            disabled={busy || images.length >= MAX_IMAGES}
            onChange={addImages}
          />
        </label>
        <input
          ref={promptRef}
          className="capture__input capture__input--sm"
          placeholder={images.length ? 'add a message (optional)…' : 'send a prompt…'}
          value={text}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        {s.status === 'running' ? (
          // While the agent is generating, typed text can either cut in now or
          // wait its turn. Submit (Enter) maps to the non-destructive Queue.
          <>
            <button
              type="button"
              className="btn btn--interrupt"
              onClick={() => deliver('interrupt')}
              disabled={(!text.trim() && !images.length) || busy}
              title="stop the current response and send this now — the work it has done this turn is kept"
            >
              Interrupt &amp; send
            </button>
            <button
              type="submit"
              className="btn"
              disabled={(!text.trim() && !images.length) || busy}
              title="send after the current response finishes"
            >
              Queue
            </button>
          </>
        ) : (
          <button
            type="submit"
            className="btn"
            disabled={(!text.trim() && !images.length) || busy || s.status !== 'idle'}
            title={s.status === 'idle' ? 'send a prompt' : 'session is not running'}
          >
            Send
          </button>
        )}
        <ScheduleButton onSchedule={scheduleSend} disabled={!text.trim() || busy} title="schedule this prompt for later" />
      </form>
      )}
    </>
  )

  // App-only full-screen: a separate body-level overlay holding JUST the agent's
  // live app (no transcript) + a slim bar (title · open-in-new-tab · close). The
  // mobile-friendly way to use the app, and a desktop focus mode.
  const appOverlay =
    appFull && s.appPath
      ? createPortal(
          <div className="agent-app-full" role="dialog" aria-modal="true">
            <div className="agent-app-full__bar">
              <span className="agent-app-full__title" title={s.task}>
                {headText}
              </span>
              <span className="agent-app-full__tag">live app</span>
              <a
                className="agent-app-full__btn"
                href={s.appPath}
                target="_blank"
                rel="noopener noreferrer"
                title="open in a new browser tab"
              >
                ↗
              </a>
              <button
                type="button"
                className="agent-app-full__btn"
                onClick={() => setAppFull(false)}
                title="close (Esc)"
              >
                ✕
              </button>
            </div>
            <iframe className="agent-app-full__frame" src={s.appPath} title={`${headText} — live app`} />
          </div>,
          document.body,
        )
      : null

  // Full-screen takes the row out of the list and into a body-level overlay; the
  // identical body renders either way, so head, transcript, respond toolbar and
  // prompt all keep working — only the container (and its CSS) changes.
  return (
    <>
      {fullscreen ? (
        createPortal(
          <div className={cls} role="dialog" aria-modal="true">
            {/* The same clickable agents overview as the hero, agents only —
                clicking another node swaps straight to THAT agent's full screen
                (this row yields via the focus signal above). */}
            <div className="agent__switch">
              <AgentsOverview switcher currentId={s.id} />
            </div>
            {body}
          </div>,
          document.body,
        )
      ) : (
        <li className={cls}>{body}</li>
      )}
      {appOverlay}
    </>
  )
}
