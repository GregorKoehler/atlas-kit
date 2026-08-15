/* ------------------------------------------------------------------ *
 * The OPTIONAL on-box engines. Every case here is a DEGRADATION case, because
 * that is what an addon owes core: not installed, misconfigured, hung, failing
 * or answering with nonsense must each be `{ ok: false, error }` with a reason
 * an operator can act on — never a throw into a route (docs/ADDONS.md).
 *
 * Hermetic and engine-free: the "engines" are three-line shell stubs on a temp
 * PATH, which is exactly the contract the real ones have to meet (text in on
 * stdin → audio out on stdout; audio in → transcript out). CI has no piper and
 * no whisper, and this file would pass identically on a box that does.
 * Run: node --test addons/voice/test/engine.test.mjs
 * ------------------------------------------------------------------ */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { splitCmd, which, ttsStatus, sttStatus, speak, transcribe } = await import('../api/engine.mjs')

const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-kit-voice-bin-'))
const stub = (name, body) => {
  const p = path.join(bin, name)
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  return p
}
stub('say-stub', "printf 'AUDIO:'; cat")
stub('hear-stub', 'cat > /dev/null; printf "  spoken   words \\n"')
stub('hear-file-stub', 'printf "from-file:%s" "$(cat "$1")"')
stub('flood-stub', 'head -c 200000 /dev/zero')
stub('hang-stub', 'sleep 5')
stub('angry-stub', 'echo "no model loaded" >&2; exit 3')

// The stubs go FIRST on PATH, never instead of it — they are `#!/bin/sh` scripts
// that call `cat`/`head`/`sleep`, so /usr/bin still has to be reachable.
const ORIG_PATH = process.env.PATH || ''
const withStubs = `${bin}${path.delimiter}${ORIG_PATH}`
const env = (vars) => Object.assign(process.env, vars)
after(() => fs.rmSync(bin, { recursive: true, force: true }))

test('a command is argv, never a shell line', () => {
  assert.deepEqual(splitCmd('  piper  -m   voice.onnx -f -  '), ['piper', '-m', 'voice.onnx', '-f', '-'])
  assert.deepEqual(splitCmd(''), [])
})

test('which() resolves like a shell would, and says nothing rather than guessing', () => {
  assert.equal(which('say-stub', bin), path.join(bin, 'say-stub'))
  assert.equal(which('not-a-binary', bin), '')
  assert.equal(which(path.join(bin, 'say-stub')), path.join(bin, 'say-stub'))
  assert.equal(which(path.join(bin, 'nope')), '')
  assert.equal(which('', bin), '')
})

test('no engine configured is the DEFAULT, and says so as a reason', async () => {
  env({ ATLAS_VOICE_TTS_CMD: '', ATLAS_VOICE_STT_CMD: '' })
  const tts = ttsStatus()
  assert.deepEqual({ configured: tts.configured, available: tts.available }, { configured: false, available: false })
  assert.match(tts.reason, /browser/i)
  assert.match(sttStatus().reason, /browser/i)

  // …and calling them anyway is an error with that reason, not a crash.
  assert.equal((await speak('hello')).ok, false)
  assert.equal((await transcribe(Buffer.from('x'))).ok, false)
})

test('a configured engine that is not installed reports the binary, not a mystery', () => {
  env({ ATLAS_VOICE_TTS_CMD: 'piper-that-is-not-here -m voice.onnx', PATH: withStubs })
  const st = ttsStatus()
  assert.equal(st.configured, true)
  assert.equal(st.available, false)
  assert.match(st.reason, /piper-that-is-not-here/)
  assert.match(st.reason, /install\.sh --check/)
})

test('TTS: text in on stdin, audio out on stdout', async () => {
  env({ PATH: withStubs, ATLAS_VOICE_TTS_CMD: 'say-stub', ATLAS_VOICE_TTS_MIME: 'audio/wav' })
  const r = await speak('two short sentences')
  assert.equal(r.ok, true)
  assert.equal(r.mime, 'audio/wav')
  assert.equal(r.audio.toString(), 'AUDIO:two short sentences')
  assert.equal((await speak('   ')).ok, false, 'nothing to speak is not a call')
})

test('STT: stdin engines and {file} engines both work, and the temp clip is cleaned up', async () => {
  env({ PATH: withStubs, ATLAS_VOICE_STT_CMD: 'hear-stub', ATLAS_VOICE_MAX_AUDIO_BYTES: '' })
  assert.deepEqual(await transcribe(Buffer.from('audio-bytes')), { ok: true, text: 'spoken words' })

  env({ ATLAS_VOICE_STT_CMD: 'hear-file-stub {file}' })
  assert.equal(sttStatus().wantsFile, true)
  const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('atlas-kit-voice-')).length
  assert.deepEqual(await transcribe(Buffer.from('clip'), { mime: 'audio/webm' }), { ok: true, text: 'from-file:clip' })
  assert.equal(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('atlas-kit-voice-')).length, before, 'no temp clip left behind')

  assert.equal((await transcribe(Buffer.alloc(0))).ok, false, 'an empty clip is not a transcription')
})

test('a runaway, a hang and a failure are all reasons, not exceptions', async () => {
  env({ PATH: withStubs, ATLAS_VOICE_TTS_CMD: 'flood-stub', ATLAS_VOICE_MAX_AUDIO_BYTES: '4096' })
  assert.match((await speak('go')).error, /more than 4096 bytes/)

  env({ ATLAS_VOICE_TTS_CMD: 'hang-stub', ATLAS_VOICE_TTS_TIMEOUT_MS: '200', ATLAS_VOICE_MAX_AUDIO_BYTES: '' })
  assert.match((await speak('go')).error, /timed out after 200ms/)

  env({ ATLAS_VOICE_TTS_CMD: 'angry-stub' })
  const r = await speak('go')
  assert.equal(r.ok, false)
  assert.match(r.error, /exited 3: no model loaded/)

  env({ ATLAS_VOICE_STT_CMD: 'angry-stub' })
  assert.match((await transcribe(Buffer.from('clip'))).error, /exited 3/)
})

test('an oversized clip is refused before an engine is spawned', async () => {
  env({ PATH: withStubs, ATLAS_VOICE_STT_CMD: 'hear-stub', ATLAS_VOICE_MAX_AUDIO_BYTES: '10' })
  assert.match((await transcribe(Buffer.alloc(64))).error, /larger than 10 bytes/)
})
