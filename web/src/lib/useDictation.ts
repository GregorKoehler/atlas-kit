/* ------------------------------------------------------------------ *
 * Live dictation for one text field — the hook behind MicField, and the reason
 * MicField's props were kept identical while the kit shipped without voice.
 *
 * TWO ENGINES, PICKED AT RUNTIME (voice.ts → pickDictation):
 *   · browser  — the Web Speech API. Zero install, live interim words, and the
 *                default wherever it exists. ⚠️ In Chrome it is a GOOGLE
 *                round-trip: the audio leaves the machine. The addon README says
 *                so plainly, and an operator who minds that configures the box
 *                engine and uses a browser without Web Speech (Firefox).
 *   · on-box   — MediaRecorder here, one POST to /api/voice/transcribe on stop,
 *                whatever ATLAS_VOICE_STT_CMD runs there. No live partials: a
 *                CPU STT pass is seconds, and a per-second re-transcribe of a
 *                growing clip is how you turn a mic into a load generator.
 *
 * The transcript lands in the FIELD for review and NEVER auto-sends. `value` is
 * read when recording starts (the base dictation appends to); `onChange` is the
 * field's own setter, so the text is editable the moment it arrives.
 * ------------------------------------------------------------------ */
import { useEffect, useRef, useState } from 'preact/hooks'
import { joinDictation, pickDictation, transcribeClip } from './voice'

/* The Web Speech API is not in TypeScript's DOM lib (it is a draft spec that
 * ships prefixed in Chrome), so the two shapes we actually touch are declared
 * here rather than pulling in a types package for a hook. */
interface SpeechResultList {
  length: number
  [i: number]: { isFinal: boolean; 0: { transcript: string } }
}
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: { resultIndex: number; results: SpeechResultList }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

const speechRecognitionCtor = (): SpeechRecognitionCtor | null => {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor }
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}

const canRecord = () => typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

/** Keep the tail of a growing field in view — dictation appends to the end, so
 *  the newest words otherwise scroll out of sight on a narrow field. Skipped
 *  while the field is focused: a manual caret owns the scroll then. */
export function scrollFieldToEnd(el: Element | null | undefined, multiline?: boolean) {
  if (!el || document.activeElement === el) return
  if (multiline) el.scrollTop = el.scrollHeight
  else el.scrollLeft = el.scrollWidth
}

export interface Dictation {
  engine: 'browser' | 'on-box' | 'none'
  /** Why there is no engine (empty otherwise) — shown as the button's tooltip. */
  unavailable: string
  recording: boolean
  /** The final transcription is in flight (on-box engine only). */
  busy: boolean
  error: string
  toggle: () => void
}

export function useDictation(value: string, onChange: (next: string) => void, onBoxAvailable: boolean): Dictation {
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  // The callbacks below outlive the render that made them, so the latest value
  // and setter are read through refs rather than captured.
  const valueRef = useRef(value)
  valueRef.current = value
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const baseRef = useRef('') // field text when this dictation started
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  const { engine, reason } = pickDictation(!!speechRecognitionCtor(), onBoxAvailable && canRecord())

  /* Never leave a mic hot: an unmount mid-dictation (a card closing, a tab
   * switch) must stop the recogniser and release the microphone track. */
  useEffect(
    () => () => {
      recognitionRef.current?.abort()
      recorderRef.current?.stream?.getTracks().forEach((t) => t.stop())
    },
    [],
  )

  const startBrowser = () => {
    const Ctor = speechRecognitionCtor()
    if (!Ctor) return
    const rec = new Ctor()
    rec.lang = navigator.language || 'en-US'
    rec.continuous = true
    rec.interimResults = true
    baseRef.current = valueRef.current
    let settled = '' // everything the engine has marked final this session
    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) settled += `${r[0].transcript} `
        else interim += r[0].transcript
      }
      onChangeRef.current(joinDictation(baseRef.current, `${settled}${interim}`))
    }
    rec.onerror = (e) => {
      // `no-speech`/`aborted` are what a quiet room and a normal stop look like.
      if (e.error !== 'no-speech' && e.error !== 'aborted') setError(e.error)
      setRecording(false)
    }
    rec.onend = () => {
      recognitionRef.current = null
      setRecording(false)
    }
    recognitionRef.current = rec
    setError('')
    setRecording(true)
    try {
      rec.start()
    } catch (e) {
      recognitionRef.current = null
      setRecording(false)
      setError(String(e))
    }
  }

  const startOnBox = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      baseRef.current = valueRef.current
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data.size) chunksRef.current.push(e.data)
      }
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        recorderRef.current = null
        setRecording(false)
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        chunksRef.current = []
        if (!blob.size) return
        setBusy(true)
        const r = await transcribeClip(blob)
        setBusy(false)
        if (r.ok && r.text) onChangeRef.current(joinDictation(baseRef.current, r.text))
        else setError(r.error || 'transcription failed')
      }
      recorderRef.current = rec
      setError('')
      setRecording(true)
      rec.start()
    } catch (e) {
      setRecording(false)
      setError(String((e as Error)?.message || e))
    }
  }

  const toggle = () => {
    if (busy) return
    if (recording) {
      recognitionRef.current?.stop()
      recorderRef.current?.stop()
      setRecording(false)
      return
    }
    if (engine === 'browser') startBrowser()
    else if (engine === 'on-box') void startOnBox()
  }

  return { engine, unavailable: reason, recording, busy, error, toggle }
}
