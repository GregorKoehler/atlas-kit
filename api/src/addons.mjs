/* ------------------------------------------------------------------ *
 * The OPTIONAL-ADDON loader — the whole framework, in one file.
 *
 * Core ships what every install needs: markdown off disk, a full-text pass, the
 * typed query engine, the agent runtime. Anything with a heavier class of
 * dependency — a 1.4 GB ONNX encoder, a browser cookie jar, a feed poller — is
 * an ADDON: a self-contained directory under `addons/<name>/` that is loaded
 * only when the operator enables it.
 *
 * 🔴 ZERO ADDONS MUST BE ZERO COST. With nothing enabled this module reads one
 * env var (and, at most, one small JSON file), registers nothing, and every
 * consumer below sees an empty list — so the API, the MCP server and the
 * evidence block behave exactly as they did before addons existed. That is the
 * property that lets an addon be genuinely optional rather than "off by a flag
 * but still in every code path".
 *
 * ENABLEMENT, two ways and one precedence rule:
 *   ATLAS_ADDONS=semantic-search,news-ingest   env wins whenever it is DEFINED
 *                                              (`ATLAS_ADDONS=` means none)
 *   addons.json                                {"enabled": [...]}, gitignored,
 *                                              `addons.example.json` shipped
 *
 * THE HOOK API is deliberately DECLARATIVE and deliberately small. An addon
 * exports one function from `addons/<name>/api/register.mjs`:
 *
 *   export default async function register({ name, dir, repoRoot, express, Router }) {
 *     return {
 *       description,     // one line, shown by GET /api/addons
 *       routes,          // an Express Router, mounted on the app
 *       mcpTools,        // [{ name, description, inputSchema, handler }] — READ-ONLY
 *       searchLeg,       // { key, label, search({ q, limit, vaultPath }) }
 *       evidenceLeg,     // { subAsks, semanticCandidates } — the spawn-evidence seam
 *       scorecardStats,  // () => Stat[], appended to the scorecard at READ time
 *       cron,            // [{ schedule, command, comment }] — see scripts/addon-cron.mjs
 *       status,          // () => object, shown by GET /api/addons
 *     }
 *   }
 *
 * Every key is optional. Returning an object rather than calling seven
 * registration callbacks is what keeps the surface stable: a new hook is a new
 * optional key, and no existing addon has to change to keep working.
 *
 * See docs/ADDONS.md for the model, the catalog and how to write one.
 * ------------------------------------------------------------------ */
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '..', '..')
export const ADDONS_DIR = process.env.ATLAS_ADDONS_DIR || path.join(REPO_ROOT, 'addons')

/* An addon name is used to build a filesystem path and is read from an env var
 * and an operator-editable JSON file, so it is validated rather than trusted:
 * lowercase, digits and dashes only. `../` never resolves to a directory here. */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

/** The addons the operator asked for, in order, deduped. Never throws. */
export function enabledNames() {
  const raw =
    process.env.ATLAS_ADDONS !== undefined
      ? process.env.ATLAS_ADDONS
      : (() => {
          try {
            const j = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'addons.json'), 'utf-8'))
            return Array.isArray(j?.enabled) ? j.enabled.join(',') : ''
          } catch {
            return '' // no file, or an unreadable one → no addons, which is the default
          }
        })()
  return [...new Set(String(raw).split(',').map((s) => s.trim()).filter(Boolean))]
}

/* --- the registry --------------------------------------------------------- *
 * Filled once per process by `loadAddons()`. Consumers (read-routes, the MCP
 * tool table, the evidence seam) read it through the accessors below, so a
 * process that never calls `loadAddons()` — a CLI wrapper, a test — simply sees
 * no addons instead of failing. */
const loaded = [] // [{ name, dir, description, manifest }]
const errors = [] // [{ name, error }]
let loading = null

/** Registered search legs, in enablement order. Each is a SECOND retriever
 *  beside the built-in BM25F pass — never merged into it (see vault-search.mjs). */
export const addonSearchLegs = () => loaded.flatMap((a) => (a.manifest.searchLeg ? [{ addon: a.name, ...a.manifest.searchLeg }] : []))

/** Read-only MCP tools contributed by addons. */
export const addonMcpTools = () => loaded.flatMap((a) => a.manifest.mcpTools ?? [])

/** The dense leg of the SPAWN-EVIDENCE block, or null.
 *  Exactly one addon may supply it — the first enabled one wins, because the
 *  evidence block renders ONE labelled semantic section and a second leg would
 *  have to be merged into it, which is the fusion this design refuses. */
export const addonEvidenceLeg = () => loaded.find((a) => a.manifest.evidenceLeg)?.manifest.evidenceLeg ?? null

/** Extra scorecard stats, joined onto `data/scorecard.json` at READ time.
 *  A stats hook that throws is dropped: a broken tile must not 500 the card. */
export function addonScorecardStats() {
  const out = []
  for (const a of loaded) {
    try {
      const rows = a.manifest.scorecardStats?.()
      if (Array.isArray(rows)) out.push(...rows)
    } catch {
      /* observability must never break the read */
    }
  }
  return out
}

/** The rows `GET /api/addons` serves — what is enabled and what it contributes. */
export function addonList() {
  return loaded.map((a) => ({
    name: a.name,
    description: a.description,
    hooks: Object.keys(a.manifest).filter((k) => k !== 'description' && a.manifest[k] != null),
    status: (() => {
      try {
        return a.manifest.status?.() ?? null
      } catch (e) {
        return { error: String(e?.message || e) }
      }
    })(),
  }))
}

/** Addons that failed to load — surfaced, never swallowed. */
export const addonErrors = () => errors.map((e) => ({ ...e }))

/** Cron entries every enabled addon wants wired (see scripts/addon-cron.mjs). */
export const addonCron = () => loaded.flatMap((a) => (a.manifest.cron ?? []).map((c) => ({ addon: a.name, ...c })))

/**
 * Load every enabled addon. Idempotent per process (the promise is cached), so
 * the API, the MCP stdio server and the MCP HTTP server can each call it at
 * boot without coordinating.
 *
 * 🔴 AN ADDON MAY NEVER TAKE THE PROCESS DOWN. A missing directory, a syntax
 * error, a register() that throws — each is recorded in `errors` and skipped.
 * The dashboard is the operator's control surface; losing it because an optional
 * feed poller has a typo is the wrong trade in every direction.
 */

/* --- what register() is HANDED -------------------------------------------- *
 * `express` is INJECTED, not imported by the addon. Node resolves a bare
 * specifier from the IMPORTING file's directory, and `addons/<name>/api/` walks
 * up to a repo root that has no `node_modules` — so `import 'express'` does not
 * resolve from inside an addon at all. Core already holds the module; handing it
 * over is one more property on a context object the addon is given anyway, and
 * it removes the `createRequire` reach into core's dependency tree that addons
 * written before this seam use instead.
 *
 * ⚠️ ADDITIVE ONLY. An addon that destructures `{ name, dir, repoRoot }` and
 * ignores the rest — every addon shipped so far — behaves byte-identically, and
 * with zero addons enabled this function is never called at all. `Router` is
 * wrapped rather than passed by reference so a detached call can never depend on
 * express's own `this`. */
function registerContext(name, dir) {
  return { name, dir, repoRoot: REPO_ROOT, express, Router: (opts) => express.Router(opts) }
}

export function loadAddons() {
  if (loading) return loading
  loading = (async () => {
    for (const name of enabledNames()) {
      const dir = path.join(ADDONS_DIR, name)
      const entry = path.join(dir, 'api', 'register.mjs')
      try {
        if (!NAME_RE.test(name)) throw new Error('invalid addon name (a-z, 0-9, dashes)')
        if (!fs.existsSync(dir)) throw new Error(`no such addon directory: ${dir}`)
        // An addon with no api/ half (a skills-only or docs-only addon) is
        // legitimate: it is enabled, it just registers nothing in this process.
        let manifest = {}
        if (fs.existsSync(entry)) {
          const mod = await import(pathToFileURL(entry).href)
          if (typeof mod.default !== 'function') throw new Error('api/register.mjs must default-export a register function')
          // `await` so register() may be async without every addon having to be.
          manifest = (await mod.default(registerContext(name, dir))) || {}
        }
        loaded.push({ name, dir, description: manifest.description || '', manifest })
      } catch (e) {
        errors.push({ name, error: String(e?.message || e) })
        console.error(`[atlas-kit] addon "${name}" failed to load: ${e?.message || e}`)
      }
    }
    return { loaded: loaded.map((a) => a.name), errors: addonErrors() }
  })()
  return loading
}

/**
 * `GET /api/addons` + every addon's own routes.
 *
 * The list endpoint is what lets the WEB UI gate addon surfaces AT RUNTIME
 * rather than at build time: one build of `web/dist` serves every install, and
 * a card appears because the addon is enabled on that box, not because someone
 * compiled a different bundle. Call `loadAddons()` before mounting this.
 */
export function addonRouter() {
  const r = express.Router()
  r.get('/api/addons', (_req, res) => res.json({ addons: addonList(), errors: addonErrors() }))
  for (const a of loaded) if (a.manifest.routes) r.use(a.manifest.routes)
  return r
}
