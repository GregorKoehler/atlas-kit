import { useEffect, useRef, useState } from 'preact/hooks'
import { Card, EmptyState } from '../Card'
import { MicField } from '../MicField'
import { AgentRow, fmtSchedAt } from './AgentList'
import { AtlasSpawnedAgents } from './AtlasSpawnedAgents'
import { ScheduleButton } from '../ScheduleButton'
import { useAgentFocus, agentFocusConsumed } from '../../lib/agentFocus'
import { useAgents } from '../../lib/useAgents'
import { spawnAgent, scheduleAgent, unscheduleAgent } from '../../lib/api'
import { useDraft } from '../../lib/useDraft'

/**
 * Knowledge agents — vault-grounded chats, spawned from the Knowledge Base tab
 * (a vault chat). The question field spawns an interactive agent
 * whose cwd is the vault: it answers from Wiki/ + Inbox/ with citations, can
 * research gaps on the web, and writes results back into the vault. Each live
 * chat gets its own tab; the tab body is the dev-agent row UI (transcript,
 * prompt/interrupt/queue, respond keys, voice) minus the branch/PR chrome.
 * Sessions ride the shared GET /api/agents poll, filtered by kind client-side.
 *
 * `vault` points the chat at a non-default vault: the Atlas tab passes 'atlas',
 * which the backend grounds in the typed Atlas (full-text AND typed-edge/graph
 * search) and closes the structured way (typed edges, the Legend, log.md). The
 * card filters the shared session list to its own vault, so the two tabs don't
 * cross-show each other's chats.
 *
 * `focus` is a one-shot signal (bumped `n` + a session `id`) from elsewhere in
 * the tab — the reader's "Chat about this" spawns an Atlas chat and points the
 * card at it: select that session and scroll this card into view.
 */
export function KnowledgeAgents({
  className = '',
  vault,
  focus,
}: {
  className?: string
  vault?: string
  focus?: { id: string; n: number }
}) {
  const { view, kick } = useAgents()
  const atlas = vault === 'atlas'
  // The unsent question persists across tab switches (which unmount this card),
  // scoped per vault so the two cards don't share a draft.
  const [question, setQuestion] = useDraft(`kb-question:${vault ?? 'work'}`)
  // Model/effort survive across chats (a card preference, unlike the question).
  // Effort defaults lower than dev agents — chat wants snappy first answers.
  const [model, setModel] = useState('opus')
  const [effort, setEffort] = useState('high')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  // The chat whose TAB was last clicked — drives the auto-full-screen on switch.
  // Distinct from `selected` so a default/reader-driven selection doesn't fullscreen.
  const [clicked, setClicked] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // External focus (reader → "Chat about this"): select the spawned chat and
  // bring this card into view. Keyed on the nonce so repeat focuses re-fire.
  useEffect(() => {
    if (!focus) return
    setSelected(focus.id)
    rootRef.current?.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [focus?.n])

  // This card's vault only — a null vault on a session is a pre-field (work) chat.
  const sessions = (view?.sessions ?? []).filter(
    (s) => s.kind === 'knowledge' && (s.vault ?? 'work') === (vault ?? 'work'),
  )

  // Global click-through (hero overview / full-screen switcher / constellation):
  // when the focused agent is one of THIS card's chats, select its tab; `clicked`
  // seeds the row full-screen (startFullscreen), same as a direct tab click. Only
  // unconsumed signals count — the mounted row consumes on open, so a long-done
  // click can't re-fire when this card remounts on a later tab switch.
  const gfocus = useAgentFocus()
  useEffect(() => {
    if (!gfocus || gfocus.n <= agentFocusConsumed()) return
    if (!sessions.some((s) => s.id === gfocus.id)) return
    setSelected(gfocus.id)
    setClicked(gfocus.id)
  }, [gfocus?.n])
  // Knowledge agents run on the box-local executor — same opt-in as dev agents.
  const enabled = !!view && view.localRepos.length > 0

  // Active tab: the explicit pick while it exists, else the newest chat
  // (sessions arrive newest-first, so a fresh spawn becomes the active tab).
  const active = sessions.find((s) => s.id === selected) ?? sessions[0]

  const ask = async (e: Event) => {
    e.preventDefault()
    const q = question.trim()
    if (!q || busy) return
    setBusy(true)
    setErr('')
    const r = await spawnAgent({ task: q, kind: 'knowledge', vault, model, effort })
    setBusy(false)
    if (r.ok) {
      setQuestion('')
      setSelected(null)
      kick()
    } else {
      setErr(r.error || 'spawn failed')
    }
  }

  // Schedule starting this chat for a future time instead of now (the ⏱ button).
  const scheduleAsk = async (at: string) => {
    const q = question.trim()
    if (!q) return { ok: false, error: 'enter a question first' }
    const r = await scheduleAgent({
      action: 'spawn',
      at,
      payload: { task: q, kind: 'knowledge', ...(vault ? { vault } : {}), model, effort },
    })
    if (r.ok) {
      setQuestion('')
      kick()
    }
    return r
  }
  // Pending scheduled chats for THIS card's vault (a null vault → the work vault).
  const pendingChats = (view?.scheduled ?? []).filter(
    (j) => j.action === 'spawn' && j.kind === 'knowledge' && (j.vault ?? 'work') === (vault ?? 'work'),
  )
  const cancelChat = async (id: string) => {
    const r = await unscheduleAgent(id)
    if (r.ok) kick()
  }

  return (
    <Card title={atlas ? 'Atlas Agent' : 'Knowledge Agents'} className={className}>
      <div className="agents" ref={rootRef}>
        <form className="agents__spawn" onSubmit={ask}>
          <MicField value={question} onChange={setQuestion}>
            <input
              className="capture__input capture__input--sm"
              placeholder={
                atlas
                  ? 'Ask the Atlas — a chat over the typed knowledge graph; works new insights back in (typed) on close…'
                  : 'Ask the knowledge base — spawns a chat grounded in the wiki, can research gaps…'
              }
              value={question}
              onInput={(e) => setQuestion(e.currentTarget.value)}
            />
          </MicField>
          <select
            className="capture__input capture__input--sm agents__select"
            value={model}
            onChange={(e) => setModel(e.currentTarget.value)}
            title="Model for this chat (always the 1M-context variant)"
          >
            <option value="fable">Fable</option>
            <option value="opus">Opus</option>
            <option value="sonnet">Sonnet</option>
          </select>
          <select
            className="capture__input capture__input--sm agents__select"
            value={effort}
            onChange={(e) => setEffort(e.currentTarget.value)}
            title="Thinking effort for this chat"
          >
            <option value="high">High</option>
            <option value="xhigh">Very high</option>
            <option value="max">Max</option>
          </select>
          <button type="submit" className="btn btn--approve" disabled={!question.trim() || busy || !enabled}>
            {busy ? 'Asking…' : 'Ask'}
          </button>
          <ScheduleButton
            onSchedule={scheduleAsk}
            disabled={!question.trim() || busy || !enabled}
            title={atlas ? 'schedule this Atlas chat for later' : 'schedule this chat for later'}
          />
        </form>
        {err ? <div className="agents__err">✗ {err}</div> : null}
        {pendingChats.length ? (
          <div className="agents__scheduled" role="list" aria-label="scheduled chats">
            {pendingChats.map((j) => (
              <div className="agent__queued agent__queued--sched" role="listitem" key={j.id}>
                <span className="agent__queued-label hud-label">⏱ {fmtSchedAt(j.at)}</span>
                <span className="agent__queued-text" title={j.label}>
                  {atlas ? 'Atlas chat' : 'chat'} — {j.label}
                </span>
                <button type="button" className="agent__queued-rm" onClick={() => cancelChat(j.id)} title="cancel scheduled chat">
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {!enabled && view ? (
          <EmptyState>Knowledge agents need the box-local executor (agent-local-repos.json).</EmptyState>
        ) : sessions.length === 0 ? (
          <EmptyState>
            No {atlas ? 'Atlas' : 'knowledge'} chats — ask a question above to start one.
          </EmptyState>
        ) : (
          <>
            <div className="kagents__tabs" role="tablist" aria-label={atlas ? 'atlas chats' : 'knowledge chats'}>
              {sessions.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={active?.id === s.id}
                  className={`kagents__tab${active?.id === s.id ? ' kagents__tab--active' : ''}`}
                  onClick={() => {
                    setSelected(s.id)
                    setClicked(s.id)
                  }}
                  title={s.task}
                >
                  <span className={`kagents__tab-dot kagents__tab-dot--${s.status}`} />
                  <span className="kagents__tab-label">{s.title || s.task}</span>
                </button>
              ))}
            </div>
            {active ? (
              <>
                <ul className="agents__list">
                  <AgentRow
                    key={active.id}
                    s={active}
                    scoped
                    knowledge
                    selfDeploy={false}
                    startFullscreen={active.id === clicked}
                    scheduled={view?.scheduled}
                    onChanged={kick}
                  />
                </ul>
                {atlas ? (
                  <AtlasSpawnedAgents parentId={active.id} sessions={view?.sessions ?? []} onChanged={kick} />
                ) : null}
              </>
            ) : null}
          </>
        )}
      </div>
    </Card>
  )
}
