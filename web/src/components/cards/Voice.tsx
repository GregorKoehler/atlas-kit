import { useEffect, useRef, useState } from 'preact/hooks'
import { Card, EmptyState } from '../Card'
import { useAddons } from '../../lib/addons'
import { useAgents } from '../../lib/useAgents'
import {
  deriveEvents,
  requestRecap,
  speak,
  speechSupported,
  stopSpeaking,
  synthesize,
  voiceStatus,
  type AgentSnapshot,
  type FleetEvent,
  type VoiceStatus,
} from '../../lib/voice'

/* Voice — spoken recaps of what the fleet just did, from the optional `voice`
 * addon.
 *
 * 🔴 GATED AT RUNTIME, NOT AT BUILD TIME. One build of web/dist serves every
 * install, so this card renders because GET /api/addons says the addon is
 * enabled ON THIS BOX, and returns null otherwise (docs/ADDONS.md).
 *
 * TWO PRICES, SHOWN AS TWO BUTTONS. "Say" reads the event line the browser
 * already has: no model, no server call, no cost. "Recap" spends one bounded
 * `claude -p` call to summarize that agent's terminal tail. Nothing here ever
 * spends silently — auto-speak reads the free line, never the paid recap, so a
 * dashboard left open on a wall cannot run up a bill on its own.
 *
 * Events come from the SHARED fleet poll (useAgents) rather than a stream of
 * their own: the dashboard already holds every session's status, ship state and
 * terminal tail, so this card costs one diff per poll and no extra request. A
 * session first seen is never an event — opening the dashboard must not narrate
 * the fleet's history. */

const MAX_EVENTS = 12
const AUTO_KEY = 'atlas.voice.autospeak'

const readPref = (): boolean => {
  try {
    return localStorage.getItem(AUTO_KEY) === '1'
  } catch {
    return false
  }
}
const writePref = (on: boolean) => {
  try {
    localStorage.setItem(AUTO_KEY, on ? '1' : '0')
  } catch {
    /* private mode — the toggle just doesn't persist */
  }
}

const KIND_LABEL: Record<FleetEvent['kind'], string> = {
  shipped: 'shipped',
  ready: 'ready',
  error: 'error',
  done: 'done',
  'turn-end': 'turn',
}

/* The gate is its own component so the disabled path subscribes to NOTHING —
 * not even the shared fleet poll, which the body below joins. A card that is not
 * rendered here must not cost a request anywhere (docs/ADDONS.md). */
export function Voice({ className = '' }: { className?: string }) {
  const addons = useAddons()
  if (!(addons.ready && addons.enabled('voice'))) return null
  return <VoiceCard className={className} status={voiceStatus(addons.get('voice'))} />
}

function VoiceCard({ className, status }: { className: string; status: VoiceStatus | null }) {
  const { view } = useAgents()

  const [events, setEvents] = useState<FleetEvent[]>([])
  const [recaps, setRecaps] = useState<Record<string, string>>({})
  const [busyKey, setBusyKey] = useState('')
  const [speaking, setSpeaking] = useState(false)
  const [note, setNote] = useState('')
  const [auto, setAuto] = useState(readPref)

  const snapRef = useRef<Record<string, AgentSnapshot>>({})
  const autoRef = useRef(auto)
  autoRef.current = auto
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const onBoxTts = !!status?.tts.available

  /** Say something out loud: the on-box engine when the box has one, the
   *  browser's own voice otherwise. Either way a new utterance replaces the one
   *  in flight — a queue of stale recaps is worse than the newest one. */
  const say = async (text: string) => {
    stopSpeaking()
    audioRef.current?.pause()
    setSpeaking(true)
    if (onBoxTts) {
      const blob = await synthesize(text)
      if (blob) {
        const url = URL.createObjectURL(blob)
        const el = new Audio(url)
        audioRef.current = el
        el.onended = el.onerror = () => {
          URL.revokeObjectURL(url)
          setSpeaking(false)
        }
        void el.play().catch(() => setSpeaking(false))
        return
      }
      // The engine or the route is unreachable — fall through to the browser.
    }
    if (!speak(text, { onEnd: () => setSpeaking(false) })) {
      setSpeaking(false)
      setNote('this browser has no speech synthesis — the text is above')
    }
  }

  const stop = () => {
    stopSpeaking()
    audioRef.current?.pause()
    setSpeaking(false)
  }

  // One diff per fleet poll. `view` is replaced wholesale by the shared poll, so
  // it is the whole dependency.
  useEffect(() => {
    if (!view) return
    const at = new Date().toISOString()
    const { events: fresh, snapshot } = deriveEvents(snapRef.current, view.sessions, at)
    snapRef.current = snapshot
    if (!fresh.length) return
    setEvents((prev) => [...fresh.slice().reverse(), ...prev].slice(0, MAX_EVENTS))
    // Several events in one tick become ONE utterance, so the fleet never talks
    // over itself. Only the free line is auto-spoken; recaps stay click-driven.
    if (autoRef.current) void say(fresh.map((e) => e.line).join(' '))
  }, [view])

  useEffect(() => () => stop(), [])

  const recapNow = async (ev: FleetEvent) => {
    setBusyKey(ev.key)
    setNote('')
    const r = await requestRecap({ agentId: ev.id, agent: ev.agent, event: ev.kind, tail: ev.tail })
    setBusyKey('')
    if (r.ok && r.text) {
      setRecaps((prev) => ({ ...prev, [ev.key]: r.text as string }))
      void say(r.text)
      return
    }
    setNote(
      r.httpStatus === 401
        ? 'the dashboard cannot reach POST /api/voice/* — add the handler to your Caddyfile (see addons/voice/README.md)'
        : r.skipped
          ? `recap skipped: ${r.skipped} — reading the event line instead`
          : r.error || 'the recap did not run — reading the event line instead',
    )
    void say(ev.line)
  }

  const warnings = [
    status?.tts.configured && !status.tts.available ? status.tts.reason : '',
    status?.stt.configured && !status.stt.available ? status.stt.reason : '',
    !speechSupported() && !onBoxTts ? 'this browser has no speechSynthesis and this box has no ATLAS_VOICE_TTS_CMD — nothing can speak here' : '',
    note,
  ].filter(Boolean) as string[]

  return (
    <Card
      title="Voice"
      className={className}
      actions={
        <>
          <button
            type="button"
            className={`btn${auto ? ' btn--approve' : ''}`}
            onClick={() => {
              const next = !auto
              setAuto(next)
              writePref(next)
            }}
            title="Read each new fleet event aloud as it happens (the event line — no model call)"
          >
            {auto ? 'Auto-speak on' : 'Auto-speak off'}
          </button>
          {speaking ? (
            <button type="button" className="btn btn--dismiss" onClick={stop}>
              Stop
            </button>
          ) : null}
        </>
      }
    >
      <div className="dpass">
        <p className="dpass__sub">
          Turn-ends, READY-TO-SHIP and merges, spoken by <code>addons/voice</code>. <strong>Say</strong> reads the line — free.{' '}
          <strong>Recap</strong> spends one <code>claude -p</code> call ({status?.recap.model}) on that agent's terminal tail:{' '}
          {status?.recap.spent}/{status?.recap.budget} used today, {status?.recap.guards}.
        </p>

        {warnings.length ? (
          <ul className="dpass__list">
            {warnings.slice(0, 3).map((w) => (
              <li key={w} className="search__warn">
                <span aria-hidden="true">⚠</span>
                <span>{w}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {events.length ? (
          <ul className="dpass__list">
            {events.map((ev) => (
              <li key={ev.key} className="dpass-item">
                <div className="dpass-item__head">
                  <span className="dpass-item__chip">{KIND_LABEL[ev.kind]}</span>
                  <span className="dpass-item__task">{ev.line}</span>
                  <span className="dpass-item__conf tnum">{ev.at.slice(11, 16)}</span>
                </div>
                {recaps[ev.key] ? <div className="dpass-item__detail">{recaps[ev.key]}</div> : null}
                <div className="dpass-item__btns">
                  <button type="button" className="btn" onClick={() => void say(recaps[ev.key] || ev.line)}>
                    Say
                  </button>
                  <button type="button" className="btn" onClick={() => void recapNow(ev)} disabled={busyKey === ev.key || !ev.tail}>
                    {busyKey === ev.key ? '…' : 'Recap'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>
            Nothing from the fleet yet — an agent ending a turn, flagging itself ready to ship, or merging shows up here while this
            page is open.
          </EmptyState>
        )}
      </div>
    </Card>
  )
}
