import { type ComponentChildren } from 'preact'
import { useEffect, useRef } from 'preact/hooks'
import { useAddons } from '../lib/addons'
import { useDictation, scrollFieldToEnd } from '../lib/useDictation'
import { voiceStatus } from '../lib/voice'
import { MicIcon, StopIcon } from './icons'

interface MicFieldProps {
  value: string
  onChange: (next: string) => void
  multiline?: boolean
  children: ComponentChildren
}

/* Wrap a single text <input>/<textarea> and float a live-dictation mic in its
 * corner — but ONLY where the optional `voice` addon is enabled.
 *
 * 🔴 ADDON OFF = TRANSPARENT PASSTHROUGH. With the addon disabled (the default,
 * and every kit that never enables it) this renders its child and nothing else:
 * no wrapper element, no button, no listener, no request. That is the same
 * component this file shipped as while the kit had no voice at all, which is why
 * the props never changed — and it is the zero-addons invariant of
 * docs/ADDONS.md, held in the UI rather than only in the API.
 *
 * The gate is RUNTIME, not build-time: one build of web/dist serves every
 * install, and `GET /api/addons` says what this box runs. `ready` guards the
 * first paint — until the answer lands the field is a plain field, never a mic
 * that flickers away. */
export function MicField(props: MicFieldProps) {
  const addons = useAddons()
  if (!(addons.ready && addons.enabled('voice'))) return <>{props.children}</>
  return <LiveMicField {...props} onBox={!!voiceStatus(addons.get('voice'))?.stt.available} />
}

function LiveMicField({ value, onChange, multiline, children, onBox }: MicFieldProps & { onBox: boolean }) {
  const { engine, unavailable, recording, busy, error, toggle } = useDictation(value, onChange, onBox)

  // Keep the tail of the text in view as dictation appends to it — most relevant
  // on a narrow phone field with live partials. The field is the only
  // <input>/<textarea> inside this wrapper.
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    scrollFieldToEnd(wrapRef.current?.querySelector('input, textarea'), multiline)
  }, [value, multiline])

  const title =
    error ||
    unavailable ||
    (recording
      ? 'stop & finalize'
      : engine === 'on-box'
        ? 'dictate (transcribed on the box when you stop)'
        : 'dictate (live transcription)')

  return (
    <div ref={wrapRef} className={`micfield${multiline ? ' micfield--multiline' : ''}`}>
      {children}
      <button
        type="button"
        className={`mic-btn${recording ? ' mic-btn--rec' : ''}`}
        onClick={toggle}
        disabled={busy || engine === 'none'}
        title={title}
        aria-label="dictate"
      >
        {busy ? <span className="agent__spin" aria-label="loading" /> : recording ? <StopIcon /> : <MicIcon />}
      </button>
    </div>
  )
}
