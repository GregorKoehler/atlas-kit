# Optional addons

Core Atlas Kit ships what every install needs: markdown off disk, a BM25F
full-text pass, the typed query engine, the agent runtime, the Kanban. Some
things are worth having and are a **different class of dependency** — a 1.4 GB
ONNX encoder, a browser cookie jar, a feed poller with its own credentials.
Those ship as **addons**: self-contained directories under `addons/<name>/`,
loaded only when the operator enables them.

> 🔴 **Zero addons must be zero cost.** With nothing enabled the API reads one
> env var, registers nothing, and every response is byte-identical to a kit that
> never had the addon framework — no `legs` key on a search, no scorecard
> change, an inert evidence seam. If a change to core would break that, it is
> the wrong change.

---

## Enabling and disabling

Two ways, one precedence rule:

| | |
|---|---|
| `ATLAS_ADDONS=semantic-search,news-ingest` | env, comma-separated. **Wins whenever the variable is DEFINED** — `ATLAS_ADDONS=` (empty) means *no addons*, not "fall back to the file". |
| `addons.json` at the repo root | `{"enabled": ["semantic-search"]}`. Gitignored operator-local config; copy `addons.example.json`. Used only when `ATLAS_ADDONS` is unset. |

Enabling is a restart, not a reload: `scripts/serve.sh restart`. Disabling is the
same edit in reverse — the addon's code stays on disk and stops being imported.

`GET /api/addons` answers what is actually enabled **on this box**, which is how
the web UI gates addon surfaces at runtime. One build of `web/dist` serves every
install; a card appears because the addon is enabled here, never because someone
compiled a different bundle.

```json
{
  "addons": [
    { "name": "semantic-search", "description": "…", "hooks": ["searchLeg", "evidenceLeg", "…"], "status": { … } }
  ],
  "errors": []
}
```

An addon that fails to load lands in `errors` and is skipped. **A broken optional
feature must never cost you the dashboard**, so a missing directory, a syntax
error or a `register()` that throws is recorded and the API comes up anyway.

---

## Layout

```
addons/<name>/
  README.md          what it does, what it needs, what it costs — honestly
  install.sh         idempotent; --check reports state, --heal is the guarded auto-repair
  uninstall.sh       optional; reversible
  sweep.sh           optional; whatever the cron entry runs
  api/register.mjs   the ONE entry point core imports (optional — a skills-only addon has none)
  api/*.mjs          the addon's own code
  scripts/*.mjs      CLI tools (indexers, importers)
  skills/            optional Claude Code skills the addon ships
  test/*.test.mjs    run by CI in the same job as api/test (see .github/workflows/ci.yml)
```

An addon may import **node built-ins and core modules** (`../../../api/src/…`).
It must not add an npm dependency: core's `api/package.json` is what `npm ci`
installs, and an addon that needs a heavy runtime installs it **out of tree** via
its own `install.sh` (that is exactly what `semantic-search` does with ONNX
Runtime, and why it does).

---

## The hook API

`addons/<name>/api/register.mjs` default-exports **one function** that returns a
manifest. Every key is optional; returning `{}` is a legal addon.

```js
export default function register({ name, dir, repoRoot, express, Router }) {
  return {
    description,     // one line, shown by GET /api/addons
    routes,          // an Express Router, mounted on the app AFTER core's
    mcpTools,        // [{ name, description, inputSchema, handler }] — READ-ONLY
    searchLeg,       // { key, label, search({ q, limit, vaultPath }) }
    evidenceLeg,     // { subAsks, semanticCandidates } — the spawn-evidence seam
    scorecardStats,  // () => Stat[], joined onto the scorecard at READ time
    cron,            // [{ schedule, command, comment }]
    status,          // () => object, shown by GET /api/addons
  }
}
```

`register()` may be async. It runs once per process, at boot, before the port
opens — the API, the MCP stdio server and the MCP HTTP server each call
`loadAddons()` for themselves.

Returning an object rather than calling seven registration callbacks is what
keeps the surface stable: a new hook is a new optional key, and no existing
addon has to change to keep working.

### `routes` — an Express Router

Mounted **after** every core router, so an addon can extend the API but never
shadow a core route. It gets **no bearer gate**: core's write routes are behind
`DASHBOARD_BEARER_TOKEN` and an addon that adds a write must gate it itself.
Prefer read-only routes. (`instagram-ingest/api/register.mjs` is the worked
example of the constant-time bearer check on its one write route.)

> 🔴 **A write route is two things: the gate AND a Caddyfile block.** The browser
> never holds `DASHBOARD_BEARER_TOKEN` — `infra/Caddyfile` injects it per path
> prefix — so a self-gated route with no `handle` block answers **401 to the
> dashboard** while `curl` against `127.0.0.1:3001` with an explicit header
> works. Add the block next to the core write handlers, **above** the open
> `handle /api/*` read handler (Caddy takes the first matching one):
>
> ```
> handle /api/<your-addon>/* {
> 	reverse_proxy localhost:3001 {
> 		header_up Authorization "Bearer {env.DASHBOARD_BEARER_TOKEN}"
> 	}
> }
> ```
>
> `api/test/addon-caddyfile-bearer.test.mjs` loads every shipped addon and fails
> if any non-GET route it registers isn't matched by a bearer-injecting block in
> `infra/Caddyfile.example` — so this is checked, not remembered. (A Caddyfile
> change takes a `scripts/serve.sh restart`, not a web rebuild. An operator whose
> `infra/Caddyfile` predates the addon has to add the block by hand; say so in
> the addon's README.)

**`express` is handed to you, not imported.** A bare `import 'express'` resolves
from the importing file's directory, and `addons/<name>/api/` walks up to a repo
root with no `node_modules` — so it does not resolve from inside an addon at
all. Core already has express loaded and passes it in: `const routes = Router()`
is the whole of it, and take `express` itself when you also need
`express.json()`. Addons written before this seam `createRequire` express out of
core's tree instead; that still works and none of them has to change, but a new
addon should take the injected one — it is the only form that needs no knowledge
of where core keeps its `node_modules`.

### `mcpTools` — read-only tools

Registered on the box-local MCP surfaces (`dev.mcp.json`, `worker.mcp.json`,
`control.mcp.json`).

⚠️ **Addon tools are NOT part of the knowledge-only surface** — the seven read
tools the remote HTTP connector serves are a fixed, audited set, and an optional
addon's tool has not been through that review. If you need one remotely, that is
a deliberate change to `KNOWLEDGE_TOOLS` in `api/src/mcp/tools.mjs`, with the
reasoning written down.

### `searchLeg` — a second retriever

```js
searchLeg: {
  key: 'semantic',
  label: 'Semantic (vector)',
  async search({ q, limit, vaultPath }) {
    return { available: true, items: [...], index: {...}, ms: 12 }
    // or: { available: false, reason: 'encoder not installed — …', items: [] }
  }
}
```

It lands in `legs[]` on `GET /api/search` — and therefore in the MCP
`query_vault` answer, which reads that route.

> 🔴 **The legs are UNIONED, NEVER FUSED.** `items` keeps its exact meaning (the
> built-in BM25F ranking); a leg keeps its own list, its own order and its own
> per-row score. There is deliberately no router, no reciprocal-rank fusion and
> no blended ranking, and adding one is the single change this shape exists to
> prevent. Measured on the semantic leg: RRF over the two took MRR from 70.4% to
> 23.8%, because averaging destroys provenance — it hands the full-text leg's
> irrelevant top-10 the same mass as the right answers. Keeping them apart also
> keeps abstention honest: *"full-text 0 hits · semantic 24 hits, top similarity
> 0.31"* is a fact about the query that a merged list hides.

A leg **must not throw** (core catches anyway, as a belt) and **must** answer
`available: false` with a `reason` when it did not run: *"did not run"* and *"ran
and found nothing"* are different facts and every reader needs both.

### `evidenceLeg` — the spawn-evidence seam

Core's `api/src/atlas-evidence-semantic.mjs` is a thin delegating shim over this
hook; `api/src/atlas-candidates.mjs` — the evidence retriever itself — does not
change when an addon is enabled. Exactly one addon may supply it (the block
renders one labelled semantic section; a second would have to be merged into it,
which is the fusion above).

```js
evidenceLeg: {
  subAsks(task),                      // → [string, …]
  async semanticCandidates({ asks, root, enabled, closedPaths, doneWeight }),
  //   → { available, reason?, rows, pages, ms, queueMs?, index? }
}
```

`queueMs` is optional. A leg that runs its encoder off the main thread — as
`semantic-search` does, in one `worker_thread` shared by every call site — reports
how long the request queued behind another retrieval, and core logs it as
`semanticQueueMs` on the `atlas-evidence` audit line. Omit it and the line is
byte-identical to core's.

### `scorecardStats` — tiles at read time

```js
scorecardStats: () => [{ label: 'Last swept', value: '4 min', trend: 'neutral', group: 'Semantic index' }]
```

> 🔴 **One writer per file.** `data/scorecard.json` is written *wholesale* by its
> own producer. An addon that read-modify-wrote it would be a silent clobber —
> whichever ran last wins and the loser's tiles vanish with no error anywhere.
> So an addon *returns* its stats and core joins them into `GET /api/dashboard`
> on the way out. `GET /api/data/scorecard` still serves the raw file.

Return `[]` when there is nothing real to say. A hook that throws contributes
nothing and is dropped — a broken tile may not 500 the card. `trend` means *"is
this good"*: `up` paints green, `down` red, so a rising staleness is `down`.

### `cron` — declared, then materialised

```js
cron: [{ schedule: '*/5 * * * *', command: 'bash addons/x/sweep.sh >> /tmp/atlas-kit-addons.log 2>&1', comment: 'what it does' }]
```

`scripts/addon-cron.mjs` turns the enabled addons' declarations into
`/etc/cron.d/atlas-kit-addons` (`--install`, needs root); `command` is run as
root from the repo root. The file is **regenerated, never hand-edited**, so
disabling an addon and re-running removes its line instead of orphaning it. With
zero cron-declaring addons enabled, `--install` deletes the file.

Core's own cron (`infra/atlas-kit.cron` → `/etc/cron.d/atlas-kit`) is untouched
and stays the source of truth for the watchdog, the vault refresh and the daily
done-clear. Two separate files so they can never clobber each other.

---

## Writing one — the checklist

1. `addons/<name>/README.md`: what it does, what it needs, **what it costs**
   (RAM, disk, CPU, network, money) and what it structurally cannot do. Honestly
   — an operator deciding whether to enable something is the reader.
2. `install.sh`, idempotent, with `--check` (`0` installed / `2` installable /
   `1` cannot) so anything that wants to self-heal does not have to re-implement
   what "installed" means. Refuse early on disk/network rather than half-way.
3. `api/register.mjs` returning only the hooks you actually use.
4. **Degrade, never crash.** Not installed, half-installed, no network, a hung
   dependency — every one of those is `available: false` plus a reason a human
   can act on, never a throw into a route and never a broken dashboard.
5. `test/*.test.mjs` that pass on a CI machine with **none** of the addon's
   heavy dependencies installed. That means testing the pure parts directly and
   everything else through its degradation path.
6. Add it to the catalog below.

---

## Shipped catalog

| addon | what it adds | cost |
|---|---|---|
| [`semantic-search`](../addons/semantic-search/README.md) | Dense/vector retrieval as a second search leg (EmbeddingGemma-300M ONNX, section-chunk index, 5-min sweep), plus an off-by-default dense leg on the spawn-evidence block | ~1.4 GB disk out of tree, ~660 MB resident while warm, ~35 MB of vectors per ~11k chunks |
| [`instagram-ingest`](../addons/instagram-ingest/README.md) | `POST /api/ingest/instagram` + a CLI + a Claude Code skill: one post or reel → a `Wiki/Sources/` page (caption verbatim, stills, a `claude -p` read), through the commit queue, with a persistent ingest log | `yt-dlp` (~30 MB out of tree) and **your own** Instagram cookies; the stills it commits are permanent git blobs. Nothing runs unless you call it |
| [`voice`](../addons/voice/README.md) | Spoken recaps of fleet events (a runtime-gated Voice card) and dictation in every `MicField` — the browser speaks and listens by default; an on-box TTS/STT **command** can take over | Nothing for the default path (no download, no key, no server call). A recap is one `claude -p` call, guarded to 1/agent/minute and 100/day fleet-wide; an optional on-box engine is ~5 MB (espeak-ng) to ~310 MB (piper + a voice) out of tree |
| [`news-ingest`](../addons/news-ingest/README.md) | An hourly RSS/Atom sweep: every unseen item → a `Wiki/Sources/` page (feed text verbatim + a `claude -p` summary) and a rolling digest page, in one commit. `GET /api/news` + a runtime-gated News card, a bearer-gated manual sweep, a CLI and a skill | Your own feed list (`feeds.json`, gitignored) and one `claude -p` call per NEW item — capped per run (12) and per feed (5), so the cost is bounded by the caps, not by how loud your feeds are |
