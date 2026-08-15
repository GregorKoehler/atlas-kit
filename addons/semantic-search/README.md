# `semantic-search` — dense retrieval over the vault

A **second retrieval leg** beside core's BM25F full-text pass: a resident
[EmbeddingGemma-300M](https://huggingface.co/onnx-community/embeddinggemma-300m-ONNX)
ONNX encoder and a section-chunk vector index over your Atlas, swept every five
minutes. It answers the one question the full-text leg structurally cannot:
*"find the page about this, when I do not know the words that page uses."*

> 🔴 **Two legs, never one list.** `GET /api/search` returns the full-text
> ranking and this leg **separately and labelled**. There is no router, no
> reciprocal-rank fusion, no blended score — and that is measured, not stylistic.
> See [What fusion costs](#what-fusion-costs).

---

## What it buys, measured

On a benchmark of **28 queries whose answer page shares no vocabulary with the
query** — the case this exists for:

| | full-text (BM25F) | semantic |
|---|---|---|
| recall@10 | **7.1 %** | **96.4 %** |
| cross-lingual DE↔EN recall | **0 %** | **100 %** |

And the other direction, on a general query set, so the trade is visible in
both: the full-text leg wins **exact identifiers, PR numbers, file paths, rare
slugs and quoted phrases** outright. Two specific measured cases:

- A quoted phrase is a *filter*; cosine similarity has no notion of contiguity.
  **There is no dense equivalent of a quoted phrase.**
- A long project page that mentions a term 25 times ranks #1 lexically and #15
  semantically — chunking destroys exactly the page-level term-frequency
  evidence BM25F uses. ⚠️ Note the tension: **chunking is what makes the dense
  leg work and what breaks this lexical case.** It is the same page BM25F itself
  buries when *not* chunked. Neither leg is the better one; they fail
  differently, which is why both are returned.

**The dense leg cannot return nothing.** Cosine similarity to every chunk in the
vault is never empty, so it always answers with a confident-looking page list.
That is why every row carries `similarity` and why the score is *shown* rather
than hidden behind a threshold: a top score of **0.31 means "nothing close"**,
and only the reader can say so.

---

## What it costs, measured

Measured on a 4-core / 7.6 GB box against a **1,624-page → 11,445-chunk** vault,
fp16, 3 threads:

| | |
|---|---|
| disk, out of tree (`ATLAS_EMBED_DIR`) | **~1.4 GB** (~690 MB ONNX Runtime + ~620 MB fp16 weights) |
| resident RAM while warm | **660–662 MB** settled; **1,319–1,416 MB** peak during a query |
| cold model load | **~2–3 s** (the first query after an idle eviction pays it) |
| index on disk | **~35 MB** of float32 — 768 dims × 4 bytes × chunks, i.e. **~3 KB per chunk**, and chunks run roughly **7 per page** |
| first full index | **82 min** wall, 2.31 chunks/s, 3.66 M tokens embedded |
| incremental sweep, nothing changed | **~0.33 s**, writes ~150 bytes |
| a query | ~34 ms to embed + ~14 ms to scan 11,445 chunks brute-force |

**Scaling.** The index is linear in chunks and the scan is brute-force: ~14 ms
per 11k chunks, so ~130 ms at 100k. There is no ANN index and no vector database
on purpose — at this size a graph index would add a moving part for nothing.
Past a few hundred thousand chunks that stops being true.

**Idle eviction.** The encoder releases its ONNX session after
`ATLAS_EMBED_IDLE_MS` (20 min). ⚠️ Measure before you believe what that buys:
`dispose()` gives back only **48–164 MB** of the 660 MB, because ORT's arena
stays with the allocator. It is kept because it costs nothing and does release
the session and its threads — it is **not** the memory-pressure fix it looks
like. `ATLAS_EMBED_IDLE_MS=0` holds the model forever and is a defensible
choice; the difference is ~100 MB, not ~660 MB.

---

## Off the main thread — one worker, one encoder copy

The encoder is CPU-bound and does not yield, so it does **not** run on the API's
event loop: `api/embed-client.mjs` (main-thread side) hands the work to
`api/embed-worker.mjs`, one `worker_thread` that owns the one encoder and the one
loaded index for the whole process. Both in-process call sites route through it:

| op | function | what moved |
|---|---|---|
| `search-hits` | `searchHits()` in `api/semantic.mjs` | embed the query, cosine-rank the pages |
| `evidence-rows` | `evidenceRows()` in `api/evidence.mjs` | embed the sub-asks (one batch), chunk-level scan, quote the chosen pages |

The third caller — the CLI indexer — is its own short-lived process and keeps
running in-process. **No new dependency:** `node:worker_threads` is a builtin and
the worker loads the same out-of-tree runtime `install.sh` installs.

**Why it matters.** With the encoder on the loop, a 10–20 s retrieval is 10–20 s
during which the API answers nothing at all — including the health probe a
watchdog reads to decide the process is dead, and including a keep-alive socket
an agent spawn is waiting on. A watchdog that restarts on a missed probe will
reap a perfectly healthy API mid-retrieval, and the restart evicts the encoder so
the next query is cold again.

### The three things that changed behaviour, not just location

- 🔴 **The deadlines are real now.** `ATLAS_EVIDENCE_SEMANTIC_MS` (6 s) and
  `/api/search`'s budgets could not fire while the leg held the loop — a blocked
  loop cannot run its own timer. With the loop free they fire: a cold or wedged
  encoder costs a spawn 6 s and a keyword-only block instead of freezing the API.
  ⚠️ That is a real change for a **cold** spawn — on a box that evicts the model,
  the first spawn after an eviction will more often land keyword-only.
  `ATLAS_EMBED_IDLE_MS=0` removes that case. `/api/search` picks its budget the
  same way: 5 s warm, 30 s while the model is loading, from the state the worker
  mirrors back as it loads and evicts.
- ⚠️ **The encoder is serial** (one copy, by design), so a query can now spend its
  budget QUEUEING behind another retrieval and degrade where it used to simply
  wait. Never silent: `queueMs` rides the leg's answer and `semanticQueueMs` the
  `atlas-evidence` audit line, so a slow embed and a queued one are
  distinguishable in the log rather than guessed at. The field is present only
  when the retrieval ran off-thread, so a core or in-process line is unchanged.
- **Degradation is unchanged in shape**: a worker that fails to start, crashes,
  exits or overruns yields `available: false` + a reason, exactly as a missing
  encoder always did. A crash costs ONE retrieval — the next call spawns a fresh
  worker.

⚠️ **It fixes latency, not memory.** A worker thread shares the process address
space, so ORT's arena is still the API's RSS. Returning the footprint would need
a separate process, which is a different trade (a lifecycle to supervise, a
transport, a second place for the encoder to be missing) and is not taken here.

`meta.json` and the vector file are also read separately (`loadMeta` vs
`loadIndex`): the main thread answers "is there a usable index, how stale, which
model" from the metadata plus one `stat` of the vector file, and **only the
worker reads the floats** — otherwise the 35 MB index would sit in the process
twice and its `readFileSync` would be back on the loop.

Guards: `test/embed-worker.test.mjs` — loop responsiveness (with the inline arm
asserted too, so the test can SEE the old behaviour), crash / exit / hang /
deadline degradation, and one worker shared by both call sites. Hermetic: a stub
worker plus an `ATLAS_EMBED_DIR` that looks installed and is not.

---

## Install

```bash
addons/semantic-search/install.sh          # ~1.4 GB download; idempotent
# enable it (either one):
echo 'ATLAS_ADDONS=semantic-search' >> .env
cp addons.example.json addons.json && $EDITOR addons.json
# build the index (~90 min cold on a 1.6k-page vault; minutes thereafter)
node addons/semantic-search/scripts/index.mjs
scripts/serve.sh restart
```

`install.sh` also wires the five-minute sweep into
`/etc/cron.d/atlas-kit-addons` when run as root (via
`scripts/addon-cron.mjs --install`, which regenerates that file from whatever
addons are enabled).

**Until it has run, nothing is broken.** The leg answers `available: false` with
a reason, the full-text leg is byte-identical to before, and the dashboard is
unchanged. The feature is inert, not failed.

### Why the runtime lives out of tree

`@huggingface/transformers` pulls ~690 MB of ONNX Runtime native binaries and the
weights are another ~620 MB. Putting either in `api/package.json` would tax every
`npm ci` of the whole kit — including the many installs that never enable this
addon. So both install once into `$ATLAS_EMBED_DIR` (default
`~/.atlas-kit/embed`) and are imported by absolute path.

### Self-healing

Because it lives out of tree, no deploy ever puts it back — and its loss is
**silent**: search just quietly narrows to one leg. So `sweep.sh` runs
`install.sh --heal` before each sweep: guarded by a persisted exponential backoff
(15 min after the first failure, doubling to an 8 h ceiling), single-flighted on
a lock, and opt-out-able with `ATLAS_EMBED_AUTOINSTALL=0`.

**And it says so.** While the encoder is missing, the leg's `reason` distinguishes
four situations a bare "not installed" flattens into one:

- *"the scheduled sweep reinstalls it automatically"* — never installed here
- *"a reinstall is running now"* — in flight; it comes back on its own
- *"N failed reinstall attempts: `<why>` — backing off"* — needs you
- *"auto-reinstall is off (`ATLAS_EMBED_AUTOINSTALL=0`)"* — you decided this

## Uninstall

```bash
addons/semantic-search/uninstall.sh                 # ~1.4 GB back; keeps the index
addons/semantic-search/uninstall.sh --purge-index   # …and the vault's data/atlas-index/
```

Just *disabling* the addon (drop it from `ATLAS_ADDONS` / `addons.json`, restart)
is enough to make the kit behave as if it were never there; the script is for
reclaiming the disk.

---

## What it adds to the kit

| surface | what changes |
|---|---|
| `GET /api/search` | a `legs[]` entry — `{ key: 'semantic', label, available, items[], reason?, index?, ms }`. `items` (BM25F) is untouched. |
| MCP `query_vault` | the same, since the tool reads that route. `query_vault`'s description gains a paragraph naming the leg, only when it is installed. |
| SearchBar | a labelled "Semantic (vector)" block under the full-text hits, with each row's section breadcrumb and cosine. An unavailable leg shows one amber line with the reason. |
| Scorecard | a **Semantic index** group — last swept, re-embedded today, chunks indexed. Renders **nothing** until a sweep has actually run. |
| spawn evidence | an optional dense leg, **off by default** — see below. |

### The spawn-evidence leg is OFF by default — read this before enabling it

`ATLAS_EVIDENCE_SEMANTIC=1` adds a dense section to the evidence block an agent
opens with. It is off because **it was measured and it did not work yet.** On 13
real spawn tasks, each paired with the one Atlas fact it has to arrive knowing:

| | keyword only | keyword + semantic |
|---|---|---|
| the fact's **page** in the block | 84.6 % | 84.6 % |
| the **passage** carrying it | 23.1 % | 23.1 % |

Identical — for **+4.5 KB and +709 ms on every spawn**. That is a real cost
against a measured zero benefit, i.e. a regression, so it does not ship enabled.

What it *does* add is ~1–2 pages per spawn the keyword-only block never names at
all, quoted with a breadcrumb and a similarity. If that is what you want, turn it
on knowingly.

**Why, and therefore what would fix it:** the binding constraint is the index's
**chunk size**, not the retriever. The index is built for *search*, where the
deliverable is a page link, so sections run to ~2048 chars — and the paragraph
carrying a needed constraint is rarely what a 2048-char section is *about*. The
carrier chunk was the page's top-scoring chunk in 1 of 11 cases, and even with an
unbounded section budget it renders in only 4 of 13. So the follow-up is a finer
chunking for the evidence path — not more pages, more chunks per page, or a
bigger budget, all of which were swept and none of which moved it. A live
paragraph-level re-rank was tried and rejected on cost: >10 s per task against a
6 s deadline.

---

## What fusion costs

Reciprocal-rank fusion over these two legs was measured, not assumed: **MRR
23.8 %, against the vector leg's own 70.4 %.** Averaging destroys provenance — it
hands the full-text leg's irrelevant top-10 the same `1/(60+rank)` mass as the
right answers.

Keeping the legs apart preserves what fusion destroyed, and it turns abstention
from a threshold guess into an information one: *"full-text 0 hits · semantic 24
hits, top similarity 0.31"* is the honest signal, and it is exactly the signal a
fused list hides. A router is no better: it picks an engine **before** seeing any
result, where the consuming agent picks **after** seeing the content.

---

## Configuration

| env | default | |
|---|---|---|
| `ATLAS_SEMANTIC` | on | `0` is a kill switch that leaves the addon enabled — restores the pre-semantic response exactly |
| `ATLAS_SEMANTIC_VAULT` | the default vault | which vault is indexed and reported on |
| `ATLAS_EMBED_DIR` | `~/.atlas-kit/embed` | the out-of-tree runtime + weights |
| `ATLAS_EMBED_DTYPE` | `fp16` | ⚠️ `quantized` is **not** a valid transformers.js dtype — it warns and silently falls back to fp32. Valid: `fp32`, `fp16`, `q8`, `q4`, `q4f16`. |
| `ATLAS_EMBED_THREADS` | `3` | ORT defaults to every core and would starve the rest of the box |
| `ATLAS_EMBED_IDLE_MS` | `1200000` | `0` holds the model forever (see above for what eviction really buys) |
| `ATLAS_EMBED_AUTOINSTALL` | `1` | `0` disables the self-heal |
| `ATLAS_EMBED_WORKER` | on | `0` runs the encoder ON the API's main thread again — i.e. the event-loop block described above. For a short-lived CLI or an eval harness that has no loop to protect and drives `residentState()`/`evictResident()` itself. |
| `ATLAS_SEMANTIC_TIMEOUT_MS` | `5000` | one embed. ⚠️ Separate from the load budget on purpose. |
| `ATLAS_SEMANTIC_LOAD_TIMEOUT_MS` | `30000` | a cold load is a measured ~2–3 s; 30 s means "hung", not "slow" |
| `ATLAS_EVIDENCE_SEMANTIC` | unset (off) | `1` turns on the spawn-evidence dense leg — read the section above |
| `ATLAS_EVIDENCE_SEMANTIC_MS` | `6000` | the whole evidence leg's deadline; over it, the spawn proceeds keyword-only. ⚠️ It **fires** now — see "Off the main thread"; while the leg held the loop it was decorative |
| `ATLAS_INDEX_MIN_AVAIL_MB` | `800` | the indexer's memory floor — it stops and persists rather than OOM |

## The index

Lives in the vault's own gitignored `data/atlas-index/`. **Vectors never go into
`Wiki/` or `Tasks/`.** Three files:

- `meta.json` — provenance (model, dtype, dims, chunker version, `builtAt`) plus
  one row per chunk: path, title, heading breadcrumb, content hash, and the
  **char range** into the page. Bodies are *not* stored; a snippet is sliced live
  out of the page at that range.
- `vectors.f32` / `vectors.b.f32` — float32, in row order. ⚠️ The indexer
  **ping-pongs** between the two names so that renaming `meta.json` is the only
  commit point, and readers take the name from `meta.json`. A reader that
  hard-codes one name works after an even number of rebuilds and fails after an
  odd one.
- `sweep.json` — ~150 bytes: when a sweep last *confirmed* the index matches the
  vault, and today's churn counter. Separate from `meta.json` because a no-op
  sweep must not rewrite 35 MB to move a timestamp — and separate from
  `data/scorecard.json` because that file has one writer and a second producer on
  it is a silent clobber.

Re-indexing is **incremental by content hash over the exact prompted string**, so
an edit session re-embeds tens of chunks out of eleven thousand. The row table is
regenerated rather than patched, so deletions, moves and reordering are correct
by construction.

```bash
node addons/semantic-search/scripts/index.mjs               # incremental
node addons/semantic-search/scripts/index.mjs --full        # force a re-embed
node addons/semantic-search/scripts/index.mjs --vault other
```
