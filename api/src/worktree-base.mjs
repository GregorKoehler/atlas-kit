/* ------------------------------------------------------------------ *
 * Where a NEW dev-agent worktree starts: a freshly fetched origin default
 * branch, never whatever the shared checkout happens to have checked out.
 *
 * Why: both spawn paths ran `git worktree add -b <branch> <worktree>` with no
 * start point and no fetch, so a new agent branched from whatever the shared
 * checkout had — measured in the field, a checkout 50 commits behind origin
 * seeded every new agent with five-day-old code (each agent branch's reflog
 * said `branch: Created from HEAD`).
 *
 * Shared by api/src/agent-local.mjs (execFile on the box) and
 * agent-bridge/server.mjs (`docker exec` into the container): logic both
 * executors run lives in ONE module. Each passes its own
 * `exec(argv, { timeout })` → { ok, stdout, stderr }; argv only, never a shell.
 *
 * ⚠️ The shared checkout (`repo`) is never pulled, reset or fast-forwarded: it
 * serves live apps and other agents' worktrees hang off it. `git fetch` moves
 * only the remote-tracking refs; the new worktree is the only thing that
 * changes where it starts.
 * A failed fetch (offline, auth, timeout) never fails the spawn — the last
 * fetched origin ref is used, and only with no origin ref at all, HEAD. The
 * caller records `baseRef`/`baseSha`/`baseFetched` so a stale base is visible.
 * ------------------------------------------------------------------ */

// Well inside the box's 30 s wait on a bridge spawn (AGENT_BRIDGE_EXEC_TIMEOUT_MS).
export const BASE_FETCH_TIMEOUT_MS = 10_000

// The commit a ref names, or null when it does not resolve.
async function commitOf(repo, ref, exec) {
  const r = await exec(['git', '-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  const sha = r.ok ? r.stdout.trim() : ''
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null
}

// The start ref, in order: the per-repo `baseRef` override, origin/HEAD's
// target, origin/master, origin/main — the first that resolves — else HEAD.
export async function resolveBase(repo, exec, override) {
  const head = await exec(['git', '-C', repo, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
  const candidates = [override, head.ok && head.stdout.trim(), 'origin/master', 'origin/main']
  for (const ref of candidates) {
    if (!ref) continue
    const sha = await commitOf(repo, ref, exec)
    if (sha) return { baseRef: ref, baseSha: sha }
  }
  return { baseRef: 'HEAD', baseSha: await commitOf(repo, 'HEAD', exec) }
}

// fetch → resolve → `git worktree add --no-track -b <branch> <worktree> <base>`.
// --no-track: the branch must not inherit origin/master as its upstream (a bare
// `git push` would then target master). Returns the add's { ok, stderr } plus
// the base it used and whether the fetch succeeded (`fetchError` when not).
export async function addAgentWorktree({ repo, branch, worktree, baseRef, exec }) {
  const f = await exec(['git', '-C', repo, 'fetch', 'origin'], { timeout: BASE_FETCH_TIMEOUT_MS })
  const base = await resolveBase(repo, exec, baseRef)
  const wt = await exec(['git', '-C', repo, 'worktree', 'add', '--no-track', '-b', branch, worktree, base.baseRef])
  return {
    ok: wt.ok,
    stderr: wt.stderr,
    ...base,
    baseFetched: f.ok,
    ...(f.ok ? {} : { fetchError: (f.stderr || 'git fetch failed').trim().slice(0, 300) }),
  }
}
