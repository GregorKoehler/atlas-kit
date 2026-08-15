/* ------------------------------------------------------------------ *
 * THE ENCODER WORKER, MAIN-THREAD SIDE — the fix for the frozen event loop,
 * and nothing else. The encoder and the cosine sweep run in ONE `worker_thread`
 * (`embed-worker.mjs`); this file is the only thing that talks to it.
 *
 * 🔴 WHY. Both of this addon's legs are CPU-bound and used to run ON the
 * Express event loop, so while one computed the API answered NOTHING — not
 * `/api/health`, not a poll, not a socket the agent bridge was holding open. A
 * retrieval over a large vault is a 10-20 s stretch, and a watchdog that reads a
 * missed health probe as "the API is dead" will kill the process a spawn is
 * running inside.
 * ⚠️ And the legs' OWN rescue deadlines could not fire while it happened — a
 * blocked loop cannot run its own timer. That is the property this file restores:
 * with the loop free, every deadline in `semantic.mjs` and `evidence.mjs` is real.
 *
 * 🔴 ONE WORKER, ONE ENCODER COPY. The model is ~660 MB resident and the index
 * tens of MB more; both live in the worker and NOWHERE ELSE in the API process.
 * Every in-process caller — `/api/search`'s semantic leg and the spawn-evidence
 * leg — routes through this single client, so two concurrent retrievals share one
 * worker and one `resident()` load promise inside it.
 * ⚠️ A worker thread shares the process ADDRESS SPACE, so this fixes latency and
 * NOT memory (ORT's arena is still the API's RSS). Returning the footprint needs
 * a separate process; that trade is argued in this addon's README and
 * deliberately not taken, since `ATLAS_EMBED_IDLE_MS=0` is already a defensible
 * way to say the memory is being held on purpose.
 *
 * ⚠️ IT IS OFF IN A CLI, and that is not an optimisation: a short-lived indexer
 * or eval harness has no event loop worth protecting, and a harness that MEASURES
 * the encoder through `residentState()`/`evictResident()` would, behind a worker,
 * report the main thread's permanently empty state and control nothing. Those set
 * `ATLAS_EMBED_WORKER=0` and keep the in-process behaviour exactly.
 *
 * DEGRADATION IS THE CONTRACT, unchanged: a worker that fails to start, dies
 * mid-call or misses its deadline resolves to `{ ok: false, reason }`, the leg
 * reports `available: false` with that reason, and the caller renders the
 * keyword-only block / the full-text leg alone. A spawn must never fail — or
 * stall — because of the semantic leg.
 *
 * ⚠️ NO NEW DEPENDENCY. `node:worker_threads` is a builtin, and the worker loads
 * the same out-of-tree ONNX runtime `install.sh` puts in `ATLAS_EMBED_DIR` — this
 * addon still adds nothing to any `package.json`.
 * ------------------------------------------------------------------ */
import { Worker, isMainThread } from 'node:worker_threads'
import { IDLE_MS, residentState } from './embed.mjs'

const WORKER_URL = new URL('./embed-worker.mjs', import.meta.url)

/** Is retrieval supposed to run off-thread here? False inside the worker itself
 * (it IS the encoder — the leg modules run their in-process path there, which is
 * what breaks the recursion), and false wherever `ATLAS_EMBED_WORKER=0`. Read at
 * call time, so a CLI can set it in its own body before the first retrieval. */
export const encoderWorkerEnabled = () => isMainThread && process.env.ATLAS_EMBED_WORKER !== '0'

/** What `residentState()` says when there is no worker (or it just died) —
 * the same five fields, so a consumer cannot tell which side answered. */
const cold = () => ({ loaded: false, loading: false, loadedAt: null, lastLoadMs: null, idleEvictMs: IDLE_MS })

/**
 * One lazily-spawned worker with a request/reply map over `postMessage`.
 *
 * Exported as a FACTORY as well as a singleton so the lifecycle — crash,
 * unexpected exit, an op that never answers, two concurrent calls sharing one
 * worker — is testable against a stub worker on a machine with no ONNX runtime,
 * which is every CI runner (`test/embed-worker.test.mjs`).
 */
export function createEncoderClient(url = WORKER_URL) {
  let worker = null
  let seq = 0
  let spawned = 0
  let state = cold()
  const pending = new Map() // id → resolve

  const settle = (id, r) => {
    const resolve = pending.get(id)
    if (!resolve) return // a deadline already abandoned it; the late reply is noise
    pending.delete(id)
    // Idle: stop holding the process open. A CLI or a test that has awaited its
    // last answer must be able to exit without terminating anything by hand.
    if (!pending.size) worker?.unref()
    resolve(r)
  }

  /** The worker is gone. Every in-flight call gets the reason, and the NEXT call
   * spawns a fresh one — a crash degrades one retrieval, it does not disable the
   * leg for the life of the process. `w` is checked because a dead worker's
   * `exit` can arrive after its replacement exists. */
  function down(w, reason) {
    if (worker !== w) return
    worker = null
    state = cold()
    for (const id of [...pending.keys()]) settle(id, { ok: false, reason })
  }

  function ensure() {
    if (worker) return worker
    const w = new Worker(url)
    worker = w
    spawned++
    w.on('message', (m) => {
      // Every reply carries the encoder's state, and a load/eviction announces
      // itself unsolicited — so `encoderState()` on this side is a mirror of the
      // real thing rather than a guess about it.
      if (m?.state) state = m.state
      if (m?.id != null) settle(m.id, m.ok ? { ok: true, value: m.value, queueMs: m.queueMs } : { ok: false, reason: m.error, queueMs: m.queueMs })
    })
    w.on('error', (e) => down(w, `encoder worker error: ${String(e?.message || e)}`))
    w.on('exit', (code) => down(w, `encoder worker exited (code ${code})`))
    w.unref()
    return w
  }

  return {
    /** The encoder's `residentState()`, mirrored from the worker. */
    state: () => state,
    /** Is a worker alive right now? */
    running: () => worker !== null,
    /** Terminate the worker and answer whatever is in flight with a reason.
     * ⚠️ Needed because a call ABANDONED by its deadline stays owed — the worker
     * cannot be cancelled mid-ONNX, so the client keeps the reference until the
     * answer arrives (or never). The API's shared client lives for the life of
     * the process and never calls this; a client that owns its own worker (the
     * tests) tears it down here rather than leaking a thread. */
    async stop() {
      const w = worker
      if (!w) return
      down(w, 'encoder worker stopped')
      await w.terminate()
    },
    /** How many workers this client has EVER started. One, for the life of a
     * healthy process — which is what "one encoder copy for every call site"
     * means operationally, and it goes up by exactly one per crash-and-respawn. */
    spawned: () => spawned,
    /**
     * → `{ ok: true, value, queueMs }` | `{ ok: false, reason }`. NEVER rejects:
     * every caller here degrades rather than failing, and a rejected promise is
     * one missing `.catch()` away from taking a spawn down with it.
     *
     * There is no timeout in here on purpose — the two legs already own their
     * deadlines (and their reason vocabulary), and those deadlines are exactly
     * what this change makes fire. An abandoned call's late reply is dropped by
     * `settle`.
     */
    call(op, payload) {
      let w
      try {
        w = ensure()
      } catch (e) {
        return Promise.resolve({ ok: false, reason: `encoder worker failed to start: ${String(e?.message || e)}` })
      }
      const id = ++seq
      return new Promise((resolve) => {
        pending.set(id, resolve)
        w.ref() // an answer is owed now — do not let the process exit under it
        try {
          w.postMessage({ id, op, payload, sentAt: Date.now() })
        } catch (e) {
          settle(id, { ok: false, reason: `encoder worker unreachable: ${String(e?.message || e)}` })
        }
      })
    },
  }
}

let singleton = null
/** THE one client, and therefore the one worker and the one model, for every
 * semantic call site in this process. */
export const sharedEncoderClient = () => (singleton ||= createEncoderClient())

/** Run one op on the shared encoder worker. */
export const callEncoder = (op, payload) => sharedEncoderClient().call(op, payload)

/** `residentState()` for whichever side actually holds the model — so
 * `/api/search`'s `model` field and the query budget mean the same thing with
 * the worker on and off. ⚠️ Does not spawn the worker: "nothing loaded" is a
 * legitimate answer and asking must not create the thing being asked about. */
export const encoderState = () => (encoderWorkerEnabled() ? sharedEncoderClient().state() : residentState())
