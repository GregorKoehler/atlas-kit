#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * One sweep from the shell — the same run the cron entry and the endpoint fire,
 * minus the HTTP.
 *
 *   node --env-file=.env addons/news-ingest/scripts/sweep.mjs
 *
 * `--env-file` matters: the vault, the model and every cap come from `.env`, and
 * without it this process has none of them.
 *
 * ⚠️ PREFER THE ENDPOINT WHEN THE API IS UP. The vault's commit queue serialises
 * writers WITHIN a process; a second process writing at the same moment relies on
 * git's own pull-rebase-retry instead. That is what `sweep.sh` accepts on cron
 * (there may be no API at all), but from a keyboard, POST /api/news/sweep and let
 * the one queue own the vault.
 * ------------------------------------------------------------------ */
import { sweepNews } from '../api/sweep.mjs'

const r = await sweepNews({ requestedBy: 'cli' })
for (const e of r.errors || []) console.error(`  ! ${e}`)
if (!r.ok) {
  console.error(`FAILED: ${r.error}`)
  process.exit(1)
}
console.log(
  `${r.written} item(s) filed from ${r.feeds} feed(s) — ${r.checked} checked, ${r.new} new` +
    `${r.deferred ? `, ${r.deferred} deferred by the per-run cap` : ''}`,
)
for (const i of r.items || []) console.log(`  · ${i.page}  ${i.title}`)
