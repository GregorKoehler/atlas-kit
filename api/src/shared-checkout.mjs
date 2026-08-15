/* ------------------------------------------------------------------ *
 * Ship-time shared-checkout guard — the PURE core (no IO), so it is
 * unit-testable (mirrors merged-check.mjs / merge-preflight.mjs).
 *
 * A dev agent works in its own `git worktree`, but agents repeatedly slip into
 * the repo's SHARED checkout instead — the path the live services are served
 * from, which the repo's own docs and CLAUDE.md name by ABSOLUTE path for
 * deploy steps. That checkout is shared state: an uncaught slip can strand
 * another agent's in-flight work. So when an agent declares itself
 * READY-TO-SHIP, the executor takes ONE `git -C <sharedCheckout> status
 * --porcelain -b` snapshot and this turns it into a warning. The path is always
 * the CALLER's (the repo allowlist's `path` for that session) — nothing here
 * knows or assumes any particular directory.
 *
 * WARN ONLY. It never blocks a ship, never cleans, never resets anything — a
 * dirty shared checkout is just as likely to be the operator's own work in
 * progress.
 *
 * Two states are deliberately NOT flagged on their own, because a served
 * checkout is in both of them almost permanently and a guard that always fires
 * is a guard nobody reads:
 *   - *behind* its upstream — the normal state between a merge and the next
 *     deploy pull.
 *   - *untracked* files only — build/log cruft accumulates next to a running
 *     service.
 * The slip we're after shows up as MODIFIED tracked files, unpushed local
 * commits, or a stray branch/detached HEAD. Untracked files are still reported
 * as context once one of those has already fired.
 * ------------------------------------------------------------------ */

/**
 * @param repoPath  the shared checkout's path (from the repo config — never hardcoded)
 * @param res       the `git status --porcelain -b` result, in run()'s shape:
 *                  { ok: boolean, stdout: string }. `ok: false` (path missing,
 *                  not a repo, git failed) → null: nothing we can honestly say.
 * @returns a one-line operator-facing warning, or null when it looks fine
 */
export function sharedCheckoutWarning(repoPath, res) {
  if (!res || !res.ok) return null
  const lines = String(res.stdout || '')
    .split('\n')
    .filter((l) => l.trim())
  const issues = []

  const changed = lines.filter((l) => !l.startsWith('## ') && !l.startsWith('??')).length
  const untracked = lines.filter((l) => l.startsWith('??')).length
  if (changed) issues.push(`${changed} uncommitted change${changed === 1 ? '' : 's'}`)

  // `## <branch>[...<upstream>][ [ahead N, behind M]]`, or `## HEAD (no branch)`.
  const head = (lines.find((l) => l.startsWith('## ')) || '').slice(3).trim()
  if (head === 'HEAD (no branch)') {
    issues.push('detached HEAD')
  } else if (head) {
    const br = head.indexOf(' [')
    const tracking = br === -1 ? head : head.slice(0, br)
    const divergence = br === -1 ? '' : head.slice(br + 2, -1)
    const sep = tracking.indexOf('...')
    const branch = sep === -1 ? tracking : tracking.slice(0, sep)
    const upstream = sep === -1 ? '' : tracking.slice(sep + 3)
    const ahead = /ahead (\d+)/.exec(divergence)
    if (!upstream) issues.push(`on \`${branch}\`, which tracks nothing`)
    else if (ahead)
      issues.push(`${ahead[1]} local commit${ahead[1] === '1' ? '' : 's'} on \`${branch}\` not in ${upstream}`)
  }

  if (!issues.length) return null
  if (untracked) issues.push(`${untracked} untracked file${untracked === 1 ? '' : 's'}`)
  return `⚠️ The shared checkout at ${repoPath} is not clean at its upstream (${issues.join('; ')}). If that is your own work in progress, ignore this — otherwise check whether this agent worked there instead of in its worktree.`
}
