/* ------------------------------------------------------------------ *
 * THE ENCODER WORKER — where this addon's CPU actually runs.
 *
 * One thread, one `resident()` encoder, one loaded index, for the whole API
 * process. It imports the SAME leg functions the main thread would have called
 * (`searchHits`, `evidenceRows`) rather than reimplementing them, which is what
 * makes "the worker changes WHERE the sweep runs, never what it returns" a
 * property of the code and not a promise in a comment.
 *
 * ⚠️ The recursion breaks on `isMainThread`: inside here `encoderWorkerEnabled()`
 * is false, so those functions take their in-process path. Nothing in this file
 * may import the client.
 *
 * ⚠️ THE DEADLINES ARE NOT ENFORCED HERE, deliberately. This thread's own event
 * loop is blocked by the encoder exactly as the main one used to be, so a timer
 * set in here could not fire either — that is the whole bug. The budget is owned
 * by the caller on the main thread, which is now free to count.
 *
 * A handler never throws into the thread: an error becomes a reply, because a
 * worker that dies takes every concurrent retrieval with it.
 * ------------------------------------------------------------------ */
import { parentPort } from 'node:worker_threads'
import { onModelState, residentState } from './embed.mjs'
import { searchHits } from './semantic.mjs'
import { evidenceRows } from './evidence.mjs'

/** The two in-process semantic call sites, and the only ops that exist. An
 * unknown name is refused BY NAME rather than ignored — a typo must not read as
 * "the Atlas had nothing". */
const OPS = {
  'search-hits': searchHits, //  `/api/search`'s vector leg: embed the query, rank pages
  'evidence-rows': evidenceRows, // the spawn-evidence leg: embed the sub-asks, quote chunks
}

/* A load or an idle eviction that nobody asked about still has to reach the main
 * thread — it is what the next query's deadline is chosen from. */
onModelState((state) => parentPort.postMessage({ state }))

parentPort.on('message', async (msg) => {
  const { id, op, payload, sentAt } = msg || {}
  // How long this request sat behind another retrieval. The encoder is serial by
  // construction (one copy), so a slow `/api/search` behind a long spawn
  // retrieval is a real and otherwise invisible cause — see `semanticQueueMs` in
  // audit.log.
  const queueMs = Math.max(0, Date.now() - (sentAt || Date.now()))
  const reply = (m) => parentPort.postMessage({ id, queueMs, state: residentState(), ...m })
  const fn = OPS[op]
  if (!fn) return reply({ ok: false, error: `unknown encoder op ${op}` })
  try {
    reply({ ok: true, value: await fn(payload) })
  } catch (e) {
    reply({ ok: false, error: String(e?.message || e) })
  }
})
