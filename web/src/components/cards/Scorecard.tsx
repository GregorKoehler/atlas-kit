import { useEffect, useState } from 'preact/hooks'
import { Card, EmptyState } from '../Card'
import { useDashboardSlice } from '../../lib/dashboard'
import { useAgents } from '../../lib/useAgents'
import { AgentStat, fmtDur, useNow } from './AgentList'
import { type Stat, type HeatDay, type AgentSession, type AgentStats, fetchAgentStats } from '../../lib/api'

function TrendArrow({ trend }: { trend?: Stat['trend'] }) {
  if (trend === 'up') return <span className="stat__trend stat__trend--up">▲</span>
  if (trend === 'down') return <span className="stat__trend stat__trend--down">▼</span>
  return <span className="stat__trend stat__trend--flat">·</span>
}

// Compact chip rendering of a static stat — the same mini-tile the live-agent
// plot frames use (label + small value), so grouped scorecard stats match the
// live-agent tiles. Keeps a small trend arrow the live tiles don't carry.
function StatChip({ stat }: { stat: Stat }) {
  return (
    <div className="agent__stat" title={`${stat.label}: ${stat.value}`}>
      <span className="agent__stat-value tnum">
        {stat.value}
        <TrendArrow trend={stat.trend} />
      </span>
      <span className="agent__stat-label hud-label">{stat.label}</span>
    </div>
  )
}

// A GitHub contribution stat fed by refresh-github.mjs — used to anchor the
// cumulative sparkline right after the trio of GitHub tiles.
const isGithubStat = (label: string) =>
  /github contributions/i.test(label) || /^contributions (today|yesterday)$/i.test(label)

// Cumulative contributions over the trailing 365 days, drawn as a small area
// sparkline that matches the heatmap's cyan ramp — sized as a compact chip so it
// sits inline with the GitHub group's tiles. Returns null when there's no
// activity to plot so the tile simply doesn't appear.
function CumulativeTile({ days }: { days: HeatDay[] }) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const cutoff = new Date(today)
  cutoff.setDate(today.getDate() - 364) // inclusive 365-day window

  const recent = days
    .filter((d) => {
      const t = new Date(d.date + 'T00:00:00').getTime()
      return t >= cutoff.getTime() && t <= today.getTime()
    })
    .sort((a, b) => a.date.localeCompare(b.date))

  let running = 0
  const cum = recent.map((d) => (running += d.count))
  const total = running
  if (recent.length < 2 || total <= 0) return null

  const W = 100
  const H = 32
  const n = cum.length
  const pt = (i: number) => {
    const x = (i / (n - 1)) * W
    const y = H - (cum[i] / total) * H
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }
  const line = cum.map((_, i) => pt(i)).join(' ')
  const area = `0,${H} ${line} ${W},${H}`
  const end = pt(n - 1).split(',')

  return (
    <div className="agent__stat" title={`${total.toLocaleString()} cumulative contributions · 1y`}>
      <svg className="agent__stat-spark" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="sparkFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="rgba(34,211,238,0.35)" />
            <stop offset="100%" stop-color="rgba(34,211,238,0)" />
          </linearGradient>
        </defs>
        <polygon points={area} fill="url(#sparkFill)" />
        <polyline className="spark__line" points={line} />
        <circle className="spark__dot" cx={end[0]} cy={end[1]} r="1.4" />
      </svg>
      <span className="agent__stat-label hud-label">Cumulative · 1y</span>
    </div>
  )
}

// A framed group of the live-stat plots one dev/knowledge agent is publishing
// while it works — the same mini-tiles that show on its card, mirrored here so
// every running agent's plots are visible in one place. The frame's header
// names the project (repo) and the agent so a plot is traceable to its source.
function AgentStatsFrame({ session }: { session: AgentSession }) {
  const stats = session.stats ?? []
  if (!stats.length) return null
  const name = session.title || session.micro || session.task
  return (
    <div className="stat-frame">
      <div className="stat-frame__head">
        <span className="stat-frame__repo hud-label">{session.repo}</span>
        <span className="stat-frame__name" title={name}>
          {name}
        </span>
      </div>
      <div className="agent__stats">
        {stats.map((st, i) => (
          <AgentStat key={st.label} stat={st} gid={`sc-${session.id}-${i}`} />
        ))}
      </div>
    </div>
  )
}

// Aggregate agent time-tracking stats (GET /api/agent-stats) — box-local only,
// served straight from the timings log, so it's its own light 60s poll rather
// than part of the /api/dashboard bundle. Skips fetching while the tab is hidden.
// `kick` forces an immediate refetch — called when a run finishes so the server
// total absorbs it in lockstep with the live in-progress contribution dropping.
function useAgentStats(): { stats: AgentStats | null; kick: () => void } {
  const [stats, setStats] = useState<AgentStats | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let alive = true
    const load = async () => {
      const s = await fetchAgentStats()
      if (alive && s) setStats(s)
    }
    load()
    const id = setInterval(() => {
      if (!document.hidden) load()
    }, 60000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [nonce])
  return { stats, kick: () => setNonce((n) => n + 1) }
}

// Working time accruing right now: sum the elapsed of every session the box
// still considers mid-run. Keyed on the SERVER's `phase` (not the public
// status), which stays 'run' until the run is committed to the log — so this
// contribution drops exactly when the server total picks the run up, no dip.
function liveRunMs(sessions: AgentSession[], now: number): number {
  let ms = 0
  for (const s of sessions) {
    if (s.phase === 'run' && s.runStartedAt) ms += Math.max(0, now - Date.parse(s.runStartedAt))
  }
  return ms
}

// Per-day working time as a bar chart over the active range (first day with
// work → today; the server trims the empty lead-in). Each bar is labelled with
// its duration; today is the rightmost bar (highlighted) and grows live.
function DailyWorkChart({ daily }: { daily: AgentStats['daily'] }) {
  const max = Math.max(1, ...daily.map((d) => d.runMs))
  return (
    <div className="agent-work__chart">
      <div className="agent-work__chart-title hud-label">Working time · /day</div>
      <div className="agent-work__bars">
        {daily.map((d, i) => {
          const pct = (d.runMs / max) * 100
          const today = i === daily.length - 1
          return (
            <div className="agent-work__col" key={d.date} title={`${d.date}: ${fmtDur(d.runMs)}`}>
              {d.runMs > 0 ? (
                <span className="agent-work__col-val tnum" style={{ bottom: `calc(${pct.toFixed(1)}% + 3px)` }}>
                  {fmtDur(d.runMs)}
                </span>
              ) : null}
              <span
                className={`agent-work__col-bar${today ? ' agent-work__col-bar--today' : ''}`}
                style={{ height: `${pct.toFixed(1)}%` }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Estimate accuracy over time: actual/estimate per run, plotted on a log scale
// centered on the 1× midline (a run that hit its estimate sits on the line;
// above = it ran longer, below = shorter). Dots are coloured by side.
function AccuracyChart({ points }: { points: AgentStats['accuracy'] }) {
  const W = 300
  const H = 56
  const PAD = 5
  const ln = (r: number) => Math.log(Math.max(r, 1e-3))
  // Symmetric range around 1×, at least ±1.5× so a near-perfect series still
  // shows wiggle rather than sitting flat on the line.
  const span = Math.max(Math.log(1.5), ...points.map((p) => Math.abs(ln(p.ratio))))
  const x = (i: number) => (points.length <= 1 ? W / 2 : (i / (points.length - 1)) * W)
  const y = (r: number) => {
    const t = Math.max(-1, Math.min(1, ln(r) / span))
    return H / 2 - t * (H / 2 - PAD)
  }
  const line = points.map((p, i) => `${x(i).toFixed(2)},${y(p.ratio).toFixed(2)}`).join(' ')
  return (
    <div className="agent-work__chart">
      <div className="agent-work__chart-title hud-label">Actual / estimate · /run</div>
      <div className="agent-work__acc-row">
        {/* Vertical axis: position maps to the dots — longer (ran over) is up,
            shorter is down, the 1× midline sits dead centre on the dashed line. */}
        <div className="agent-work__acc-yaxis hud-label">
          <span>longer</span>
          <span className="agent-work__acc-axis-mid">1×</span>
          <span>shorter</span>
        </div>
        <svg className="agent-work__acc" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
          <line className="agent-work__acc-mid" x1="0" y1={(H / 2).toFixed(2)} x2={W} y2={(H / 2).toFixed(2)} />
          {points.length >= 2 ? <polyline className="agent-work__acc-line" points={line} /> : null}
          {points.map((p, i) => (
            <circle
              key={`${p.at}-${i}`}
              className={`agent-work__acc-dot agent-work__acc-dot--${p.ratio > 1 ? 'over' : 'under'}`}
              cx={x(i).toFixed(2)}
              cy={y(p.ratio).toFixed(2)}
              r="1.8"
            >
              <title>{`${p.at.slice(0, 10)}: ${p.ratio.toFixed(2)}× ${p.ratio > 1 ? '(ran longer)' : '(ran shorter)'}`}</title>
            </circle>
          ))}
        </svg>
      </div>
    </div>
  )
}

// "How I work" roll-up: per-day working-time graph + estimate-accuracy-over-time
// graph. (The per kind·model·effort breakdown is still tracked server-side — see
// /api/agent-stats `buckets` — just no longer surfaced here.) `liveMs` is
// in-progress working time, added to today's bar (and the total) so both tick up
// live while an agent runs. Hidden until there's any history.
function AgentWork({ stats, liveMs }: { stats: AgentStats; liveMs: number }) {
  if (stats.totalRunMs <= 0 && liveMs <= 0) return null
  const last = stats.daily.length - 1
  const daily =
    liveMs > 0 && last >= 0
      ? stats.daily.map((d, i) => (i === last ? { ...d, runMs: d.runMs + liveMs } : d))
      : stats.daily
  return (
    <div className="stat-frame agent-work">
      <div className="stat-frame__head">
        <span className="stat-frame__repo hud-label">Agent work</span>
        <span className="stat-frame__name" title="agent working time — this month · all-time">
          {fmtDur(stats.monthRunMs + liveMs)} this month · {fmtDur(stats.totalRunMs + liveMs)} total
        </span>
      </div>
      <div className="agent-work__charts">
        <DailyWorkChart daily={daily} />
        {stats.accuracy.length > 0 ? <AccuracyChart points={stats.accuracy} /> : null}
      </div>
    </div>
  )
}

export function Scorecard({ className = '' }: { className?: string }) {
  const { data } = useDashboardSlice('scorecard')
  const { data: heatmap } = useDashboardSlice('heatmap')
  const { view } = useAgents()
  const { stats: agentStats, kick: kickStats } = useAgentStats()
  const stats = data?.stats ?? []
  const days = heatmap?.days ?? []
  const sessions = view?.sessions ?? []

  // Live in-progress working time, ticking every second while any agent is
  // mid-run (added to today's bar + the total in AgentWork).
  const anyRunning = sessions.some((s) => s.phase === 'run' && s.runStartedAt)
  const now = useNow(anyRunning)
  const liveMs = anyRunning ? liveRunMs(sessions, now) : 0
  // Refetch the server total the instant the set of running agents changes — so
  // a just-finished run lands in the total exactly as its live contribution
  // drops (the server logs the run when its phase leaves 'run'). No dip.
  const runningKey = sessions
    .filter((s) => s.phase === 'run' && s.runStartedAt)
    .map((s) => s.id)
    .sort()
    .join(',')
  useEffect(() => {
    kickStats()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningKey])

  const hasAgentWork = !!agentStats && (agentStats.totalRunMs > 0 || liveMs > 0)
  // Every agent currently publishing live plots (box-local agents only carry
  // `stats`). Each gets its own framed group below the static metrics.
  const liveAgents = sessions.filter((s) => s.stats && s.stats.length)

  // Cluster the static stats into ordered groups by their optional `group` field
  // (first-seen order; ungrouped stats fall into a leading headerless frame).
  // Each group renders as a bordered, headed frame — the same look as the
  // live-agent plot frames below — whose compact tiles fill the row left-to-right
  // before wrapping.
  const groups: { title?: string; stats: Stat[] }[] = []
  const groupIdx = new Map<string, number>()
  for (const s of stats) {
    const key = s.group ?? ''
    let i = groupIdx.get(key)
    if (i == null) {
      i = groups.length
      groupIdx.set(key, i)
      groups.push({ title: s.group || undefined, stats: [] })
    }
    groups[i].stats.push(s)
  }
  // The cumulative sparkline rides with the GitHub stats (refresh-github.mjs
  // writes them), slotted right after the last one in whichever group holds them.
  const ghGroup = groups.find((g) => g.stats.some((s) => isGithubStat(s.label)))

  return (
    <Card title="Scorecard" className={className}>
      {stats.length === 0 && liveAgents.length === 0 && !hasAgentWork ? (
        <EmptyState>No metrics yet.</EmptyState>
      ) : (
        <>
          {(groups.length > 0 || liveAgents.length > 0 || hasAgentWork) && (
            <div className="stat-frames">
              {groups.map((g, gi) => {
                const lastGh =
                  g === ghGroup ? g.stats.map((s) => isGithubStat(s.label)).lastIndexOf(true) : -1
                return (
                  <div className="stat-frame" key={`grp${gi}`}>
                    {g.title && (
                      <div className="stat-frame__head">
                        <span className="stat-frame__repo hud-label">{g.title}</span>
                      </div>
                    )}
                    <div className="agent__stats">
                      {g.stats.flatMap((s, i) => {
                        const tiles = [<StatChip key={`s${i}`} stat={s} />]
                        if (i === lastGh) tiles.push(<CumulativeTile key="cum" days={days} />)
                        return tiles
                      })}
                    </div>
                  </div>
                )
              })}
              {liveAgents.map((s) => (
                <AgentStatsFrame key={s.id} session={s} />
              ))}
              {hasAgentWork && <AgentWork stats={agentStats!} liveMs={liveMs} />}
            </div>
          )}
        </>
      )}
    </Card>
  )
}
