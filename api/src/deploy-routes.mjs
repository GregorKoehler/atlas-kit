/* ------------------------------------------------------------------ *
 * Redeploy — a project card taking its own checkout live from the dashboard.
 *
 * A project page that opts in with `self_deploy: true` + `repo_path: <abs>`
 * (read-routes.mjs's listProjects → `selfDeploy` + `repo`) gets a Redeploy
 * button on its card. The action is FIXED and parameterless — never arbitrary
 * exec, and never a path from the client: the repo path comes from the vault
 * page, the button only names the project.
 *
 *   fetch origin → merge --ff-only origin/<default> → npm ci in api/ and web/
 *   ONLY when their lockfiles changed → npm run build in web/ → serve.sh restart
 *
 * It REFUSES rather than force anything: a dirty checkout, a merge that is not a
 * fast-forward, or a redeploy already in flight all come back with the reason.
 *
 * Two subtleties, both load-bearing:
 *
 *  - `serve.sh restart` kills THIS Express process, so the deploy CANNOT run as
 *    a child of the request. It is launched into a transient `systemd-run` unit
 *    — its own unit/cgroup, outside this process's lifecycle — exactly like the
 *    bridge's own redeploy (agent-bridge/redeploy.mjs), which is where that
 *    lesson was learned. When systemd-run is unavailable (a container without
 *    systemd, or an unprivileged run) we fall back to a DETACHED child
 *    (`spawn(detached:true)` = setsid: new session, so tmux respawning the
 *    `express` window can't take it with it). The response says which ran.
 *
 *  - The POST returns the instant the deploy is launched, and the restart drops
 *    every in-memory trace of it. So the run's only channel back is a STATE FILE
 *    it rewrites at each phase (buildDeployScript's `state`), which
 *    GET /api/deploy/status reads after the API comes back up.
 * ------------------------------------------------------------------ */
import express from 'express'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { listProjects } from './read-routes.mjs'
import { resolveDefaultBranch } from './ship-prompt.mjs'

const execFileAsync = promisify(execFile)
const HOME = process.env.HOME || '/root'
// Where the per-project state/log files live. /tmp by default: a state file is a
// progress breadcrumb, not a record — losing it on reboot just means "no deploy
// known", which is exactly true after a reboot.
const STATE_DIR = process.env.ATLAS_DEPLOY_STATE_DIR || os.tmpdir()
// A deploy still claiming `deploying` after this long is treated as dead (the
// box rebooted mid-run, the unit was killed) so a wedged state file can't block
// redeploys forever. Same guard as the bridge's redeploy.
const STALE_MS = Number(process.env.ATLAS_DEPLOY_STALE_MS || 15 * 60 * 1000)

/** Project name → a filesystem/unit-safe stem. Exported for the tests. */
export function deploySlug(name) {
  return (
    String(name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  )
}

const stateFile = (name) => path.join(STATE_DIR, `atlas-kit-deploy-${deploySlug(name)}.json`)
const logFile = (name) => path.join(STATE_DIR, `atlas-kit-deploy-${deploySlug(name)}.log`)
const unitName = (name) => `atlas-kit-deploy-${deploySlug(name)}`

/* --- target resolution (pure over a projects list, so it is testable) ------ */

/** The cards that opted in: `self_deploy: true` AND a `repo_path` to run in.
 *  `self_deploy` alone is only a delivery-mode flag (ship-prompt.mjs) — without
 *  a checkout on this box there is nothing to redeploy. */
export function deployTargets(projects) {
  return projects.filter((p) => p.selfDeploy && p.repo).map((p) => ({ name: p.name, repoPath: p.repo }))
}

/** Resolve the project to act on → { target } or { status, error }. With no
 *  name and exactly one opted-in card (the normal kit install: itself) that card
 *  is the target; with several, the caller must name one rather than have us
 *  guess which app to restart. */
export function pickTarget(projects, name) {
  const targets = deployTargets(projects)
  if (name) {
    const hit = targets.find((t) => t.name === name)
    if (hit) return { target: hit }
    return {
      status: 404,
      error: `no redeploy configured for "${name}" — its page needs self_deploy: true and repo_path: <path on this box>`,
    }
  }
  if (targets.length === 1) return { target: targets[0] }
  if (!targets.length)
    return { status: 404, error: 'no project page carries self_deploy: true + repo_path:' }
  return {
    status: 400,
    error: `several projects are self-deploy (${targets.map((t) => t.name).join(', ')}) — name one with ?project=`,
  }
}

/** Why this `repo_path` may not be run, or null. The value comes from a vault
 *  page — operator-written, but the vault is a file tree several writers touch,
 *  and the path is INTERPOLATED INTO A SHELL SCRIPT below. Reads are safe either
 *  way (execFile, no shell), so only the launch checks this. */
export function repoPathProblem(repoPath) {
  if (!path.isAbsolute(repoPath)) return 'repo_path must be an absolute path on this box'
  if (/["'`$\\\n\r]/.test(repoPath)) return 'repo_path contains characters that cannot be used in a shell command'
  return null
}

/* --- deploy state --------------------------------------------------------- */

/** The last known state of this project's deploy, or null (never deployed, or
 *  the file was wiped). Garbage parses as null — benign, same as absent. */
export function readDeployState(name) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(name), 'utf-8'))
  } catch {
    return null
  }
}

function writeDeployState(name, state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(stateFile(name), JSON.stringify(state) + '\n')
  } catch (e) {
    console.error(`deploy: could not write the state file for ${name}: ${e?.message || e}`)
  }
}

/** Claim the single-flight slot BEFORE launching. The script writes its own
 *  `deploying` line too, but only once it is actually running — without this
 *  claim two POSTs a moment apart both read "not running" and both launch (the
 *  systemd unit-name collision catches that; the detached fallback would not). */
export function claimDeploying(name, now = new Date()) {
  writeDeployState(name, { phase: 'deploying', step: 'start', reason: 'starting', targetSha: '', at: now.toISOString() })
}

/** Release it again when the launch itself failed — otherwise the claim above
 *  would read as a live deploy until it goes stale, blocking every retry. */
export function recordLaunchFailure(name, reason, now = new Date()) {
  writeDeployState(name, { phase: 'error', step: 'launch', reason, targetSha: '', at: now.toISOString() })
}

/** Is a deploy still running? `deploying` newer than STALE_MS. Pure (takes
 *  `now`) so the staleness window is testable without waiting for it. */
export function isInFlight(state, now = Date.now()) {
  if (!state || state.phase !== 'deploying') return false
  const at = Date.parse(state.at || '')
  if (!Number.isFinite(at)) return true // no timestamp → assume live, refuse
  return now - at < STALE_MS
}

/* --- git ------------------------------------------------------------------ */

async function git(repoPath, args) {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, '-c', `safe.directory=${repoPath}`, ...args], {
    encoding: 'utf-8',
    timeout: 15000,
    env: { ...process.env, HOME },
  })
  return stdout.trim()
}

/**
 * What the checkout looks like right now — WITHOUT touching the network: sha,
 * branch, dirtiness, and how far behind its upstream ref it is. No `git fetch`
 * here on purpose: this is polled by every open dashboard, and the remote is
 * only authoritative at deploy time (the deploy script fetches first). So
 * `behind` reads "commits known to be pending", never "0 = definitely live".
 */
export async function repoState(repoPath) {
  const out = { sha: '', branch: '', dirty: false, behind: 0 }
  try {
    out.sha = await git(repoPath, ['rev-parse', '--short', 'HEAD'])
    out.branch = await git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    // Tracked changes only: web/dist, .env and friends are gitignored/untracked
    // and must not read as "dirty" (they are present on every live box).
    out.dirty = (await git(repoPath, ['status', '--porcelain', '--untracked-files=no'])) !== ''
    // Against the branch's own upstream, so the poll needs neither the network
    // nor a default-branch lookup; no upstream configured → 0 (nothing known).
    const n = await git(repoPath, ['rev-list', '--count', 'HEAD..@{upstream}']).catch(() => '0')
    out.behind = Number(n) || 0
  } catch (e) {
    out.error = String(e?.stderr || e?.message || e)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200)
  }
  return out
}

/* --- the deploy script ---------------------------------------------------- */

/**
 * The bash the transient unit runs: refuse-or-pull → (deps if a lockfile
 * changed) → build → restart, rewriting the state file at every transition.
 *
 * Exported so the whole decision surface — the dirty/non-ff refusals, the
 * lockfile-change detection, and "a failure NEVER restarts" — is exercised
 * against a throwaway git repo in api/test/deploy-script.test.mjs, with no
 * systemd, no network and no live box.
 *
 * Why the state file carries the failures: the ff-only merge advances HEAD
 * BEFORE the build, so after a failed build `behind` reads 0 and the deploy
 * would LOOK green. The `state error …` markers are what make it fail visibly.
 */
export function buildDeployScript({ repoPath, branch, deployLog, state }) {
  return [
    `exec >>"${deployLog}" 2>&1`,
    `echo "=== redeploy $(date -u +%FT%TZ) ==="`,
    `STATE="${state}"`,
    `target=""`,
    // $3 (reason) is the human sentence the card shows; $2 (step) stays a short
    // machine token. Neither may contain a quote/backslash — all call sites below
    // are literals, so the JSON stays well-formed without an escaper in bash.
    `state(){ printf '{"phase":"%s","step":"%s","reason":"%s","targetSha":"%s","at":"%s"}\\n' "$1" "$2" "$3" "$target" "$(date -u +%FT%TZ)" > "$STATE"; }`,
    // Claim in-flight up front: it is both the progress signal and the
    // single-flight marker a concurrent POST refuses on.
    `state deploying start starting`,
    `cd "${repoPath}" || { state error workspace "repo path is not readable"; exit 1; }`,
    // Refuse a dirty checkout rather than stash/force someone's work away. The
    // POST pre-checks this too; this is the race-free one (it runs at merge time).
    `git diff --quiet HEAD || { echo "checkout has uncommitted changes — refusing"; state error dirty "the checkout has uncommitted changes — commit or discard them first"; exit 1; }`,
    // A box-local dev agent shares this repo's .git (git worktrees), and its own
    // `git fetch` can briefly hold the origin ref lock — a naive single attempt
    // aborts on that transient clash. Retry, then ff-only merge; any failure
    // exits BEFORE the build and the restart.
    `ok=0; for i in 1 2 3 4 5; do git fetch --quiet origin ${branch} && { ok=1; break; }; echo "fetch $i failed (ref lock?), retry in 2s"; sleep 2; done`,
    `[ "$ok" = 1 ] || { echo "fetch failed after retries — aborting"; state error fetch "could not fetch origin"; exit 1; }`,
    `before=$(git rev-parse HEAD)`,
    `git merge --ff-only origin/${branch} || { echo "not a fast-forward — aborting (no build/restart)"; state error merge "the checkout has diverged from origin/${branch} — not a fast-forward, so nothing was merged"; exit 1; }`,
    `target=$(git rev-parse --short HEAD)`,
    `echo "HEAD $before -> $(git rev-parse HEAD)"`,
    // Install deps only when a lockfile actually changed across the merge — the
    // common no-dep redeploy stays fast. npm ci is lockfile-reproducible; fall
    // back to npm install when the lockfile drifted from package.json.
    `state deploying deps "installing dependencies"`,
    `for pkg in web api; do`,
    `  if [ -f "${repoPath}/$pkg/package-lock.json" ] && ! git diff --quiet "$before" HEAD -- "$pkg/package-lock.json"; then`,
    `    echo "$pkg/package-lock.json changed — installing deps (npm ci)"`,
    `    ( cd "${repoPath}/$pkg" && { npm ci || npm install; } ) || { echo "$pkg dep install failed — aborting (no build/restart)"; state error deps "npm install failed in $pkg/"; exit 1; }`,
    `  fi`,
    `done`,
    `state deploying build "building the dashboard"`,
    `( cd "${repoPath}/web" && npm run build ) || { echo "build failed — aborting (no restart)"; state error build "the web build failed — the running dashboard was left untouched"; exit 1; }`,
    `state deploying restart "restarting services"`,
    `"${repoPath}/scripts/serve.sh" restart || { echo "serve.sh restart failed"; state error restart "serve.sh restart failed"; exit 1; }`,
    `state done ok "restarted"`,
  ].join('\n')
}

/* --- launching it outside our own lifecycle ------------------------------- */

// POSIX single-quote escaping — safe to embed in a `bash -lc` string.
function shquote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/** The systemd-run argv for the transient unit. `--collect` unloads it on exit
 *  so the fixed unit name is free for the next redeploy; `--no-block` returns as
 *  soon as the unit starts (we never wait for a script that restarts us). */
export function buildDeploySystemdRunArgs({ unit, script, cwd }) {
  return [
    '--collect',
    `--unit=${unit}`,
    '--property=Type=oneshot',
    '--no-block',
    `--working-directory=${cwd}`,
    '--',
    'bash',
    '-lc',
    script,
  ]
}

// systemd-run fails synchronously (even under --no-block) when a unit of the
// same fixed name is still loaded — that is a redeploy already running, not a
// broken systemd, so it must NOT fall through to the detached fallback (which
// would start a second one). Mirrors agent-bridge/redeploy.mjs's check.
export function isUnitCollisionError(e) {
  return /already (loaded|exists|active)/i.test(String(e?.stderr || e?.message || ''))
}

/** Launch the deploy so it survives the restart it triggers. Returns
 *  { launcher } on success, { error, status } on refusal/failure. */
export function launchDeploy({ name, script, repoPath }) {
  const unit = unitName(name)
  try {
    execFileSync('systemd-run', buildDeploySystemdRunArgs({ unit, script, cwd: repoPath }), {
      stdio: 'pipe',
      encoding: 'utf-8',
    })
    return { launcher: 'systemd-run', unit }
  } catch (e) {
    if (isUnitCollisionError(e)) return { status: 409, error: 'a redeploy is already running (unit active)' }
    // No systemd (a container), or an unprivileged run: fall back to a detached
    // child. `detached: true` = setsid, so it gets its own session and process
    // group and outlives both this process and the tmux window it was born in.
    try {
      spawn('bash', ['-lc', script], { detached: true, stdio: 'ignore', env: { ...process.env, HOME } }).unref()
      return { launcher: 'setsid' }
    } catch (e2) {
      return { status: 500, error: `could not launch the redeploy: ${String(e2?.message || e2)}` }
    }
  }
}

/* --- routes --------------------------------------------------------------- */

export function deployRouter(bearerAuth) {
  const r = express.Router()

  // Open read (Access gates it at the edge, like the other GETs): what the
  // card renders after the restart — "deploying → restarted at <sha>", or the
  // refusal the last run wrote.
  r.get('/api/deploy/status', async (req, res) => {
    const picked = pickTarget(listProjects(), req.query.project)
    if (picked.error) return res.status(picked.status).json({ ok: false, error: picked.error })
    const { name, repoPath } = picked.target
    const lastDeploy = readDeployState(name)
    res.json({
      ok: true,
      project: name,
      repoPath,
      ...(await repoState(repoPath)),
      lastDeploy,
      // The running artifact does NOT match HEAD when the last deploy died after
      // the merge — so a failure must be reported even though `behind` is 0.
      deployError: lastDeploy?.phase === 'error' ? lastDeploy.reason || lastDeploy.step || 'error' : null,
      running: isInFlight(lastDeploy),
    })
  })

  // Bearer-gated, single-flight. Returns the moment the deploy is launched —
  // everything after that is reported through /api/deploy/status.
  r.post('/api/deploy', bearerAuth, async (req, res) => {
    const picked = pickTarget(listProjects(), req.body?.project || req.query.project)
    if (picked.error) return res.status(picked.status).json({ ok: false, error: picked.error })
    const { name, repoPath } = picked.target
    const bad = repoPathProblem(repoPath)
    if (bad) return res.status(400).json({ ok: false, error: `${name}: ${bad}` })
    if (isInFlight(readDeployState(name)))
      return res.status(409).json({ ok: false, error: 'a redeploy is already in progress' })
    const state = await repoState(repoPath)
    if (state.error) return res.status(400).json({ ok: false, error: `cannot read ${repoPath}: ${state.error}` })
    // Refuse here as well as in the script: the operator gets the reason
    // synchronously instead of having to poll for it.
    if (state.dirty)
      return res
        .status(409)
        .json({ ok: false, error: `${repoPath} has uncommitted changes — commit or discard them first` })
    // Only the merge target needs the repo's real default branch (cached an hour
    // in ship-prompt.mjs), so this stays off the status-poll path.
    const branch = await resolveDefaultBranch({ repoPath })
    const script = buildDeployScript({
      repoPath,
      branch,
      deployLog: logFile(name),
      state: stateFile(name),
    })
    claimDeploying(name)
    const launched = launchDeploy({ name, script, repoPath })
    if (launched.error) {
      // A collision means a run IS live, so the claim above stays true; anything
      // else never started, and must not leave the slot held.
      if (launched.status !== 409) recordLaunchFailure(name, launched.error)
      return res.status(launched.status).json({ ok: false, error: launched.error })
    }
    res.json({ ok: true, started: true, project: name, launcher: launched.launcher })
  })

  return r
}
