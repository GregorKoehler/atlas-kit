import { useRef, useState } from 'preact/hooks'
import { useData } from '../../lib/useData'
import { fetchDeployStatus, triggerDeploy, type DeployStatus } from '../../lib/api'

type Phase = 'idle' | 'deploying' | 'done' | 'error'

/**
 * Redeploy button for a project card whose page carries `self_deploy: true` +
 * `repo_path:` — pull → build → restart that checkout on this box
 * (api/src/deploy-routes.mjs).
 *
 * The deploy restarts the very API this component polls, so the round trip is:
 * POST returns immediately → the API goes away for a few seconds → we keep
 * polling until it answers again with a NEW run in its state file. "New" is
 * decided by the run's timestamp CHANGING from the one we saw before clicking —
 * never by comparing clocks, which the browser and the box don't share.
 */
export function DeployButton({ project }: { project: string }) {
  const { data: status, refetch } = useData<DeployStatus>(() => fetchDeployStatus(project))
  const [phase, setPhase] = useState<Phase>('idle')
  const [err, setErr] = useState('')
  const [doneSha, setDoneSha] = useState('')
  // The run stamp as it was before this click — anything different is our run.
  const priorAt = useRef('')

  const deploy = async () => {
    if (phase === 'deploying') return
    if (
      !window.confirm(
        `Redeploy ${project}?\nPulls the latest commit, rebuilds and restarts it on this box (brief blip).`,
      )
    )
      return
    setErr('')
    setDoneSha('')
    priorAt.current = status?.lastDeploy?.at || ''
    setPhase('deploying')
    const r = await triggerDeploy(project)
    if (!r.ok) {
      // A refusal (dirty checkout, already running, nothing configured) — the
      // API answered with the reason, so nothing was started.
      setPhase('error')
      setErr(r.error || 'redeploy refused')
      return
    }
    let tries = 0
    const tick = async () => {
      tries++
      // Not refetch(): we need THIS answer, and useData's tick returns nothing.
      // A null (the API is mid-restart) just means "keep waiting".
      const s = await fetchDeployStatus(project)
      const run = s?.lastDeploy
      if (run && run.at !== priorAt.current && run.phase !== 'deploying') {
        refetch?.()
        if (run.phase === 'error') {
          setPhase('error')
          setErr(run.reason || run.step || 'redeploy failed')
        } else {
          setDoneSha(run.targetSha || s?.sha || '')
          setPhase('done')
          setTimeout(() => setPhase('idle'), 6000)
        }
        return
      }
      // ~2.5 min of restart + build headroom, then hand it back to the idle poll
      // (which keeps showing the run's phase — nothing is lost, just untracked).
      if (tries > 50) {
        refetch?.()
        setPhase('idle')
        return
      }
      setTimeout(tick, 3000)
    }
    setTimeout(tick, 3000)
  }

  // A run left in `deploying` by someone else (another tab, a phone) — show it
  // rather than offering a button that would only 409.
  const running = phase === 'deploying' || (phase === 'idle' && !!status?.running)
  // A persisted failure from the last run: the merge advanced HEAD but the build
  // or restart never landed, so this must never read as "up to date".
  const lastFailed = phase === 'idle' && !!status?.deployError
  const behind = status?.behind ?? 0
  const label = running
    ? `Deploying… ${status?.lastDeploy?.reason || ''}`.trim()
    : phase === 'done'
      ? `Redeployed ✓ ${doneSha}`.trim()
      : lastFailed
        ? 'Retry redeploy'
        : behind > 0
          ? `Redeploy · ${behind} ahead`
          : 'Redeploy'

  return (
    <div className="proj-deploy">
      <button
        type="button"
        className={`btn proj-deploy__btn ${
          lastFailed ? 'proj-deploy__btn--err' : behind > 0 && phase === 'idle' ? 'proj-deploy__btn--ahead' : ''
        }`}
        onClick={deploy}
        disabled={running}
        title={
          status
            ? `${status.repoPath} · running ${status.sha} on ${status.branch}` +
              (behind > 0 ? ` · ${behind} commit(s) behind` : '') +
              (status.dirty ? '\n\n⚠ uncommitted changes — a redeploy will refuse' : '') +
              (status.deployError ? `\n\n⚠ last redeploy failed: ${status.deployError}` : '') +
              '\n\nfetch → ff-only merge → build → serve.sh restart'
            : 'checking redeploy status…'
        }
      >
        {label}
      </button>
      {phase === 'error' ? (
        <span className="proj-deploy__err">✗ {err}</span>
      ) : lastFailed ? (
        <span className="proj-deploy__err">✗ last redeploy failed: {status!.deployError}</span>
      ) : null}
    </div>
  )
}
