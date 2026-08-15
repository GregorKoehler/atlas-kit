/* ------------------------------------------------------------------ *
 * The ONE ship instruction — how a project actually goes live, and the exact
 * words an agent is given when it is asked to ship.
 *
 * ⚠️ This wording exists exactly ONCE in the codebase, deliberately. It used to
 * live client-side (web/src/components/cards/AgentList.tsx), where only the Ship
 * BUTTONS could reach it: an agent merely TOLD to ship — an orchestrator's
 * `queue_agent`, the operator typing "ship it" — fell back to a weaker spawn-time
 * protocol that never mentioned waiting for the required checks, never deferred
 * to the repo's own rules and carried no delivery tail. Both paths now build from
 * `buildShipPrompt()` here: the spawn preamble via `shipProtocolSection()`
 * (agent-routes.mjs `reconcilePreamble`), the ship route verbatim. Nothing
 * client-side builds a ship prompt any more — the cards keep only the mode and
 * its tooltip note. api/test/ship-prompt.test.mjs pins that the two are the same
 * string; if that test ever needs loosening, the design has drifted back to two
 * sources of truth.
 *
 * It deliberately does NOT restate any repo's merge protocol. Branch protection
 * differs per repo (required checks, up-to-date-before-merging, migration
 * rules), those rules already live in the repo's own CLAUDE.md / .claude/rules,
 * and a copy here would drift. So it defers to them and only insists on the one
 * thing a dashboard-side prompt must not get wrong: a clean rebase is not the
 * same as a mergeable PR.
 * ------------------------------------------------------------------ */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** How a project actually goes live, DERIVED from its project page's frontmatter
 *  (read-routes.mjs `listProjects`) — never configured a second time here, and
 *  never a per-repo table:
 *    self-deploy: `self_deploy: true` — the operator takes the merge live from
 *                 the dashboard's own deploy action.
 *    manual:      `deploy_manual: <note>` — the live instance is redeployed by
 *                 hand, selectively and deliberately NOT per PR. merged ≠ delivered.
 *    merge:       merging IS the delivery (the default). */
export function deliveryMode(p) {
  if (p?.selfDeploy) return 'self-deploy'
  if (p?.deployManual) return 'manual'
  return 'merge'
}

// The delivery sentence appended to the ship prompt. Every branch ends at the
// same place: deploying is the OPERATOR's move, never the agent's.
const TAIL = {
  'self-deploy': 'Do not build or restart anything — I deploy from the dashboard.',
  manual:
    'Merging is NOT the delivery here: this project only goes live when its live instance is redeployed, that redeploy is mine to trigger, and it is deliberately NOT run for every PR (deploys are selective so live usage is not disturbed). So do not build, deploy, restart, or dispatch anything yourself — just note in your reply that the merge still needs a deploy run.',
  merge: "Merging the PR is the delivery — there's no separate deploy run, so don't build, deploy, or restart anything.",
}

/** The `{defaultBranch}` substitution token — what a prompt carries when the
 *  branch is only resolved later (the spawn preamble is assembled before the
 *  executor launches). Same convention as `{worktree}`/`{statsFile}`. */
export const DEFAULT_BRANCH_TOKEN = '{defaultBranch}'

/**
 * The ship prompt, delivered verbatim into the serial ship train by
 * POST /api/agents/ship and quoted verbatim into every dev agent's spawn
 * preamble. The re-sync is restated even though the agent synced before: with
 * parallel agents, the default branch moves between an agent's last rebase and
 * its merge.
 *
 * `branch` is the repo's REAL default branch (resolveDefaultBranch below) — a
 * hardcoded `master` is simply wrong for a `main` repo, which is most of them.
 */
export function buildShipPrompt(mode, branch = DEFAULT_BRANCH_TOKEN) {
  return (
    `Ship now: 1) re-run your sync protocol against a fresh git fetch origin — rebase onto origin/${branch} and push --force-with-lease — even if you synced earlier (origin/${branch} may have moved); 2) open or update your PR; 3) follow YOUR repo's own ship / CI / migration rules (its CLAUDE.md and .claude/rules — they win over this message) and wait for the required checks to go green on the commit you just pushed: a clean rebase alone does not make a PR mergeable; 4) once it genuinely is, merge it with gh pr merge --merge, report the PR number + merged SHA, and end that reply with a line that is exactly "ATLAS:SHIPPED PR #<number> <merged SHA>" (alone on its own line — the dashboard watches for it). If anything is risky or conflicted, or a required check is red or still pending: STOP, do not merge, and summarize it for me. ` +
    (TAIL[mode] || TAIL.merge)
  )
}

/** The spawn preamble's "Ship protocol" section — the SAME instruction, framed
 *  as a standing rule so an agent that is told to ship follows it to the letter
 *  instead of improvising. The instruction itself is appended unchanged; that
 *  is the invariant the test pins. */
export function shipProtocolSection(mode, branch = DEFAULT_BRANCH_TOKEN) {
  return `Ship protocol — when asked to "ship", "merge", "deploy", or "go live", by the dashboard's Ship button, an orchestrator, or the operator, these are your instructions whoever asks, verbatim:
${buildShipPrompt(mode, branch)}`
}

/* --- the repo's real default branch ------------------------------- *
 * Resolved from the repo itself, never assumed: the local checkout's
 * `origin/HEAD` first, then GitHub (for a repo that lives on another machine —
 * a bridge agent's repo isn't checked out here), then `main` so nothing breaks
 * if both fail. Cached per repo: this runs on every spawn and every ship, and a
 * default branch changes about once a decade. */
const BRANCH_TTL_MS = Number(process.env.AGENT_DEFAULT_BRANCH_TTL_MS || 60 * 60 * 1000)
const BRANCH_TIMEOUT_MS = Number(process.env.AGENT_DEFAULT_BRANCH_TIMEOUT_MS || 8000)
export const FALLBACK_BRANCH = 'main'
const branchCache = new Map() // cache key -> { branch, at }

async function exec(cmd, args, opts) {
  const { stdout } = await execFileAsync(cmd, args, { timeout: BRANCH_TIMEOUT_MS, ...opts })
  return String(stdout).trim()
}

export async function resolveDefaultBranch({ repoPath, ghRepo } = {}) {
  const key = repoPath || (ghRepo ? `${ghRepo.owner}/${ghRepo.repo}` : '')
  if (!key) return FALLBACK_BRANCH
  const hit = branchCache.get(key)
  if (hit && Date.now() - hit.at < BRANCH_TTL_MS) return hit.branch
  let branch = ''
  if (repoPath) {
    try {
      // "origin/main" -> "main"; a checkout with no origin/HEAD ref just fails.
      const ref = await exec('git', ['-C', repoPath, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
      if (ref.startsWith('origin/')) branch = ref.slice('origin/'.length)
    } catch {
      /* not a checkout here / no remote HEAD → ask GitHub */
    }
  }
  // ⚠️ Asked WITHOUT a slug when we have a checkout: `gh repo view` resolves the
  // repo from its own origin remote, which is the only thing that saves a
  // box-local repo with no project page and no `origin/HEAD` ref — the common
  // shape of a plain `git clone`, which would otherwise be told to rebase onto a
  // branch it does not have.
  if (!branch && (repoPath || ghRepo)) {
    try {
      branch = await exec(
        'gh',
        ['repo', 'view', ...(ghRepo ? [`${ghRepo.owner}/${ghRepo.repo}`] : []), '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'],
        ghRepo ? undefined : { cwd: repoPath },
      )
    } catch {
      /* gh missing/unauthenticated/offline, or not a GitHub remote → fall back */
    }
  }
  if (!branch) return FALLBACK_BRANCH // don't cache a failure — retry next time
  branchCache.set(key, { branch, at: Date.now() })
  return branch
}
