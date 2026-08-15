/* ------------------------------------------------------------------ *
 * "May this PR be merged?" — the PURE core (no IO), so it is unit-testable
 * (mirrors merged-check.mjs / shared-checkout.mjs).
 *
 * The merge route is a bare `gh pr merge <branch> --merge`: no fetch, no
 * rebase, no check state, no freshness test. Every OTHER ship path opens with a
 * fresh `git fetch origin` + rebase; this one revalidates nothing. Where branch
 * protection exists GitHub is the backstop, but on an UNPROTECTED repo it would
 * happily land a branch based on a month-old default branch — git-clean,
 * semantically wrong, and exactly the class of failure that breaks an ordered
 * migration chain.
 *
 * Two signals feed the verdict, and the second is the one that matters here:
 *  - `gh pr view --json state,mergeStateStatus,mergeable,statusCheckRollup` —
 *    GitHub's own view. Authoritative for conflicts/blocked/red checks.
 *  - a LOCAL freshness test (`fresh`, computed in agent-local.mjs) — because
 *    `mergeStateStatus` is only ever BEHIND when the repo REQUIRES branches to
 *    be up to date. An unprotected repo reports CLEAN for a branch built on a
 *    month-old base, so GitHub alone cannot answer the question this guard
 *    exists for.
 * ------------------------------------------------------------------ */

// A check that finished with one of these is not a failure (a skipped job is a
// normal outcome of a path filter, and NEUTRAL is explicitly "no opinion").
const CHECK_OK = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
// Still running / not started — transient, so "wait", never "fix".
const CHECK_PENDING = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED'])

/**
 * Roll `gh pr view --json statusCheckRollup` up to one word.
 *
 * The array mixes two node shapes: a CheckRun carries `status` (+ `conclusion`
 * once COMPLETED) and `name`; a legacy StatusContext carries `state` and
 * `context`. Read whichever is present rather than branching on `__typename`,
 * which `gh` does not always include.
 *
 * @param rollup the `statusCheckRollup` array (missing/empty → 'none')
 * @returns {{state: 'passing'|'failing'|'pending'|'none', failing: string[]}}
 */
export function rollupChecks(rollup) {
  const nodes = Array.isArray(rollup) ? rollup : []
  const failing = []
  let pending = false
  for (const n of nodes) {
    const running = n?.status && String(n.status).toUpperCase() !== 'COMPLETED'
    const v = String(running ? n.status : (n?.conclusion ?? n?.state ?? '')).toUpperCase()
    if (CHECK_OK.has(v)) continue
    if (CHECK_PENDING.has(v)) {
      pending = true
      continue
    }
    failing.push(n?.name || n?.context || v || 'check')
  }
  if (failing.length) return { state: 'failing', failing }
  if (pending) return { state: 'pending', failing }
  return { state: nodes.length ? 'passing' : 'none', failing }
}

const SHIP_INSTEAD =
  'Ship the agent (its ship protocol re-fetches, rebases and pushes) rather than merging from outside.'

const refuse = (state, error) => ({ ok: false, state, error })

/**
 * @param pr     parsed `gh pr view --json number,state,mergeStateStatus,mergeable,statusCheckRollup,baseRefName`,
 *               or null when there is no open PR for the branch
 * @param fresh  does the PR branch contain the CURRENT base tip? true / false /
 *               null when it could not be determined locally (never a refusal)
 * @param branch the agent's branch, for the no-PR message
 * @param tries  how many times mergeability was polled (for the UNKNOWN message)
 * @returns {{ok: true}|{ok: false, state: string, error: string}}
 *          `state` is a short machine-readable tag; `error` names the actual
 *          state and says what to do instead — "cannot merge" is not a
 *          diagnosis.
 */
export function preflightVerdict({ pr, fresh = null, branch = '', tries = 1 }) {
  if (!pr) {
    return refuse('no-pr', `no open PR for branch \`${branch}\` — nothing to merge. ${SHIP_INSTEAD}`)
  }
  const n = pr.number ? `PR #${pr.number}` : `the PR for \`${branch}\``
  const base = pr.baseRefName || 'its base branch'
  const state = String(pr.state || '').toUpperCase()
  if (state && state !== 'OPEN') {
    return refuse(
      state === 'MERGED' ? 'already-merged' : 'not-open',
      `${n} is ${state}, not OPEN — refusing to merge.` +
        (state === 'MERGED' ? ' It has already landed; nothing to do.' : ''),
    )
  }

  const ms = String(pr.mergeStateStatus || '').toUpperCase()
  // BEHIND first: it is the failure this guard exists for, and the local
  // freshness test is what catches it on a repo with no branch protection.
  if (ms === 'BEHIND' || fresh === false) {
    return refuse(
      'behind',
      `${n} is BEHIND ${base} — its branch does not contain the current ${base} tip, so merging it would land work never tested against ${base}. ${SHIP_INSTEAD}`,
    )
  }
  if (ms === 'DIRTY' || String(pr.mergeable || '').toUpperCase() === 'CONFLICTING') {
    return refuse('dirty', `${n} CONFLICTS with ${base} — refusing to merge. ${SHIP_INSTEAD}`)
  }

  const checks = rollupChecks(pr.statusCheckRollup)
  if (checks.state === 'failing') {
    return refuse(
      'checks-failing',
      `${n} is RED — failing checks: ${checks.failing.join(', ')}. ${SHIP_INSTEAD}`,
    )
  }
  if (checks.state === 'pending') {
    return refuse('checks-pending', `${n} still has PENDING checks — wait for them to finish, then merge.`)
  }
  if (ms === 'BLOCKED') {
    return refuse(
      'blocked',
      `${n} is BLOCKED by ${base}'s branch protection (a required review or check is missing) — resolve it on GitHub; refusing to merge.`,
    )
  }
  // Only after the retries in agent-local.mjs have run: GitHub still hasn't
  // computed mergeability, so nothing here is actually known.
  if (ms === 'UNKNOWN') {
    return refuse(
      'unknown',
      `GitHub is still computing mergeability for ${n} (mergeStateStatus UNKNOWN after ${tries} ${tries === 1 ? 'try' : 'tries'}) — that is transient; retry in a moment.`,
    )
  }
  return { ok: true }
}
