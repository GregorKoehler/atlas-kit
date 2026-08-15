/* ------------------------------------------------------------------ *
 * Every knob `addons/voice` reads, in one place.
 *
 * Read at CALL time, never frozen at import — `register()` imports this module
 * at boot, so a value captured in a top-level `const` would pin whatever `.env`
 * said at process start and quietly ignore the operator's next edit.
 *
 * 🔴 THE GUARDS ARE THE COST CONTROL. A spoken recap is one `claude -p` call,
 * and the thing that fires it is a FLEET EVENT — an agent flapping between busy
 * and idle can produce them faster than any human asks for them. So the spend is
 * bounded by `minIntervalMs` and `dailyBudget` and by nothing else; see
 * summarize.mjs for the three guards and why each one exists.
 *
 * ENGINES ARE COMMANDS, NOT VENDORS. The zero-install default is the BROWSER's
 * own speechSynthesis / SpeechRecognition — no key, no download, no server call.
 * An on-box engine is whatever command you point these at (piper, espeak-ng,
 * whisper.cpp, your own wrapper): text in on stdin, audio out on stdout for TTS;
 * audio in, transcript out for STT. The kit ships no engine and no API key.
 * ------------------------------------------------------------------ */
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ADDON_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

const str = (k, d = '') => {
  const v = process.env[k]
  return v === undefined || v === '' ? d : v
}
const num = (k, d) => {
  const n = Number(process.env[k])
  return Number.isFinite(n) && n > 0 ? n : d
}

/** Where operator-local state lives — the same dir the agent runtime uses. */
export const stateDir = () => str('AGENT_LOCAL_DIR', path.join(os.homedir(), '.atlas-kit'))

/** Where install.sh puts anything it downloads (a voice model, a venv). Out of
 *  tree, like every other addon's heavy half. */
export const engineDir = () => str('ATLAS_VOICE_DIR', path.join(stateDir(), 'voice'))

/** The model that writes a spoken recap. Empty API key → subscription auth. */
export const model = () => str('ATLAS_VOICE_MODEL', 'claude-haiku-4-5')

/* Thinking bound for the recap pass. A recap is two sentences about a terminal
 * tail; the default omits `--effort` entirely (upstream's voice recap runs the
 * flagless call on this model). `ATLAS_VOICE_EFFORT=low` adds it back — hence
 * `??`, so an explicitly empty value stays an opt-out. */
export const effort = () => process.env.ATLAS_VOICE_EFFORT ?? ''

export const timeouts = () => ({
  recap: num('ATLAS_VOICE_RECAP_TIMEOUT_MS', 30000), // a cold claude -p on a loaded box is slow
  tts: num('ATLAS_VOICE_TTS_TIMEOUT_MS', 20000),
  stt: num('ATLAS_VOICE_STT_TIMEOUT_MS', 60000), // whisper-class engines are minutes-per-minute on CPU
})

export const limits = () => ({
  tailLines: num('ATLAS_VOICE_MAX_LINES', 140), // of terminal tail into the prompt…
  tailChars: num('ATLAS_VOICE_MAX_CHARS', 6000), // …and the hard character bound on top
  spokenChars: num('ATLAS_VOICE_MAX_SPOKEN_CHARS', 700), // what comes back is READ ALOUD — cap it
  minIntervalMs: num('ATLAS_VOICE_MIN_INTERVAL_MS', 60000), // per agent
  dailyBudget: num('ATLAS_VOICE_DAILY_BUDGET', 100), // global, per calendar day
  audioBytes: num('ATLAS_VOICE_MAX_AUDIO_BYTES', 12 * 1024 * 1024), // an upload for on-box STT
})

/** The on-box TTS command: TEXT on stdin → AUDIO on stdout. Empty (the default)
 *  means the browser speaks, which is the whole zero-install story. */
export const ttsCmd = () => str('ATLAS_VOICE_TTS_CMD')
export const ttsMime = () => str('ATLAS_VOICE_TTS_MIME', 'audio/wav')

/** The on-box STT command: AUDIO on stdin (or at `{file}`, if the command names
 *  it) → TRANSCRIPT on stdout. Empty means the browser transcribes, or nothing
 *  does — MicField says which. */
export const sttCmd = () => str('ATLAS_VOICE_STT_CMD')
