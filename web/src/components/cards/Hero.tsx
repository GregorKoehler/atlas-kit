import { useEffect, useState } from 'preact/hooks'
import { motion } from 'framer-motion'
import { cardRise, cardReveal } from '../Card'
import { AgentsOverview } from './AgentsOverview'
import { useData } from '../../lib/useData'
import { fetchUsage, fetchHost, type UsageWindow, type HostGauge } from '../../lib/api'

// Your name in the hero greeting. Set VITE_OPERATOR_NAME in .env, or edit here.
const OPERATOR = import.meta.env.VITE_OPERATOR_NAME || 'Operator'

function useClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

const two = (n: number) => String(n).padStart(2, '0')

export function Hero() {
  const now = useClock()
  const time = `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`
  const date = now.toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  return (
    <motion.section
      variants={cardRise}
      transition={cardReveal}
      className="glass hero col-span-12"
    >
      {/* Themed placeholder backdrop — an operator-supplied image goes here later. */}
      <div className="hero__bg" aria-hidden="true" />

      <div className="hero__inner">
        <div className="hero__id">
          <h1 className="hero__name glow-text">{OPERATOR}</h1>
          <UsageMeters />
          <HostMeters />
        </div>

        <AgentsOverview />

        <div className="hero__clock">
          <div className="hero__time tnum glow-text">{time}</div>
          <div className="hero__date hud-label text-hud-dim">{date}</div>
        </div>
      </div>
    </motion.section>
  )
}

// Claude budget readout under the status line: how much of the 5-hour and
// weekly limits is used, and when each resets. Hidden entirely when the usage
// endpoint can't be read, so the hero never shows a broken meter.
function level(u: number): 'green' | 'amber' | 'red' {
  return u >= 90 ? 'red' : u >= 70 ? 'amber' : 'green'
}

// "14:29" if the reset is within a day, else "Thu 18:00" — enough to know when
// the budget comes back without a full date.
function fmtReset(iso: string): string {
  const d = new Date(iso)
  const hhmm = `${two(d.getHours())}:${two(d.getMinutes())}`
  const soon = d.getTime() - Date.now() < 24 * 60 * 60 * 1000
  return soon ? hhmm : `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${hhmm}`
}

function UsageMeters() {
  const { data } = useData(fetchUsage, 60000)
  if (!data) return null
  const rows: Array<{ key: string; w: UsageWindow }> = []
  if (data.fiveHour) rows.push({ key: '5H', w: data.fiveHour })
  if (data.sevenDay) rows.push({ key: '7D', w: data.sevenDay })
  if (!rows.length) return null

  return (
    <div className="hero__usage">
      {rows.map(({ key, w }) => (
        <div className="usage-meter" key={key}>
          <span className="usage-meter__label">{key}</span>
          <span className="usage-meter__bar">
            <span
              className={`usage-meter__fill usage-meter__fill--${level(w.utilization)}`}
              style={{ width: `${Math.min(100, Math.max(0, w.utilization))}%` }}
            />
          </span>
          <span className="usage-meter__pct tnum">{Math.round(w.utilization)}%</span>
          <span className="usage-meter__reset tnum">↺ {fmtReset(w.resetsAt)}</span>
        </div>
      ))}
    </div>
  )
}

// Live box memory under the Claude budget — RAM always, swap only once the
// box has started spilling into it (the early-warning that memory pressure is
// building). Same green/amber/red thresholds as the Claude meters: red at 90%
// is the danger zone the 2026-06-25 freeze hit. Reuses the usage-meter styles.
const gb = (m: number) => (m / 1024).toFixed(1)

function HostMeters() {
  const { data } = useData(fetchHost, 10000)
  if (!data?.mem) return null
  const rows: Array<{ key: string; g: HostGauge }> = [{ key: 'RAM', g: data.mem }]
  if (data.swap && data.swap.usedMb > 0) rows.push({ key: 'SWAP', g: data.swap })

  return (
    <div className="hero__usage hero__host">
      {rows.map(({ key, g }) => (
        <div className="usage-meter" key={key}>
          <span className="usage-meter__label">{key}</span>
          <span className="usage-meter__bar">
            <span
              className={`usage-meter__fill usage-meter__fill--${level(g.pct)}`}
              style={{ width: `${Math.min(100, Math.max(0, g.pct))}%` }}
            />
          </span>
          <span className="usage-meter__pct tnum">{Math.round(g.pct)}%</span>
          <span className="usage-meter__reset tnum">
            {gb(g.usedMb)}/{gb(g.totalMb)}G
          </span>
        </div>
      ))}
    </div>
  )
}
