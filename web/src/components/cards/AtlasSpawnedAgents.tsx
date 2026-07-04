import { useState } from 'preact/hooks'
import { useData } from '../../lib/useData'
import { fetchProjects, shipAgent, unshipAgent, queueAgent, type AgentSession } from '../../lib/api'
import { focusAgent } from '../../lib/agentFocus'
import { buildShipPrompt } from './AgentList'

/**
 * The dev agents an Atlas orchestrator chat spawned, surfaced inside that chat so
 * the operator can drive each one's SHIP without leaving the Atlas tab — and so
 * the orchestrator's own card reflects its fleet's ship status. One row per
 * spawned dev agent (constellation lineage: `spawnedBy === parentId`), each with
 * the same ship button states as the Dev Agents card (ready ⤴ / queued ⤴#N /
 * shipping… / shipped ✓).
 *
 * Pressing Ship here does exactly what the dev card's Ship button does (enqueue
 * into the serial ship train via /api/agents/ship) AND queues a one-line note
 * into the orchestrator's chat so it knows the operator just shipped this child.
 * The complementary READY/SHIPPED notes are queued by the backend poll
 * (atlas-ship-notify.mjs). The row label clicks through to the dev agent's own
 * full-screen split view (the constellation's focus signal).
 */
export function AtlasSpawnedAgents({
  parentId,
  sessions,
  onChanged,
}: {
  parentId: string
  sessions: AgentSession[]
  onChanged: () => void
}) {
  const { data: projects } = useData(() => fetchProjects())
  const [busy, setBusy] = useState<string | null>(null)

  // Self-deploy projects (only the dashboard) deploy via the Deploy-master button;
  // it changes one sentence of the ship prompt, so match the dev card per repo.
  const selfDeployOf = (repo: string) => !!projects?.find((p) => p.agentRepo === repo)?.selfDeploy

  // Dev agents THIS orchestrator chat spawned. Knowledge sub-chats, the standalone
  // 'atlas' ingest worker, and 'atlas-pass' runs are not ship-able dev agents.
  const children = sessions.filter((s) => s.spawnedBy === parentId && (s.kind ?? 'dev') === 'dev')
  if (!children.length) return null

  const label = (c: AgentSession) => c.title || c.micro || c.task?.slice(0, 60) || c.id

  const ship = async (c: AgentSession) => {
    if (busy) return
    setBusy(c.id)
    const r = await shipAgent({ id: c.id, text: buildShipPrompt(selfDeployOf(c.repo)) })
    if (r.ok) {
      await queueAgent({
        id: parentId,
        text: `⤴ Fleet update — the operator pressed Ship on the dev agent you spawned on ${c.repo} (${c.id}${
          c.task ? ` — "${c.task.slice(0, 80)}"` : ''
        }) from your chat. It is re-syncing onto master and merging its PR now; you'll get a ✅ note here when it lands.`,
      })
      onChanged()
    }
    setBusy(null)
  }

  const unship = async (c: AgentSession) => {
    if (busy) return
    setBusy(c.id)
    const r = await unshipAgent(c.id)
    if (r.ok) onChanged()
    setBusy(null)
  }

  return (
    <div className="kagents__spawned" role="group" aria-label="spawned dev agents">
      <div className="kagents__spawned-head hud-label">Spawned dev agents</div>
      {children.map((c) => (
        <div className="kagents__spawned-row" key={c.id}>
          <button
            type="button"
            className="kagents__spawned-open"
            onClick={() => focusAgent(c.id)}
            title="open this agent's full-screen view"
          >
            <span className={`kagents__tab-dot kagents__tab-dot--${c.status}`} />
            <span className="kagents__spawned-label">{label(c)}</span>
            <span className="kagents__spawned-repo hud-label">{c.repo}</span>
          </button>
          {c.shipState === 'shipped' ? (
            <span
              className="agent__act agent__shipped"
              title={`shipped${c.shipInfo ? `: ${c.shipInfo}` : ''} — PR merged by the agent`}
            >
              ✓
            </span>
          ) : c.shipQueue?.active ? (
            <span className="agent__act agent__ship--active" title="shipping… — merging this PR; the ship queue advances when it lands">
              <span className="agent__spin" aria-label="shipping" />
            </span>
          ) : c.shipQueue && c.shipQueue.pos > 1 ? (
            // Genuinely behind other ships — show its place (pos 1 is the head,
            // rendered as "ship pending" below, not a "#1 / 0 ahead" queue slot).
            <button
              type="button"
              className="agent__act agent__shipq"
              onClick={() => unship(c)}
              disabled={busy === c.id}
              title={`#${c.shipQueue.pos} in the ship queue — ships after the ${c.shipQueue.pos - 1} ahead merge; click to cancel`}
            >
              ⤴<sup className="agent__shipq-pos tnum">{c.shipQueue.pos}</sup>
            </button>
          ) : c.shipQueue ? (
            // Head of the train (nothing ahead), not yet merging — ship pending until
            // the agent goes idle. In-flight, not a queue slot; still cancellable.
            <button
              type="button"
              className="agent__act agent__shipq"
              onClick={() => unship(c)}
              disabled={busy === c.id}
              title="ship pending — merges as soon as the agent is idle; click to cancel"
            >
              <span className="agent__spin" aria-label="ship pending" />
            </button>
          ) : (
            <button
              type="button"
              className={`agent__act agent__ship${c.shipState === 'ready' ? ' agent__ship--ready' : ''}`}
              onClick={() => ship(c)}
              disabled={busy === c.id}
              title={`${
                c.shipState === 'ready' ? 'agent reports this is READY TO SHIP — ' : ''
              }ship: queue re-sync onto latest master → push → merge the PR. Tells me (this chat) it's in process; I'll note here when it lands.`}
            >
              ⤴
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
