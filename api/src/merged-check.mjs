/* ------------------------------------------------------------------ *
 * "Was this agent's PR merged?" — the PURE core (no IO), so it is
 * unit-testable (mirrors shared-checkout.mjs / atlas-ship-notify.mjs).
 *
 * `shipState` used to be derived ONLY from the agent's own transcript markers
 * (ATLAS:READY-TO-SHIP / ATLAS:SHIPPED). So a PR merged by anyone ELSE — the
 * Atlas orchestrator via `gh pr merge`, or the operator on github.com — never
 * reached the card: the session sat at `ready` forever and the operator could
 * not tell "waiting to be merged" from "merged 20 minutes ago".
 *
 * The repository knows the answer, so ask it instead of asking who typed what:
 * a branch is merged when the default branch contains a MERGE COMMIT whose
 * second parent is the branch tip. That is `gh pr merge --merge`'s shape (the
 * ship protocol's), and the merge commit's own SHA + `Merge pull request #N`
 * subject are exactly what the card wants to show.
 *
 * Why not `merge-base --is-ancestor <tip> origin/<default>` alone (cheaper, and
 * the obvious first idea): a FRESH agent branch with no commits of its own sits
 * exactly on the default branch's tip, so it is an ancestor too — every newly
 * spawned agent would be reported as merged the moment the default branch moved
 * on. The merge-commit test can't confuse the two, and is the same single git
 * call. The ancestry test is implied by it: a commit in the default branch
 * having the tip as a parent IS the tip being an ancestor.
 *
 * Cost: a squash- or rebase-merged PR leaves no merge commit, so it is NOT
 * detected here and the session keeps falling back to its own marker.
 * ------------------------------------------------------------------ */

/** The `git log` we parse. Range + refs are the caller's (agent-local.mjs). */
export const MERGE_LOG_FORMAT = '--format=%H|%P|%s'

/**
 * @param tip   the branch tip SHA (full, as `git rev-parse` prints it)
 * @param out   stdout of `git log --ancestry-path --merges --format=%H|%P|%s <tip>..<defaultRef>`
 *              — newest first, one `<sha>|<parents>|<subject>` line per merge
 *              commit in the default branch that descends from the tip.
 * @returns {{tip: string, sha: string, pr: number|null}|null}
 *          the merge that landed this branch, or null when nothing did
 */
export function mergedVerdict(tip, out) {
  if (!tip) return null
  const lines = String(out || '').split('\n')
  // Oldest first: if the branch were somehow merged twice, the FIRST merge is
  // the one that landed it.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    const a = line.indexOf('|')
    const b = line.indexOf('|', a + 1)
    if (a < 0 || b < 0) continue
    const parents = line.slice(a + 1, b).split(' ').filter(Boolean)
    // Parent 1 is the default branch itself; the branch we merged is any other.
    if (!parents.slice(1).includes(tip)) continue
    const pr = /#(\d+)/.exec(line.slice(b + 1))
    return { tip, sha: line.slice(0, a), pr: pr ? Number(pr[1]) : null }
  }
  return null
}

/**
 * The same verdict for a repo the box has NO checkout of (every bridge repo):
 * GitHub's own answer, from `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}
 * &state=closed`. Merged-ness is `merged_at`, NEVER `state` — a closed PR is
 * usually one that was rejected. The PR record outlives the branch, so this
 * survives cleanup_agent's delete like the persisted local verdict does.
 *
 * @param pulls  the parsed JSON array (anything else → null: no verdict)
 * @returns {{sha: string, pr: number|null}|null}
 */
export function mergedFromPulls(pulls) {
  if (!Array.isArray(pulls)) return null
  const merged = pulls.filter((p) => p && p.merged_at && p.merge_commit_sha)
  if (!merged.length) return null
  // Oldest merge first — the one that actually landed this branch.
  merged.sort((a, b) => String(a.merged_at).localeCompare(String(b.merged_at)))
  return { sha: String(merged[0].merge_commit_sha), pr: Number(merged[0].number) || null }
}

/** The one-line detail the card / MCP feed shows for a merged session. */
export function mergedInfo(v) {
  if (!v || !v.sha) return ''
  return `${v.pr ? `PR #${v.pr} ` : ''}merged as ${v.sha.slice(0, 7)}`
}
