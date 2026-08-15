# `addons/voice` — spoken recaps + dictation

Optional. Off unless you enable it (see [docs/ADDONS.md](../../docs/ADDONS.md)).

Two halves, both of which work with **nothing installed**:

- **Spoken recaps.** A *Voice* card on the dashboard turns fleet events — an agent
  ending a turn, flagging itself `ATLAS:READY-TO-SHIP`, merging its PR — into a line
  it can read aloud. **Say** reads the line with the browser's own voice: free, no
  server call. **Recap** spends one bounded `claude -p` call to summarize that
  agent's terminal tail and reads *that* instead.
- **Dictation.** `MicField` — the wrapper the Kanban's new-task fields, the task
  view, the Atlas chat and the agent spawn box already use — grows a mic button
  and transcribes into the field. The transcript lands in the field for review and
  **never auto-sends**.

Disable the addon and both disappear completely: the card returns `null`, and
`MicField` renders its child field and nothing else — no wrapper element, no
button, no request. That is the zero-addons invariant, and there is a test that
holds it (`web/src/components/MicField.test.mjs`).

---

## Enable it

```bash
# 1. turn it on
echo 'ATLAS_ADDONS=voice' >> .env      # comma-separated if you run others
scripts/serve.sh restart

# 2. only if your infra/Caddyfile predates this addon: let the dashboard reach
#    the server-side routes (infra/Caddyfile.example ships this block; see below)
#      handle /api/voice/* {
#        reverse_proxy localhost:3001 {
#          header_up Authorization "Bearer {env.DASHBOARD_BEARER_TOKEN}"
#        }
#      }

# 3. optional: an on-box engine instead of the browser's
bash addons/voice/install.sh            # detects what is here, installs nothing
bash addons/voice/install.sh --check    # 0 ready · 2 configured but missing · 1 can't
```

Step 1 alone gives you the whole zero-install experience. Steps 2 and 3 are the
enrichment, and the card says so out loud when it hits a route it cannot reach.

### Why the extra Caddy handler

The browser never holds the dashboard's bearer token — the reverse proxy injects
it, per route prefix. `POST /api/voice/recap`, `/speak` and `/transcribe` each
spend something (a model call, or CPU on an engine), so they gate themselves with
the same constant-time bearer check core uses. `infra/Caddyfile.example` carries
the `handle /api/voice/*` block, so a Caddyfile copied from the current example
already has it — an older one needs it added by hand plus a `serve.sh restart`
(Caddy reloads on restart, not on a web rebuild). Without the handler they
answer `401` to the browser, the card falls back to speaking the free event line,
and dictation falls back to the browser engine. Nothing breaks; the paid half is
just unreachable from the page. (`curl` with the token works either way.)

---

## What it costs

| | |
|---|---|
| **Zero-install path** | Nothing. No download, no key, no server call — the browser's `speechSynthesis` reads a line the dashboard already had. |
| **A recap** | One `claude -p` call on your Claude subscription (default `claude-haiku-4-5`), click-driven. Never fired automatically: auto-speak reads the *free* line. |
| **Recap guards** | 1 per agent per 60 s, **100/day across the whole fleet**, and never twice on an unchanged terminal tail. All three are per-process and configurable. |
| **`--engine espeak-ng`** | ~5 MB, offline, robotic. |
| **`--engine piper`** | ~250 MB out of tree (venv + onnxruntime) plus ~60 MB per voice; a few hundred MB resident while synthesizing; roughly real-time on a modern CPU core. |
| **On-box STT (whisper.cpp)** | Whatever your model costs (~150 MB for `base`), and CPU: a whisper-class model on CPU is *seconds* per utterance, not milliseconds. |
| **Storage** | None. No audio is written anywhere except a temp clip during an on-box transcription, deleted in the same call. Recap text is never persisted. |

The guards are the cost control, and they exist because a recap is fired by an
*event*, not by a human: upstream's equivalent summarizer, unguarded, made 2,753
model calls in one day where 2–5 was normal, because a flapping busy/idle status
is an event source with no natural rate limit.

---

## Privacy — plainly

| path | where the audio/text goes |
|---|---|
| **Speaking** (browser `speechSynthesis`) | Stays on your device — the OS voice. ⚠️ Chrome also offers *network* voices (the ones it labels "Google …"); which one it picks is a browser/OS setting, not ours. |
| **Speaking** (on-box engine) | Stays on the box. Nothing leaves it. |
| **Dictation** (browser Web Speech API) | ⚠️ **In Chrome and Safari this is a cloud service** — your audio goes to Google/Apple. That is how the API is implemented; the kit cannot change it. If that is not acceptable, use the on-box engine (and a browser with no Web Speech API, e.g. Firefox, so it is actually taken). |
| **Dictation** (on-box engine) | The clip is posted to *your* box, transcribed by *your* command, and the temp file is deleted. Nothing goes to a third party. |
| **A recap** | The agent's terminal tail is sent to Anthropic by the `claude` CLI on your subscription — exactly like every other `claude -p` call the kit makes. No API key is ever used (`ANTHROPIC_API_KEY` is blanked for the call). |

No API keys, no accounts, no third-party TTS/STT vendor anywhere in this addon.
The kit ships no voice model and downloads none unless you name one.

---

## On-box engines

An engine is a **command**, not a vendor:

```bash
ATLAS_VOICE_TTS_CMD="…"   # TEXT on stdin  → AUDIO on stdout
ATLAS_VOICE_STT_CMD="…"   # AUDIO on stdin, or at {file} → TRANSCRIPT on stdout
```

The string is split on whitespace and run **without a shell** — no quoting, no
pipes, no `&&`. That is deliberate: it comes from the environment of a process
that also holds your bearer token. Anything that needs a pipeline goes in a
wrapper script, which is exactly what `--engine whisper` writes for you.

Known-good shapes:

```bash
# tiny + offline, instantly available on most distros
ATLAS_VOICE_TTS_CMD="espeak-ng --stdout"

# natural voice, installed out of tree by install.sh --engine piper
ATLAS_VOICE_TTS_CMD="$HOME/.atlas-kit/voice/piper/bin/piper -m $HOME/.atlas-kit/voice/voices/en_US-amy-medium.onnx -f -"

# whisper.cpp behind the wrapper install.sh --engine whisper generates
# (it decodes the browser's webm/opus to 16 kHz mono wav with ffmpeg first)
ATLAS_VOICE_STT_CMD="$HOME/.atlas-kit/voice/stt-whisper.sh {file}"
```

`install.sh --engine piper` and `--engine espeak-ng` verify the engine by
synthesizing before they tell you to configure it: a command line that does not
actually work is worse than none. `--engine whisper` installs nothing — it wraps
a `whisper-cli` and a `WHISPER_MODEL` you already have.

### Every knob

| var | default | |
|---|---|---|
| `ATLAS_VOICE_MODEL` | `claude-haiku-4-5` | the model that writes a recap |
| `ATLAS_VOICE_EFFORT` | *(unset — flag omitted)* | thinking bound for that call |
| `ATLAS_VOICE_DAILY_BUDGET` | `100` | recap calls per calendar day, fleet-wide |
| `ATLAS_VOICE_MIN_INTERVAL_MS` | `60000` | …and per agent |
| `ATLAS_VOICE_MAX_LINES` / `_MAX_CHARS` | `140` / `6000` | how much terminal tail reaches the prompt |
| `ATLAS_VOICE_MAX_SPOKEN_CHARS` | `700` | hard cap on what gets read aloud |
| `ATLAS_VOICE_RECAP_TIMEOUT_MS` | `30000` | |
| `ATLAS_VOICE_TTS_CMD` / `_TTS_MIME` / `_TTS_TIMEOUT_MS` | *(none)* / `audio/wav` / `20000` | on-box speech |
| `ATLAS_VOICE_STT_CMD` / `_STT_TIMEOUT_MS` | *(none)* / `60000` | on-box dictation |
| `ATLAS_VOICE_MAX_AUDIO_BYTES` | `12582912` | bound on a clip and on an engine's output |
| `ATLAS_VOICE_DIR` | `$AGENT_LOCAL_DIR/voice` | where install.sh puts things |

`GET /api/addons` reports all of it — which engine is in use, whether it resolves,
the model, and how much of today's budget is spent.

---

## Routes

All three are bearer-gated and refuse outright when the server has no
`DASHBOARD_BEARER_TOKEN`.

| | |
|---|---|
| `POST /api/voice/recap` | `{agentId, agent, event, tail}` → `{ok, text}`, or `{ok:false, skipped}` when a guard held it back, or `{ok:false, error}`. Always `200` — a skip is a normal outcome. |
| `POST /api/voice/speak` | `{text}` → audio bytes from the on-box engine, or `503` with the reason. |
| `POST /api/voice/transcribe` | the raw clip as the request body → `{ok, text}`, or `503` with the reason. |

The terminal tail is posted *by the dashboard* rather than read here: the page
already holds every session's tail from `GET /api/agents`, and posting it also
covers sessions running on a workstation bridge, whose terminal this process
cannot see at all.

---

## What it structurally cannot do

- **Nothing speaks while the dashboard is closed.** Events are derived in the
  browser from the fleet poll the page already runs. Close the tab and there is no
  voice, no queue, and no backlog waiting for you — and opening it never recites
  history, because the first poll only seeds the baseline.
- **No wake word, no hands-free loop.** The mic starts on a click and stops on a
  click; dictation lands in a field for review and never sends anything.
- **On-box dictation has no live partials.** One pass on stop, because a CPU STT
  model re-transcribing a growing clip every second is a load generator, not a
  feature. The browser engine does stream words live.
- **Firefox has no `SpeechRecognition`.** There, dictation needs an on-box engine
  (which is also the privacy-clean combination). The mic button says so instead of
  failing silently.
- **A recap reads a terminal tail, not your repository.** It has no tools, no
  network and no side effects; its whole output is a few sentences that get read
  aloud.

---

## Tests

```bash
node --test addons/voice/test/*.test.mjs        # guards, engines, routes
cd web && npm test                              # event derivation, MicField parity
```

Hermetic by construction: no mic, no engine, no model, no network. The "engines"
are shell stubs on a temp `PATH` — which is precisely the contract a real one has
to meet — and `claude` is stubbed the same way.
