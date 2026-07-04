import { useEffect, useRef, useState } from 'preact/hooks'

/**
 * A compact ⏱ button that opens a small popover to pick a future time, then
 * schedules an action for it. Used beside Spawn (start a new agent later) and
 * beside Send/Queue (deliver a prompt to an agent later). The caller owns what
 * gets scheduled — `onSchedule(at)` receives the chosen time as an ISO string
 * and posts the right payload; this component only handles the time picker.
 */

// A Date → <input type="datetime-local"> value (YYYY-MM-DDTHH:MM) in LOCAL time
// (the input has no timezone; new Date(value) reads it back as local).
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// Quick presets — each returns a Date relative to now.
function presets(): { label: string; at: () => Date }[] {
  return [
    { label: '+1h', at: () => new Date(Date.now() + 60 * 60 * 1000) },
    { label: '+3h', at: () => new Date(Date.now() + 3 * 60 * 60 * 1000) },
    {
      label: 'Tonight 8pm',
      at: () => {
        const d = new Date()
        d.setHours(20, 0, 0, 0)
        if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
        return d
      },
    },
    {
      label: 'Tomorrow 9am',
      at: () => {
        const d = new Date()
        d.setDate(d.getDate() + 1)
        d.setHours(9, 0, 0, 0)
        return d
      },
    },
  ]
}

export function ScheduleButton({
  onSchedule,
  disabled = false,
  title = 'schedule for later',
}: {
  /** Schedule the action for `at` (ISO string). Resolve { ok } / { ok:false, error }. */
  onSchedule: (at: string) => Promise<{ ok: boolean; error?: string }>
  disabled?: boolean
  title?: string
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(() => toLocalInput(new Date(Date.now() + 60 * 60 * 1000)))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const wrapRef = useRef<HTMLSpanElement>(null)

  // Close on outside click / Escape while the popover is open.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const confirm = async () => {
    if (busy) return
    const when = value ? new Date(value) : null
    if (!when || Number.isNaN(when.getTime())) {
      setErr('pick a time')
      return
    }
    if (when.getTime() <= Date.now()) {
      setErr('pick a future time')
      return
    }
    setBusy(true)
    setErr('')
    const r = await onSchedule(when.toISOString())
    setBusy(false)
    if (r.ok) {
      setOpen(false)
    } else {
      setErr(r.error || 'schedule failed')
    }
  }

  return (
    <span className="sched" ref={wrapRef}>
      <button
        type="button"
        className={`btn btn--sched${open ? ' btn--sched-open' : ''}`}
        onClick={() => {
          setErr('')
          setOpen((o) => !o)
        }}
        disabled={disabled}
        title={title}
        aria-label={title}
        aria-expanded={open}
      >
        ⏱
      </button>
      {open ? (
        <div
          className="sched__pop"
          role="dialog"
          aria-label="schedule for later"
          onKeyDown={(e) => {
            // The popover lives inside the spawn/prompt <form>; swallow Enter so it
            // schedules here instead of submitting the parent form (spawn/send).
            if (e.key === 'Enter') {
              e.preventDefault()
              e.stopPropagation()
              confirm()
            }
          }}
        >
          <div className="sched__presets">
            {presets().map((p) => (
              <button
                key={p.label}
                type="button"
                className="sched__preset"
                onClick={() => {
                  setValue(toLocalInput(p.at()))
                  setErr('')
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <input
            className="capture__input capture__input--sm sched__input"
            type="datetime-local"
            value={value}
            min={toLocalInput(new Date())}
            onInput={(e) => {
              setValue((e.currentTarget as HTMLInputElement).value)
              setErr('')
            }}
          />
          {err ? <div className="sched__err">✗ {err}</div> : null}
          <div className="sched__actions">
            <button type="button" className="btn btn--approve sched__go" onClick={confirm} disabled={busy}>
              {busy ? 'Scheduling…' : 'Schedule'}
            </button>
          </div>
        </div>
      ) : null}
    </span>
  )
}
