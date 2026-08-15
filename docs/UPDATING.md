# Updating an Atlas Kit install

Two paths to move a running box onto newer kit code: the **Redeploy button** on the kit's
own project card (one click, the normal case) and the **manual path** (a first update from
the template repo, a box without the card, or a redeploy that refused).

Both do the same four things — fetch, fast-forward, install/build only what changed,
restart — and both refuse rather than force: a dirty checkout or a non-fast-forward is a
stop, never a `--force` or a stash.

---

## The one-click path — the Redeploy button

The kit's card (`Wiki/Projects/Atlas-Kit.md`, seeded at setup — see
[SETUP.md](SETUP.md) step 8) carries:

```yaml
self_deploy: true
repo_path: /workspace        # wherever you cloned the kit
```

That pair puts a **Redeploy** button on the card. Any project page on this box can opt in
the same way; nothing about it is kit-specific.

Pressing it runs, on that checkout:

1. `git fetch origin` (retried — a box-local agent's worktree can hold the ref lock),
2. `git merge --ff-only origin/<default branch>`,
3. `npm ci` in `api/` and `web/` **only** if that package's `package-lock.json` changed
   across the merge (falling back to `npm install` if the lockfile drifted),
4. `npm run build` in `web/`,
5. `scripts/serve.sh restart`.

The button then shows `Deploying…` through the restart blip and settles on
`Redeployed ✓ <sha>`, or on the refusal.

**Running agents come back on their own.** `serve.sh restart` is session-scoped, so agent
tmux sessions usually survive it untouched; and when a restart *does* orphan them (a
reboot, an OOM that took the tmux server with it), the API's boot self-heal parks them and
then re-attaches the newest few — capped (`AGENT_LOCAL_REATTACH_MAX`, default 4, and never
past the concurrency ceiling), staggered, and gated on the same memory floor the Revive
button uses. Whatever doesn't fit stays `dormant` on its card with that button as the
fallback, so a low-RAM box degrades instead of OOM-spiralling. Set
`AGENT_LOCAL_REATTACH=0` to go back to parking everything for a manual revive (or
`AGENT_LOCAL_RECONCILE=0` to switch the self-heal off entirely).

**It survives the restart it triggers.** Step 5 kills the very Express process that
started the deploy, so the run is launched into a transient **`systemd-run`** unit — its
own unit and cgroup, outside the API's lifecycle. On a box without systemd (a container)
or an unprivileged run, it falls back to a **detached `setsid` child**, which likewise
outlives both the API process and the tmux window it was born in. The POST's response says
which launcher ran.

Because the API is gone mid-run, progress comes back through a **state file**
(`/tmp/atlas-kit-deploy-<project>.json`, or `ATLAS_DEPLOY_STATE_DIR`) that the run
rewrites at each phase. `GET /api/deploy/status` re-reads it once the API is back, which is
how a failure that happened while nothing was listening still reaches the card.

### When it refuses

| Reason on the card | What happened | Fix |
| --- | --- | --- |
| `uncommitted changes` | tracked files are modified in the checkout | commit or discard them (`git -C <repo> status`) |
| `not a fast-forward` | the checkout has local commits `origin` doesn't | rebase/reset it by hand, then redeploy |
| `a redeploy is already in progress` | one is running (single-flight) | wait; a run stuck for >15 min goes stale and unblocks |
| `npm install failed in …` / `the web build failed` | deps or build broke | fix it, then redeploy — **the running dashboard was left untouched** |
| `serve.sh restart failed` | the new build is in place but services didn't come back | check `/tmp/atlas-kit-express.log`; the `serve.sh ensure` watchdog retries every 2 min |

Full log of the last run: `/tmp/atlas-kit-deploy-<project>.log`.

The button is **bearer-gated** (`POST /api/deploy`), so Caddy has to inject the token —
`infra/Caddyfile.example` does this for `/api/deploy*`. If your `infra/Caddyfile` predates
that, copy the block over, or the button will 401.

---

## The manual path

Same steps, by hand — and the only path when there is no card yet, or when the merge needs
a decision:

```bash
cd /workspace                      # your kit checkout
git status                         # must be clean; commit/stash your own changes first
git fetch origin
git merge --ff-only origin/main    # refuses on divergence — never force
cd web && npm ci && npm run build && cd ..   # npm ci only if web/package-lock.json moved
cd api && npm ci && cd ..                    # …likewise for api/
scripts/serve.sh restart
curl -fsS http://127.0.0.1:8080/api/health   # {"ok":true,…}
```

### First update from the template repo

If you created your repo with **Use this template** on GitHub (or `gh repo create --template`),
your history and the kit's are unrelated — a plain `git pull` fails with
*"refusing to merge unrelated histories"*. Wire the kit up as a second remote and take that
one merge explicitly:

```bash
git remote add upstream https://github.com/GregorKoehler/atlas-kit.git
git fetch upstream
git merge upstream/main --allow-unrelated-histories   # ONLY needed the first time
# resolve any conflicts (your .env is gitignored, so nothing secret is in play), commit
```

Every later update is a normal `git merge upstream/main` — the histories are joined now.
⚠️ `--allow-unrelated-histories` is a first-merge-only tool: reaching for it again means
something else is wrong (wrong remote, wrong branch).

If you cloned the kit directly (`gh repo clone`), none of this applies — `origin` is the
kit and the one-click path works as-is.

### After updating

- **Addons.** Re-run the `install.sh` of every addon you enabled — a release can add a
  dependency or a cron line: `bash addons/<name>/install.sh` (idempotent; `--check`
  reports state without installing). Then confirm what actually loaded:
  ```bash
  curl -s http://127.0.0.1:8080/api/addons     # each enabled addon, its hooks, its errors
  ```
  An addon that failed to load is *recorded there and skipped* — the API comes up
  regardless, so a working dashboard is no evidence that an addon loaded.
- **The workstation bridge** updates separately, on the workstation:
  `sudo scripts/restart-agent-bridge.sh` (or the dashboard's "Redeploy bridge" button).
- **Config templates.** `infra/Caddyfile.example`, `infra/atlas-kit.cron` and
  `.env.example` are updated in place by a release; your copies (`infra/Caddyfile`,
  `/etc/cron.d/atlas-kit`, `.env`) are yours and are never touched. Diff them against the
  examples after an update that mentions them.
- **The vault is a separate repo** and is never touched by a kit update.
