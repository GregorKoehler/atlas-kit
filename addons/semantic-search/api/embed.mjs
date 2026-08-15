/* ------------------------------------------------------------------ *
 * EmbeddingGemma-300M wrapper (ONNX Runtime via transformers.js) — the
 * document/query encoder behind this addon's two retrieval legs.
 *
 * ⚠️ TASK PROMPTS ARE NOT OPTIONAL. EmbeddingGemma is trained with a task
 * prefix on both sides, and embedding raw text is a misuse that silently
 * costs quality rather than failing loudly. Quoted from the model card
 * (google/embeddinggemma-300m, "Prompt Instructions"), which agrees with the
 * paper §2.2:
 *
 *   query    → `task: search result | query: {content}`
 *   document → `title: {title | "none"} | text: {content}`
 *
 * ⚠️ `dtype: 'quantized'` IS NOT A VALID transformers.js DTYPE. It does not
 * throw; it warns and silently falls back to fp32. Valid: fp32, fp16, q8, q4,
 * q4f16. The default here is **fp16**, measured bit-identical in retrieval
 * quality to fp32 at ~580 MB less steady-state resident memory — the trade that
 * matters for a model kept warm inside a long-lived Express process on a small
 * box.
 *
 * ⚠️ THREADS ARE CAPPED (3 by default). A box running this also runs the API,
 * a reverse proxy and agent sessions; ONNX Runtime defaults to every core and
 * would starve them.
 *
 * ⚠️ THE RUNTIME LIVES OUT OF TREE, and that is deliberate.
 * `@huggingface/transformers` pulls ~690 MB of ONNX Runtime native binaries and
 * the fp16 weights are another ~620 MB. Putting either in `api/package.json`
 * would tax every `npm ci` of the whole kit — including the many installs that
 * never enable this addon. Instead both are installed once by
 * `addons/semantic-search/install.sh` into `ATLAS_EMBED_DIR` and imported by
 * absolute path. When that directory is absent the leg simply reports itself
 * unavailable — the same degrade-don't-crash contract the agent bridge has.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const MODEL_ID = 'onnx-community/embeddinggemma-300m-ONNX'
export const DIMS = 768
export const MAX_LENGTH = 2048 // the model's context; also the tokenizer cap
export const DTYPE = process.env.ATLAS_EMBED_DTYPE || 'fp16'
export const THREADS = Number(process.env.ATLAS_EMBED_THREADS || 3)

/** Out-of-tree install root. Keep this in step with `install.sh`'s own default. */
export const EMBED_DIR = process.env.ATLAS_EMBED_DIR || path.join(os.homedir(), '.atlas-kit', 'embed')

export const QUERY_PROMPT = (content) => `task: search result | query: ${content}`
export const DOC_PROMPT = (title, content) => `title: ${title || 'none'} | text: ${content}`

/** Where the out-of-tree runtime and weights live. Both overridable on their own. */
export function runtimeDirs() {
  return {
    moduleDir: process.env.ATLAS_EMBED_MODULE_DIR || path.join(EMBED_DIR, 'node_modules'),
    modelDir: process.env.ATLAS_EMBED_MODEL_DIR || path.join(EMBED_DIR, 'models'),
  }
}

/** Is the encoder installed on this machine? Cheap enough to call per request. */
export function embedRuntimeAvailable() {
  const { moduleDir, modelDir } = runtimeDirs()
  return fs.existsSync(path.join(moduleDir, '@huggingface', 'transformers')) && fs.existsSync(path.join(modelDir, MODEL_ID, 'onnx'))
}

/**
 * Load tokenizer + model. Throws (never exits) when the runtime is missing —
 * callers gate on `embedRuntimeAvailable()` and degrade.
 */
export async function load({ dtype = DTYPE, threads = THREADS, moduleDir, modelDir } = {}) {
  const dirs = runtimeDirs()
  const mods = moduleDir || dirs.moduleDir
  const models = modelDir || dirs.modelDir
  const entry = path.join(mods, '@huggingface/transformers', 'dist', 'transformers.node.mjs')
  if (!fs.existsSync(entry)) {
    throw new Error(`embedding runtime not installed at ${mods} — run addons/semantic-search/install.sh`)
  }
  const { AutoTokenizer, AutoModel, env } = await import(pathToFileURL(entry).href)
  env.localModelPath = models
  env.allowRemoteModels = false
  const t0 = performance.now()
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID)
  const model = await AutoModel.from_pretrained(MODEL_ID, {
    dtype,
    session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 },
  })
  return { tokenizer, model, dtype, threads, loadMs: performance.now() - t0 }
}

/** L2-normalise in place, so cosine similarity is a plain dot product. */
function normalise(v) {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i] * v[i]
  n = Math.sqrt(n) || 1
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

/**
 * Embed already-prompted strings.
 *
 * `dims` truncates the 768-d vector (Matryoshka / MRL). ⚠️ The truncated slice
 * must be RE-NORMALISED, not just cut: the tail carries real magnitude, so a
 * raw slice of a unit vector is no longer unit and its dot products are not
 * cosines.
 *
 * → { vectors: Float32Array[], tokens: number } (tokens = real, from the tokenizer)
 */
export async function embed({ tokenizer, model }, texts, { dims = DIMS } = {}) {
  const inputs = await tokenizer(texts, { padding: true, truncation: true, max_length: MAX_LENGTH })
  // REAL (non-padding) token count, straight off the attention mask. The mask
  // is a BigInt64Array, so every element needs Number() — `bigint + number`
  // throws rather than coercing.
  let tokens = 0
  for (const x of inputs.attention_mask.data) tokens += Number(x)
  const out = await model(inputs)
  const emb = out.sentence_embedding // [batch, 768] mean-pooled + normalised by the graph
  const [n, d] = emb.dims
  const flat = emb.data
  const vectors = []
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(dims)
    for (let j = 0; j < dims; j++) v[j] = flat[i * d + j]
    // Idempotent at the full 768; load-bearing at every truncation.
    vectors.push(normalise(v))
  }
  return { vectors, tokens }
}

/* --- the resident model, for the long-lived API process ------------------- *
 * Loading costs ~2 s and ~660 MB settled RSS; paying 2 s per query is not a live
 * path, so the first query loads and every later one reuses. The PROMISE (not
 * the context) is cached so N concurrent first-queries share ONE load instead of
 * racing two checkpoints into the heap; a failed load clears the cache so a
 * later request can retry after the operator installs.
 *
 * IT IS ALSO EVICTED WHEN IDLE — but ⚠️ MEASURE BEFORE YOU BELIEVE WHAT THAT
 * BUYS. What eviction actually returns is far less than "unload the model"
 * suggests: measured, the model costs a stable 660-662 MB settled (1,319-1,416 MB
 * peak during queries) and `dispose()` gives back only 48-164 MB of it. The
 * session IS genuinely released — dispose() hands back the freed session handle —
 * but ORT's arena stays with the allocator. Repeated evict/reload does NOT leak
 * (39 MB in one run, 2 MB in another: noise), so this is safe, just weak.
 *
 * So it is kept, because it costs nothing while search is unused and it does
 * release the session and its ORT threads — but it is NOT the memory-pressure
 * fix it looks like. ATLAS_EMBED_IDLE_MS=0 holds the model forever and is a
 * defensible choice; the difference is ~100 MB, not ~660 MB. Returning the full
 * footprint to the OS needs the encoder in a SEPARATE PROCESS that gets killed,
 * which is an architecture change, not a knob. */
export const IDLE_MS = Number(process.env.ATLAS_EMBED_IDLE_MS ?? 20 * 60 * 1000)

let residentPromise = null
let idleTimer = null
let loadedAt = null
let lastLoadMs = 0

/* Load/unload go to the SAME append-only audit log as agent spawns, so "why was
 * that query slow" is answerable after the fact instead of guessed. A direct
 * appender rather than importing the executor's `audit`: that module boots the
 * whole tmux session registry on import, which a CLI indexer must not do. */
const AUDIT_LOG = path.join(process.env.AGENT_LOCAL_DIR || path.join(os.homedir(), '.atlas-kit'), 'audit.log')
function auditModel(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_LOG), { recursive: true })
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
  } catch {
    /* observability must never break retrieval */
  }
}

/* The model lives in a WORKER THREAD inside the API process (`embed-worker.mjs`),
 * and the main thread decides a query's deadline from whether it is loaded — a
 * cold load is a budget of 30 s, a warm embed 5 s. So an eviction that nobody
 * asked about has to REACH the main thread, or the next query after an idle
 * unload is given the warm budget and degrades once for no reason. One listener,
 * set by the worker; unset (and free) everywhere else, including the CLI indexer. */
let stateListener = null
export const onModelState = (fn) => {
  stateListener = fn
}
function announceState() {
  try {
    stateListener?.(residentState())
  } catch {
    /* a listener must never break retrieval, same as the audit appender */
  }
}

function armIdleTimer() {
  if (!IDLE_MS) return
  clearTimeout(idleTimer)
  idleTimer = setTimeout(evictResident, IDLE_MS)
  idleTimer.unref?.() // never hold the process open for an eviction
}

/** Release the ONNX session. Safe to call when nothing is loaded. */
export async function evictResident(reason = 'idle') {
  const p = residentPromise
  if (!p) return false
  residentPromise = null
  clearTimeout(idleTimer)
  const heldMs = loadedAt ? Date.now() - loadedAt : 0
  loadedAt = null
  try {
    const ctx = await p
    await ctx.model?.dispose?.()
  } catch {
    /* a load that failed has nothing to dispose */
  }
  auditModel({ event: 'embed-model-unload', model: MODEL_ID, dtype: DTYPE, reason, heldMs })
  announceState()
  return true
}

/**
 * Lazily load and keep the encoder warm until it goes idle. Rejects if the
 * runtime is missing. Every call re-arms the idle timer, so the model lives
 * exactly as long as search is being used.
 */
export function resident() {
  if (!residentPromise) {
    const t0 = Date.now()
    residentPromise = load()
      .then((ctx) => {
        loadedAt = Date.now()
        lastLoadMs = Math.round(loadedAt - t0)
        auditModel({ event: 'embed-model-load', model: MODEL_ID, dtype: DTYPE, threads: THREADS, loadMs: lastLoadMs, idleMs: IDLE_MS })
        announceState()
        return ctx
      })
      .catch((e) => {
        residentPromise = null
        throw e
      })
  }
  armIdleTimer()
  return residentPromise
}

/** Observable model lifecycle — so "is it loaded right now" is a fact, not a guess. */
export const residentState = () => ({
  // `loaded` means IN MEMORY, not "a load is in flight" — a query arriving
  // during the ~2 s cold load must not be told the model was already warm.
  loaded: loadedAt !== null,
  loading: residentPromise !== null && loadedAt === null,
  loadedAt: loadedAt ? new Date(loadedAt).toISOString() : null,
  lastLoadMs: lastLoadMs || null,
  idleEvictMs: IDLE_MS,
})
