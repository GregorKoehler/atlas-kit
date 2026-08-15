#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * Ingest one Instagram post from the shell — the same pipeline the endpoint
 * runs, minus the HTTP.
 *
 *   node --env-file=.env addons/instagram-ingest/scripts/ingest.mjs <url>
 *
 * `--env-file` matters: the cookie path, the model and the vault all come from
 * `.env`, and without it this process has none of them.
 *
 * ⚠️ PREFER THE ENDPOINT WHEN THE API IS UP. The vault's commit queue serialises
 * writers WITHIN a process; a second process writing at the same moment relies on
 * git's own pull-rebase-retry instead. For one manual ingest that is fine — for
 * anything automated, POST to the API and let the one queue own the vault.
 * ------------------------------------------------------------------ */
import { ingestInstagram } from '../api/ingest.mjs'

const url = process.argv[2]
if (!url || url === '--help' || url === '-h') {
  console.error('usage: node --env-file=.env addons/instagram-ingest/scripts/ingest.mjs <instagram-post-url>')
  process.exit(2)
}

const r = await ingestInstagram({ url, requestedBy: 'cli' })
for (const w of r.warnings || []) console.error(`  ! ${w}`)
if (!r.ok) {
  console.error(`FAILED (${r.status}): ${r.error}`)
  process.exit(1)
}
console.log(`${r.page}  (${r.images} image(s), analysis: ${r.analysis ? 'yes' : 'no'}${r.committed ? '' : ', nothing to commit — the page was already identical'})`)
