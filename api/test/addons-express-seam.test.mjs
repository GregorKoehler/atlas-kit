/* ------------------------------------------------------------------ *
 * The express seam: an addon gets `express`/`Router` from its register()
 * context, so it never has to reach into core's node_modules to build a router.
 *
 * Why this file exists separately from addons-framework.test.mjs: the registry
 * is per-process and filled once, and the `demo` fixture there imports express
 * directly — which resolves only because fixtures live under `api/test/`. A real
 * addon lives in `addons/<name>/api/`, which walks up to a repo root with no
 * `node_modules`, so `import 'express'` does not resolve there at all. The
 * `injected` fixture imports NOTHING, so this is the only test that can fail if
 * the injection regresses.
 *
 * Run: node --test api/test/addons-express-seam.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import express from 'express'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.ATLAS_ADDONS_DIR = path.join(HERE, 'fixtures', 'addons')
process.env.ATLAS_ADDONS = 'injected'

const { loadAddons, addonRouter, addonErrors } = await import('../src/addons.mjs')

test('an addon builds its router from the INJECTED express — no import, no createRequire', async () => {
  const r = await loadAddons()
  assert.deepEqual(r.loaded, ['injected'])
  assert.deepEqual(addonErrors(), [])

  const app = express()
  app.use(addonRouter())
  const server = await new Promise((res) => {
    const s = app.listen(0, '127.0.0.1', () => res(s))
  })
  const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/injected/ping`)).json()
  assert.deepEqual(body, { ok: true, name: 'injected', json: true }, 'the router mounted, and express.json() came through too')
  await new Promise((res) => server.close(res))
})
