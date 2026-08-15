/* ------------------------------------------------------------------ *
 * The OPTIONAL on-box engines — speech out (TTS) and speech in (STT).
 *
 * 🔴 THE DEFAULT IS THAT THIS FILE DOES NOTHING. With no engine configured the
 * dashboard speaks with the BROWSER's own speechSynthesis and dictates with its
 * SpeechRecognition: no download, no server round-trip, no key, and this module
 * only ever answers `available: false` with the reason why. An on-box engine is
 * for the cases the browser cannot cover — a browser with no Web Speech API, or
 * an operator who wants the audio never to leave the box (see the README's
 * privacy section: in Chrome, browser dictation is a Google round-trip).
 *
 * AN ENGINE IS A COMMAND, NOT A VENDOR. The kit ships no model and no API key;
 * you point two env vars at whatever you already run:
 *
 *   ATLAS_VOICE_TTS_CMD   TEXT on stdin      → AUDIO on stdout
 *   ATLAS_VOICE_STT_CMD   AUDIO on stdin, or at `{file}` if the command needs a
 *                         path                → TRANSCRIPT on stdout
 *
 * The command is split on whitespace and executed WITHOUT a shell — no quoting,
 * no globbing, no `|`, no `&&`. That is deliberate: these strings come from the
 * environment of a process that also holds the dashboard's bearer token, and a
 * shell here would turn a config typo into command execution. Anything that
 * needs a pipeline goes in a wrapper script, and you point the var at that.
 *
 * DEGRADE, NEVER CRASH: a missing binary, a hung engine, a non-zero exit and an
 * oversized answer are all `{ ok: false, error }` — the text stays, the speech is
 * skipped, and the status says why (docs/ADDONS.md).
 * ------------------------------------------------------------------ */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ttsCmd, ttsMime, sttCmd, timeouts, limits } from './config.mjs'

/** Split a configured command into argv. Whitespace only — see the header. */
export const splitCmd = (cmd) => String(cmd || '').trim().split(/\s+/).filter(Boolean)

/** Resolve `bin` the way a shell would, without one. Absolute/relative paths are
 *  checked as given; a bare name is looked up on PATH. Returns '' when nothing
 *  executable is there — which is the state an operator most needs told about. */
export function which(bin, pathEnv = process.env.PATH || '') {
  if (!bin) return ''
  const ok = (p) => {
    try {
      return fs.statSync(p).isFile() && (fs.accessSync(p, fs.constants.X_OK), true)
    } catch {
      return false
    }
  }
  if (bin.includes('/')) return ok(bin) ? bin : ''
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const p = path.join(dir, bin)
    if (ok(p)) return p
  }
  return ''
}

/* Shared subprocess runner: feed `input`, collect stdout, and stop on the FIRST
 * of {exit, timeout, output over `maxBytes`}. The size cap matters because the
 * output of a TTS engine is audio and a misconfigured command (`cat /dev/urandom`
 * being the honest worst case) would otherwise fill the API's heap. */
function run(argv, { input, timeoutMs, maxBytes, label }) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      return reject(new Error(`failed to spawn ${label}: ${e.message}`))
    }
    const out = []
    let size = 0
    let stderr = ''
    let settled = false
    const fail = (msg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      reject(new Error(msg))
    }
    const timer = setTimeout(() => fail(`${label} timed out after ${timeoutMs}ms`), timeoutMs)
    child.stdout.on('data', (d) => {
      size += d.length
      if (size > maxBytes) return fail(`${label} produced more than ${maxBytes} bytes`)
      out.push(d)
    })
    child.stderr.on('data', (d) => (stderr += d))
    child.on('error', (e) => fail(`failed to spawn ${label}: ${e.message}`))
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`${label} exited ${code}: ${stderr.replace(/\s+/g, ' ').trim().slice(0, 300)}`))
      resolve(Buffer.concat(out))
    })
    // An engine that never reads stdin (a `{file}` STT command) closes the pipe
    // first; that EPIPE is its normal shape, not a failure worth reporting.
    child.stdin.on('error', () => {})
    if (input) child.stdin.write(input)
    child.stdin.end()
  })
}

/** Is an on-box TTS engine usable right now, and if not, why not? */
export function ttsStatus() {
  const cmd = ttsCmd()
  if (!cmd) return { configured: false, available: false, reason: 'no ATLAS_VOICE_TTS_CMD — recaps are spoken by the browser (the zero-install default)' }
  const argv = splitCmd(cmd)
  const bin = which(argv[0])
  if (!bin) return { configured: true, available: false, cmd, reason: `ATLAS_VOICE_TTS_CMD names "${argv[0]}", which is not an executable on PATH — run addons/voice/install.sh --check` }
  return { configured: true, available: true, cmd, bin, mime: ttsMime() }
}

/** Is an on-box STT engine usable right now, and if not, why not? */
export function sttStatus() {
  const cmd = sttCmd()
  if (!cmd) return { configured: false, available: false, reason: "no ATLAS_VOICE_STT_CMD — dictation uses the browser's own Web Speech API where it has one" }
  const argv = splitCmd(cmd)
  const bin = which(argv[0])
  if (!bin) return { configured: true, available: false, cmd, reason: `ATLAS_VOICE_STT_CMD names "${argv[0]}", which is not an executable on PATH — run addons/voice/install.sh --check` }
  return { configured: true, available: true, cmd, bin, wantsFile: argv.includes('{file}') }
}

/** Synthesize `text` on the box. → { ok, audio: Buffer, mime } | { ok: false, error } */
export async function speak(text, { runImpl = run } = {}) {
  const st = ttsStatus()
  if (!st.available) return { ok: false, error: st.reason }
  const t = String(text || '').trim()
  if (!t) return { ok: false, error: 'nothing to speak' }
  try {
    const audio = await runImpl(splitCmd(st.cmd), {
      input: Buffer.from(t, 'utf-8'),
      timeoutMs: timeouts().tts,
      maxBytes: limits().audioBytes,
      label: 'tts command',
    })
    if (!audio.length) return { ok: false, error: 'the TTS command produced no audio' }
    return { ok: true, audio, mime: st.mime }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/** Extension for a temp clip, so a `{file}` engine can sniff the container. */
const extFor = (mime) => {
  const m = String(mime || '').toLowerCase()
  if (m.includes('wav')) return '.wav'
  if (m.includes('ogg')) return '.ogg'
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return '.m4a'
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3'
  return '.webm' // what MediaRecorder gives us in practice
}

/** Transcribe a clip on the box. → { ok, text } | { ok: false, error } */
export async function transcribe(audio, { mime = '', runImpl = run } = {}) {
  const st = sttStatus()
  if (!st.available) return { ok: false, error: st.reason }
  if (!audio?.length) return { ok: false, error: 'empty audio' }
  if (audio.length > limits().audioBytes) return { ok: false, error: `clip is larger than ${limits().audioBytes} bytes` }
  const argv = splitCmd(st.cmd)
  let tmp = ''
  try {
    if (st.wantsFile) {
      tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-voice-')), `clip${extFor(mime)}`)
      fs.writeFileSync(tmp, audio)
    }
    const out = await runImpl(
      argv.map((a) => (a === '{file}' ? tmp : a)),
      {
        input: st.wantsFile ? null : audio,
        timeoutMs: timeouts().stt,
        maxBytes: 1024 * 1024, // a transcript, not a recording
        label: 'stt command',
      },
    )
    const text = out.toString('utf-8').replace(/\s+/g, ' ').trim()
    if (!text) return { ok: false, error: 'the STT command produced no transcript' }
    return { ok: true, text }
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  } finally {
    if (tmp) fs.rmSync(path.dirname(tmp), { recursive: true, force: true })
  }
}
