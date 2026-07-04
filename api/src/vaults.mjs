/* ------------------------------------------------------------------ *
 * Vault registry — resolves a vault KEY → its on-box repo path + label.
 *
 * Atlas Kit is single-vault by default: set VAULT_PATH and everything
 * runs against that one Atlas checkout (keyed `atlas`, so its knowledge
 * agent becomes the orchestrator — see agent-routes/agent-local). An
 * optional operator-local `vaults.json` (gitignored) can register more
 * vaults for multi-vault setups; it is re-read per call so edits need no
 * restart.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const REGISTRY_FILE = process.env.VAULTS_FILE || path.join(HERE, 'vaults.json')
const FALLBACK_VAULT = process.env.VAULT_PATH || process.env.VAULT_DIR || '/vault'

function load() {
  try {
    const r = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'))
    if (r && typeof r === 'object' && !Array.isArray(r) && Object.keys(r).length) return r
  } catch {
    /* no/invalid registry → single-vault fallback */
  }
  return { atlas: { path: FALLBACK_VAULT, label: 'Atlas', default: true } }
}

/** [{ key, path, label, default }] — every configured vault. */
export function listVaults() {
  return Object.entries(load()).map(([key, v]) => ({
    key,
    path: v.path,
    label: v.label || key,
    hint: v.hint || '', // optional free-text to sharpen auto-route classification
    default: !!v.default,
  }))
}

/** The key used when a request names no vault. */
export function defaultVaultKey() {
  const vs = listVaults()
  return (vs.find((v) => v.default) || vs[0]).key
}

/** Resolve a key (or undefined → default) → { key, path, label }, or null if unknown. */
export function resolveVault(key) {
  const vs = listVaults()
  const wanted = key || defaultVaultKey()
  return vs.find((v) => v.key === wanted) || null
}

/** Is this vault a TYPED, queryable LLM-wiki (the Atlas pattern)? Detected the
 * same zero-config way ingest.mjs uses — the presence of a `Wiki/Legend.md`
 * type/edge registry — so any vault that carries a Legend (atlas, a sibling vault,
 * …) inherits the typed treatment (typed knowledge-agent preamble + structured
 * close prompt) with no per-vault flag. Plain LLM-wikis (work, recipes) have no
 * Legend → falsy. Resolves a key (or undefined → default) to its path first. */
export function isTypedVault(key) {
  const v = resolveVault(key)
  return !!v && fs.existsSync(path.join(v.path, 'Wiki', 'Legend.md'))
}

/* --- Async context: carry the active vault through a write pipeline --------- *
 * The write pipeline (capture/research/amend → ingest → git) spans many modules.
 * Rather than thread a `vault` param through every call, the orchestrator wraps
 * a job in `runInVault(key, fn)` and each leaf module reads `currentVaultPath()`.
 * Falls back to the default/`VAULT_DIR` when no context is set (back-compat). */
const als = new AsyncLocalStorage()

/** Run `fn` with `key`'s vault as the active context. Throws on unknown key. */
export function runInVault(key, fn) {
  const v = resolveVault(key)
  if (!v) throw new Error(`unknown vault "${key || '(default)'}"`)
  return als.run({ key: v.key, path: v.path }, fn)
}

/** Like runInVault, but with an EXPLICIT path instead of the registry path — e.g.
 * a git worktree of `key`'s vault. The context keeps `key`'s identity (so the
 * typed-vault overlay still keys off it) while `currentVaultPath()` points at the
 * worktree, so the ingest agent's cwd + all path-relative work land there. */
export function runInVaultAt(key, vaultPath, fn) {
  const v = resolveVault(key)
  if (!v) throw new Error(`unknown vault "${key || '(default)'}"`)
  return als.run({ key: v.key, path: vaultPath }, fn)
}

/** Absolute path of the vault for the current async context (or the default). */
export function currentVaultPath() {
  return als.getStore()?.path || resolveVault()?.path || FALLBACK_VAULT
}

/** Key of the vault for the current async context (or the default). */
export function currentVaultKey() {
  return als.getStore()?.key || defaultVaultKey()
}
