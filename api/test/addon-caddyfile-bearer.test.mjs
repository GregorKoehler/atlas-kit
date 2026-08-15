/* ------------------------------------------------------------------ *
 * Every WRITE route a shipped addon registers must be reachable from the
 * dashboard — i.e. `infra/Caddyfile.example` must inject the bearer on it.
 *
 * Why this file exists: addon routers are mounted WITHOUT core's bearer
 * middleware, so each addon gates its own writes itself. The browser never
 * holds the token — the reverse proxy injects it per path prefix — so an addon
 * write route with no `handle` block in the Caddyfile answers 401 to the page
 * while `curl http://127.0.0.1:3001` with an explicit header works. That gap is
 * invisible from the code and from the dashboard until a button 401s, and it
 * shipped three times (news-ingest, instagram-ingest, voice) before anyone
 * noticed. A NEW addon that forgets the block now goes red here instead.
 *
 * Hermetic: it enables every shipped addon in THIS process, reads the routes
 * off the real router express built, and matches them against the checked-in
 * example file. No network, no vault, no box state — `register()` only builds
 * a router; nothing an addon does at load reaches the filesystem.
 *
 * Run: node --test api/test/addon-caddyfile-bearer.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..', '..')
const ADDONS_DIR = path.join(REPO_ROOT, 'addons')
const CADDYFILE = path.join(REPO_ROOT, 'infra', 'Caddyfile.example')

/** Every addon in the tree that registers anything in the API process. */
const shipped = fs
  .readdirSync(ADDONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(ADDONS_DIR, d.name, 'api', 'register.mjs')))
  .map((d) => d.name)
  .sort()

// Enable them all before the loader is imported — enablement is read once.
process.env.ATLAS_ADDONS = shipped.join(',')
const { loadAddons, addonRouter, addonErrors } = await import('../src/addons.mjs')

/** Flatten an express router's layer tree into [{ path, methods }]. */
function collectRoutes(stack, out = []) {
  for (const layer of stack) {
    if (layer.route) {
      for (const p of [layer.route.path].flat()) out.push({ path: p, methods: Object.keys(layer.route.methods) })
    } else if (layer.handle?.stack) {
      collectRoutes(layer.handle.stack, out) // a mounted addon router
    }
  }
  return out
}

/**
 * The site's `handle` blocks, in file order, each flagged with whether it
 * injects the dashboard bearer. Order is the point: Caddy takes the FIRST
 * matching `handle` in a group, so a write route that matches the open
 * `/api/*` read handler first is unauthenticated no matter what follows.
 */
function handleBlocks(text) {
  const blocks = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*handle\s+(\S+)\s*\{\s*$/.exec(lines[i])
    if (!m) continue
    let depth = 1
    const body = []
    for (let j = i + 1; j < lines.length && depth > 0; j++) {
      depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length
      if (depth > 0) body.push(lines[j])
    }
    blocks.push({
      matcher: m[1],
      bearer: body.join('\n').includes('header_up Authorization "Bearer {env.DASHBOARD_BEARER_TOKEN}"'),
    })
  }
  return blocks
}

/** Caddy path matching, for the two forms this file uses: prefix and exact. */
const matches = (matcher, p) => (matcher.endsWith('*') ? p.startsWith(matcher.slice(0, -1)) : p === matcher)

test('every non-GET route a shipped addon registers is bearer-injected by Caddyfile.example', async () => {
  const loaded = await loadAddons()
  // A failed addon is recorded and skipped by design — which would make this
  // test pass by enumerating nothing. Assert the whole catalog actually loaded.
  assert.deepEqual(addonErrors(), [], 'every shipped addon must load for this test to mean anything')
  assert.deepEqual([...loaded.loaded].sort(), shipped)
  assert.ok(shipped.length >= 4, `expected the shipped addon catalog, got ${shipped.join(', ') || 'none'}`)

  const blocks = handleBlocks(fs.readFileSync(CADDYFILE, 'utf-8'))
  assert.ok(
    blocks.some((b) => b.matcher === '/api/*' && !b.bearer),
    'the open read handler is the fallback this test is guarding against — it should still be there',
  )

  const writes = collectRoutes(addonRouter().stack)
    // `_all` (from routes.all) survives the filter deliberately: it covers POST.
    .map((r) => ({ ...r, writeMethods: r.methods.filter((m) => !['get', 'head', 'options'].includes(m)) }))
    .filter((r) => r.writeMethods.length)
  assert.ok(writes.length >= 5, `expected the addons' write routes, found ${writes.length}`)

  for (const r of writes) {
    assert.equal(typeof r.path, 'string', 'a non-string route path cannot be checked against the Caddyfile')
    const first = blocks.find((b) => matches(b.matcher, r.path))
    assert.ok(
      first?.bearer,
      `${r.writeMethods.join('/').toUpperCase()} ${r.path} would ${
        first ? `fall into the token-free "handle ${first.matcher}" block` : 'reach no handler'
      } — add a bearer-injecting handle block for it in infra/Caddyfile.example, above "handle /api/*"`,
    )
  }
})
