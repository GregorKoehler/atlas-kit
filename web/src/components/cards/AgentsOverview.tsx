import { useAgents } from '../../lib/useAgents'
import { focusAgent } from '../../lib/agentFocus'
import type { TabId } from '../TabBar'

// Atlas Kit ships without the capture/research pipeline, so the job lanes are
// always empty; this stands in for the retired CaptureJob type.
type CaptureJob = any

/**
 * Compact cross-project agent overview for the hero header — replaces the old
 * global Dev Agents card. One lane per project, read left to right: the
 * project's active-count chip fans out to its individual agents, and each
 * agent fans out to the sub-agents it spawned (workflows mode). Deep-research
 * and wiki-ingest runs count as projects too, so everything in flight hangs
 * off the same tree; lanes stack vertically. Actual management (spawn/prompt/
 * sync/kill) lives on each project's card. Both reads come from shared polls,
 * so the overview costs no extra request.
 */

type SubAgent = { label: string; micro?: string; active: boolean }
/** A background job the agent (or one of its sub-agents — `sub` is the owner's
 * index into subAgents) launched with Bash run_in_background. */
type BgJob = { label: string; micro?: string; status: 'running' | 'done' | 'failed'; sub?: number }
/** Click-through target for a real agent node: fire `focusAgent(id, tab)` and
 * that agent's row full-screens itself on `tab` (where its card lives). Absent
 * on background work — research/ingest jobs, autonomous passes, sub-agents,
 * background jobs and the paired cleanup worker are not clickable. */
type Open = { id: string; tab: TabId }
/** A full dev/knowledge agent an Atlas chat SPAWNED — the gold Atlas→agent
 * lineage, shown as a delegation child fanning off the spawning chat node
 * (rather than floating as its own lane). `repo` is the project it belongs to,
 * shown as a tag (the grouping the standalone lane used to carry); `needs` ⇒
 * that agent is parked on your input. */
type SpawnedAgent = { key: string; label: string; full: string; repo: string; needs: boolean; open: Open }

/** Which tab a vault chat's card lives on: the Atlas Agent card sits on the
 * Home tab (under the scorecard). */
const chatTab = (_vault?: string): TabId => 'command'

/** One agent on a lane — a dev session or a live research/ingest job. */
type AgentNode = {
  key: string
  /** Display name: the spawn-time generated micro tag (dev), falling back to
   * the short title then the raw task text — or the job title/topic. Always
   * the shortest label we have; the full title/task lives in the tooltip. */
  label: string
  /** Untruncated text for the tooltip. */
  full: string
  /** Dev session parked on your input ('idle') — amber node. */
  needs: boolean
  subAgents: SubAgent[]
  bgJobs: BgJob[]
  /** Atlas chats only: the dev/knowledge agents this chat spawned, drawn as a
   * gold lineage fan to its right. Empty for every other node. */
  spawned: SpawnedAgent[]
  /** The paired Atlas knowledge worker, if this dev agent has one — a quiet
   * leaf rather than its own repo lane (mirroring the constellation). `active`
   * while it's recapping/ingesting on the agent's close (`closePhase`). */
  worker?: { active: boolean; phase?: 'recap' | 'ingest' }
  /** Set on real agents (dev sessions, vault chats) — the node clicks through
   * to that agent's full-screen view. Absent on research/ingest job nodes and
   * autonomous passes (background work). */
  open?: Open
}

type Lane = {
  key: string
  label: string
  /** Atlas-originated lane (its vault chats, the autonomous passes, atlas
   * research) — these hang off the Atlas anchor; other lanes stay independent. */
  atlas?: boolean
  /** Agents working right now (dev 'running' / jobs 'processing'). */
  active: number
  /** Dev sessions awaiting your input ('idle'). */
  needs: number
  /** Jobs waiting in the capture queue (no agent running yet). */
  queued: number
  nodes: AgentNode[]
}

/** `switcher` is the full-screen strip variant: agents only (no research/
 * ingest lanes, no autonomous passes, no sub-agent/job/worker fans), every
 * node clickable, with `currentId` — the agent whose full screen you're in —
 * highlighted. The default (hero) shows everything and makes just the real
 * agent nodes clickable. */
export function AgentsOverview({ switcher = false, currentId }: { switcher?: boolean; currentId?: string }) {
  const { view } = useAgents()
  if (!view) return null

  const errors = view.sessions.filter((s) => s.status === 'error').length

  // One lane per project (repo) with live sessions — 'running' is working,
  // 'idle' is blocked on you. Atlas-originated work routes to its own tagged
  // lanes (its vault chats, the autonomous passes), which hang off the Atlas
  // anchor below; non-atlas knowledge chats keep their own 'knowledge' lane.
  // Atlas origins — the Atlas chats (and autonomous passes) that spawn other
  // agents. An agent whose `spawnedBy` points at one of these was launched FROM
  // Atlas, so it hangs off the Atlas anchor too (mirroring the gold spawnedBy
  // edge the constellation draws) instead of floating as a stray independent lane.
  const atlasOrigins = new Set(
    view.sessions
      .filter((s) => (s.kind === 'knowledge' && s.vault === 'atlas') || s.kind === 'atlas-pass')
      .map((s) => s.id),
  )
  const byKey = new Map<string, Lane>()
  const nodeById = new Map<string, AgentNode>() // session id → its rendered node (for spawn attach)
  const deferredSpawns: typeof view.sessions = [] // Atlas-spawned agents, attached in pass 2
  for (const s of view.sessions) {
    if (s.status !== 'running' && s.status !== 'idle') continue
    // A bare Atlas worker (kind:'atlas' — a dev agent's paired knowledge worker,
    // not a vault chat or an autonomous pass) gets no repo lane of its own; it
    // renders as a quiet leaf under the dev agent it's paired with (from that
    // agent's `atlasWorker` flag below), mirroring the constellation.
    if (s.kind === 'atlas') continue
    const isAtlasChat = s.kind === 'knowledge' && s.vault === 'atlas'
    // Spawned by an Atlas chat (and not itself an Atlas chat/pass) → hold it back;
    // it hangs off its spawning chat NODE as a gold lineage fan (pass 2), not as a
    // separate lane floating under the anchor.
    if (!isAtlasChat && s.kind !== 'atlas-pass' && s.spawnedBy && atlasOrigins.has(s.spawnedBy)) {
      deferredSpawns.push(s)
      continue
    }
    let key: string, label: string, atlas = false
    if (isAtlasChat) { key = 'atlas·chat'; label = 'chats'; atlas = true }
    else if (s.kind === 'atlas-pass') { key = 'passes'; label = 'passes'; atlas = true }
    else if (s.kind === 'knowledge') { key = 'knowledge'; label = 'knowledge' }
    else { key = s.repo; label = s.repo }
    let lane = byKey.get(key)
    if (!lane) byKey.set(key, (lane = { key, label, atlas, active: 0, needs: 0, queued: 0, nodes: [] }))
    // Autonomous Atlas passes are never blocked on you — their brief idle window
    // counts as active, not an amber "needs input". (Bare 'atlas' workers already
    // `continue`d above, so only the pass needs excluding here.)
    const needs = s.status === 'idle' && s.kind !== 'atlas-pass'
    if (needs) lane.needs++
    else lane.active++
    const node: AgentNode = {
      key: s.id,
      label: s.micro || s.title || s.task,
      full: s.title ? `${s.title} — ${s.task}` : s.task,
      needs,
      subAgents: s.subAgents ?? [],
      bgJobs: s.bgJobs ?? [],
      spawned: [],
      worker: s.atlasWorker ? { active: !!s.closePhase, phase: s.closePhase } : undefined,
      // Dev sessions + vault chats click through; autonomous passes don't.
      open:
        s.kind === 'atlas-pass'
          ? undefined
          : { id: s.id, tab: s.kind === 'knowledge' ? chatTab(s.vault) : 'command' },
    }
    lane.nodes.push(node)
    nodeById.set(s.id, node)
  }

  // Pass 2 — attach each held-back Atlas-spawned agent to its spawning chat node
  // (the gold lineage fan to its right; one chat can spawn many). If that parent
  // isn't currently shown (e.g. it finished), fall back to its own lane under the
  // Atlas anchor — the legacy grouping — so the agent still surfaces.
  for (const s of deferredSpawns) {
    const needs = s.status === 'idle'
    const full = s.title ? `${s.title} — ${s.task}` : s.task
    const open: Open = { id: s.id, tab: s.kind === 'knowledge' ? chatTab(s.vault) : 'command' }
    const parent = nodeById.get(s.spawnedBy!)
    if (parent) {
      parent.spawned.push({ key: s.id, label: s.micro || s.title || s.task, full, repo: s.repo, needs, open })
      continue
    }
    const key = s.kind === 'knowledge' ? `atlas·kn·${s.vault || 'work'}` : `atlas·${s.repo}`
    const label = s.kind === 'knowledge' ? s.vault || 'knowledge' : s.repo
    let lane = byKey.get(key)
    if (!lane) byKey.set(key, (lane = { key, label, atlas: true, active: 0, needs: 0, queued: 0, nodes: [] }))
    if (needs) lane.needs++
    else lane.active++
    lane.nodes.push({
      key: s.id,
      label: s.micro || s.title || s.task,
      full,
      needs,
      subAgents: s.subAgents ?? [],
      bgJobs: s.bgJobs ?? [],
      spawned: [],
      worker: s.atlasWorker ? { active: !!s.closePhase, phase: s.closePhase } : undefined,
      open,
    })
  }

  // Atlas Kit ships without the capture/research pipeline, so there are no
  // background research/ingest jobs to fold into the constellation.
  const jobs: any[] = []
  const research = jobs.filter((j) => j.kind === 'research')
  const atlasResearch: Lane = { ...workLane('research', research.filter((j) => j.vault === 'atlas')), key: 'atlas·research', atlas: true }
  const researchLane = workLane('research', research.filter((j) => j.vault !== 'atlas'))
  const ingestLane = workLane('ingest', jobs.filter((j) => j.kind !== 'research'))

  const live = (l: Lane) => l.active + l.needs + l.queued > 0
  // Atlas-originated lanes hang off the Atlas anchor on the left, ordered: the
  // chats, the agents those chats spawned, the autonomous passes, then atlas
  // research; everything else is an independent lane, kept as-is.
  const atlasRank = (k: string) => (k === 'atlas·chat' ? 0 : k === 'passes' ? 2 : k === 'atlas·research' ? 3 : 1)
  // The switcher strip is agents-only: the pass lane and the research/ingest
  // work lanes (background processes — nothing to click through to) drop out.
  const atlasLanes = [...[...byKey.values()].filter((l) => l.atlas), ...(switcher ? [] : [atlasResearch])]
    .filter(live)
    .filter((l) => !switcher || l.key !== 'passes')
    .sort((a, b) => atlasRank(a.key) - atlasRank(b.key))
  const indepLanes = [
    ...[...byKey.values()].filter((l) => !l.atlas).sort((a, b) => b.active + b.needs - (a.active + a.needs)),
    ...(switcher ? [] : [researchLane, ingestLane]),
  ].filter(live)
  const anything = atlasLanes.length > 0 || indepLanes.length > 0 || errors > 0

  // Headline count next to the label: every agent live right now — sessions
  // (working + awaiting input), active research/ingest runs, plus the running
  // sub-agents they've fanned out to. Queued capture jobs aren't counted (no
  // agent running yet); they still surface on their lane's chip.
  const allLanes = [...atlasLanes, ...indepLanes]
  // Switcher: keep only the agent nodes themselves — the sub-agent/background-
  // job/paired-worker fans are background work, not switch targets. The spawned
  // fan stays (those are full, clickable agents).
  if (switcher)
    for (const l of allLanes)
      for (const n of l.nodes) {
        n.subAgents = []
        n.bgJobs = []
        n.worker = undefined
      }
  const subActive = allLanes.reduce(
    (sum, l) => sum + l.nodes.reduce((x, n) => x + n.subAgents.filter((a) => a.active).length, 0),
    0,
  )
  // Atlas-spawned agents now hang off their chat node (not their own lane), so
  // they're counted from the nodes' `spawned` fans — all under Atlas.
  const spawnActive = atlasLanes.reduce((s, l) => s + l.nodes.reduce((x, n) => x + n.spawned.length, 0), 0)
  const atlasActive = atlasLanes.reduce((s, l) => s + l.active + l.needs, 0) + spawnActive
  const projActive = indepLanes.reduce((s, l) => s + l.active + l.needs, 0)
  const total = atlasActive + projActive + subActive

  return (
    <div className={`agents-ov${switcher ? ' agents-ov--switch' : ''}`}>
      <div className="hud-label agents-ov__label">
        Agents
        {total > 0 ? (
          <span
            className="agents-ov__total tnum"
            title={`${total} agent${total === 1 ? '' : 's'} active — ${atlasActive} under Atlas · ${projActive} project · ${subActive} sub-agent${subActive === 1 ? '' : 's'}`}
          >
            {total}
          </span>
        ) : null}
        <span
          className={`agents-ov__dot ${view.workstationReachable ? 'agents-ov__dot--ok' : 'agents-ov__dot--down'}`}
          title={view.workstationReachable ? `${view.workstation} reachable` : `${view.workstation} offline`}
        />
      </div>
      {!anything ? (
        <span className="agents-ov__idle">none active</span>
      ) : (
        <div className="agents-ov__tree">
          {atlasLanes.length > 0 ? <AtlasGroup lanes={atlasLanes} currentId={currentId} /> : null}
          {indepLanes.length > 0 || errors ? (
            <div className="agents-ov__lanes">
              {indepLanes.map((l) => (
                <LaneRow key={l.key} lane={l} currentId={currentId} />
              ))}
              {errors ? (
                <>
                  <span className="agents-ov__chip agents-ov__chip--err agents-ov__lane-chip">
                    ⚠ {errors}
                  </span>
                  <span />
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

/** The Atlas anchor. With a live Atlas chat, its gold ◆ ATLAS pill IS the
 * source: it heads the group, and the other Atlas lanes (passes · research ·
 * spawned agents) hang off it on the gold spine — no separate diamond node to
 * repeat it. Chats-only ⇒ the pill stands alone. With no live chat (passes /
 * research only), fall back to the standalone ◆ "Atlas" anchor node grouping
 * those lanes on the spine. */
function AtlasGroup({ lanes, currentId }: { lanes: Lane[]; currentId?: string }) {
  const chats = lanes.find((l) => l.key === 'atlas·chat')
  const others = lanes.filter((l) => l.key !== 'atlas·chat')
  if (chats)
    return (
      <div className="agents-ov__atlas-rooted">
        <div className="agents-ov__atlas-head">
          <LaneRow lane={chats} currentId={currentId} />
        </div>
        {others.length > 0 ? (
          <div className="agents-ov__atlas-lanes agents-ov__atlas-lanes--under">
            {others.map((l) => (
              <LaneRow key={l.key} lane={l} currentId={currentId} />
            ))}
          </div>
        ) : null}
      </div>
    )
  return (
    <div className="agents-ov__atlas" title="Atlas — origin of these agents">
      <span className="agents-ov__atlas-node">
        <span className="agents-ov__atlas-diamond">◆</span>
        <span className="agents-ov__atlas-name">Atlas</span>
      </span>
      <div className="agents-ov__atlas-lanes">
        {lanes.map((l) => (
          <LaneRow key={l.key} lane={l} currentId={currentId} />
        ))}
      </div>
    </div>
  )
}

// `processing` jobs are the lane's agent nodes; `queued` ones only count (no
// agent is running yet, so there is nothing to hang off the tree).
function workLane(label: string, jobs: CaptureJob[]): Lane {
  const lane: Lane = { key: label, label, active: 0, needs: 0, queued: 0, nodes: [] }
  for (const j of jobs) {
    if (j.status === 'processing') {
      lane.active++
      const name = j.title || j.topic || hostOf(j.url) || j.kind
      lane.nodes.push({ key: `${label}-${j.id}`, label: name, full: name, needs: false, subAgents: j.subAgents ?? [], bgJobs: [], spawned: [] })
    } else if (j.status === 'queued') lane.queued++
  }
  return lane
}

function hostOf(url: string | null): string {
  if (!url) return ''
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function shortTask(t: string): string {
  return t.length > 26 ? t.slice(0, 25) + '…' : t
}

// Geometry shared by the lane connector and the labeled delegation fans (px).
// Row heights are computed in JS so the connector SVGs hit each row's center.
const FAN_ROW = 13 // height of one labeled fan row (a dot + its title)
const NODE_ROW = 18 // min height of one agent row
const FAN_SHOW = 6 // cap visible rows per group; the rest fold into a "+N more" row
const DOT_X = 14 // x of the fan's dot column (the curved connector lands here)

type SpawnRow = { t: 'spawn'; label: string; micro?: string; repo: string; needs: boolean; open: Open }
type SubRow = { t: 'sub'; label: string; micro?: string; active: boolean }
type JobRow = { t: 'job'; label: string; micro?: string; status: 'running' | 'done' | 'failed' }
type WorkerRow = { t: 'worker'; active: boolean; phase?: 'recap' | 'ingest' }
type MoreRow = { t: 'more'; n: number; kind: 'spawn' | 'sub' | 'job' }
type FanRow = SpawnRow | SubRow | JobRow | WorkerRow | MoreRow

// The fan's rows top-to-bottom: spawned agents (the gold lineage children) first,
// then sub-agents, then background jobs — each capped at FAN_SHOW with the
// overflow folded into a leading muted "+N more" row. Shared by rowHeight (lane
// geometry) and Fan (render) so the two never disagree.
function buildFanRows(
  subAgents: SubAgent[],
  bgJobs: BgJob[],
  spawned: SpawnedAgent[],
  worker?: AgentNode['worker'],
): FanRow[] {
  const rows: FanRow[] = []
  const spawnShown = spawned.slice(-FAN_SHOW)
  const spawnHidden = spawned.length - spawnShown.length
  if (spawnHidden > 0) rows.push({ t: 'more', n: spawnHidden, kind: 'spawn' })
  for (const sp of spawnShown) rows.push({ t: 'spawn', label: sp.label, repo: sp.repo, needs: sp.needs, open: sp.open })
  const subShown = subAgents.slice(-FAN_SHOW)
  const subHidden = subAgents.length - subShown.length
  if (subHidden > 0) rows.push({ t: 'more', n: subHidden, kind: 'sub' })
  for (const a of subShown) rows.push({ t: 'sub', label: a.label, micro: a.micro, active: a.active })
  const jobShown = bgJobs.slice(-FAN_SHOW)
  const jobHidden = bgJobs.length - jobShown.length
  if (jobHidden > 0) rows.push({ t: 'more', n: jobHidden, kind: 'job' })
  for (const j of jobShown) rows.push({ t: 'job', label: j.label, micro: j.micro, status: j.status })
  // The paired Atlas worker — a single quiet leaf last (it's never folded into
  // a "+N more"; there's only ever one).
  if (worker) rows.push({ t: 'worker', active: worker.active, phase: worker.phase })
  return rows
}

const rowHeight = (a: AgentNode) => {
  const n = buildFanRows(a.subAgents, a.bgJobs, a.spawned, a.worker).length
  return n ? Math.max(FAN_ROW * n, NODE_ROW) : NODE_ROW
}

/** One project lane: the count chip on the left fans out to the project's
 * individual agents (stacked vertically), each with its own sub-agent fan. */
function LaneRow({ lane, currentId }: { lane: Lane; currentId?: string }) {
  const heights = lane.nodes.map(rowHeight)
  const H = Math.max(heights.reduce((a, b) => a + b, 0), NODE_ROW)
  let acc = 0
  const centers = heights.map((h) => {
    const c = acc + h / 2
    acc += h
    return c
  })
  const W = 22
  const cy = H / 2
  // The Atlas chats lane reads as the Atlas source itself — a gold ◆ ATLAS pill
  // (the anchor's diamond + gold), not a plain "chats" chip.
  const isAtlasChat = lane.key === 'atlas·chat'
  const chipTip = [
    `${isAtlasChat ? 'Atlas chats' : lane.label}: ${lane.active} working`,
    lane.needs ? `${lane.needs} awaiting your input` : '',
    lane.queued ? `${lane.queued} queued` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  // Research/ingest chips spell out "active · queued" (their queue is a real
  // backlog); dev chips keep the compact count + amber needs marker.
  const isWork = lane.key === 'research' || lane.key === 'ingest'
  return (
    <>
      <span
        className={`agents-ov__chip agents-ov__lane-chip${lane.needs ? ' agents-ov__chip--need' : ''}${isAtlasChat ? ' agents-ov__chip--atlas' : ''}`}
        title={chipTip}
      >
        {isAtlasChat ? (
          <>
            <span className="agents-ov__chip-diamond">◆</span> ATLAS{' '}
          </>
        ) : (
          <>{lane.label} </>
        )}
        <span className="agents-ov__n tnum">{isWork ? lane.active : lane.active + lane.needs}</span>
        {isWork ? ' active' : null}
        {lane.needs > 0 ? <span className="agents-ov__need tnum"> ⏳{lane.needs}</span> : null}
        {lane.queued > 0 ? (
          <>
            {' · '}
            <span className="agents-ov__queued tnum">{lane.queued}</span> queued
          </>
        ) : null}
      </span>
      <span className="agents-ov__lane-body">
        {lane.nodes.length > 0 ? (
          <svg className="agents-ov__lane-svg" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
            {centers.map((y, i) => (
              <path
                key={`e${i}`}
                className="agents-ov__edge"
                d={`M1,${cy} C${W / 2},${cy} ${W / 2},${y} ${W - 4},${y}`}
              />
            ))}
            {centers.map((y, i) => (
              <circle
                key={`n${i}`}
                className={`agents-ov__anode${lane.nodes[i].needs ? ' agents-ov__anode--need' : ''}`}
                cx={W - 4}
                cy={y}
                r={2.6}
              />
            ))}
          </svg>
        ) : null}
        <span className="agents-ov__nodes">
          {lane.nodes.map((a, i) => (
            <AgentRow key={a.key} agent={a} height={heights[i]} currentId={currentId} />
          ))}
        </span>
      </span>
    </>
  )
}

function AgentRow({ agent, height, currentId }: { agent: AgentNode; height: number; currentId?: string }) {
  const activeSubs = agent.subAgents.filter((s) => s.active).length
  const runningJobs = agent.bgJobs.filter((j) => j.status === 'running').length
  const tip =
    agent.full +
    (agent.needs ? ' — awaiting your input' : '') +
    (agent.spawned.length
      ? ` — spawned ${agent.spawned.length} agent${agent.spawned.length === 1 ? '' : 's'}:\n` +
        agent.spawned.map((s) => `◆ [${s.repo}] ${s.full}${s.needs ? ' (awaiting input)' : ''}`).join('\n')
      : '') +
    (agent.subAgents.length
      ? ` — ${activeSubs} running / ${agent.subAgents.length} spawned:\n` +
        agent.subAgents.map((s) => (s.active ? '• ' : '✓ ') + s.label).join('\n')
      : '') +
    (agent.bgJobs.length
      ? ` — ${runningJobs} running / ${agent.bgJobs.length} background job${agent.bgJobs.length === 1 ? '' : 's'}:\n` +
        agent.bgJobs
          .map(
            (j) =>
              (j.status === 'running' ? '▶ ' : j.status === 'failed' ? '✗ ' : '✓ ') +
              j.label +
              (j.sub != null && agent.subAgents[j.sub] ? ` (via ${agent.subAgents[j.sub].label})` : ''),
          )
          .join('\n')
      : '') +
    (agent.worker
      ? ` — paired Atlas worker${agent.worker.active ? ` (${agent.worker.phase === 'ingest' ? 'ingesting' : 'recapping'})` : ''}`
      : '') +
    (agent.open ? ' — click: full-screen view' : '')
  // TS: property narrowing doesn't reach into the onClick closure — pin it.
  const open = agent.open
  return (
    <span className="agents-ov__node" style={{ height: `${height}px` }} title={tip}>
      {open ? (
        <button
          type="button"
          className={`agents-ov__node-task agents-ov__node-btn${open.id === currentId ? ' agents-ov__open--current' : ''}`}
          onClick={() => focusAgent(open.id, open.tab)}
        >
          {shortTask(agent.label)}
        </button>
      ) : (
        <span className="agents-ov__node-task">{shortTask(agent.label)}</span>
      )}
      {agent.subAgents.length > 0 || agent.bgJobs.length > 0 || agent.spawned.length > 0 || agent.worker ? (
        <Fan subAgents={agent.subAgents} bgJobs={agent.bgJobs} spawned={agent.spawned} worker={agent.worker} currentId={currentId} />
      ) : null}
    </span>
  )
}

/** The 1-to-many delegation fan, now labeled: each sub-agent and background
 * job the agent spawned gets its own row — a dot (circle for sub-agents,
 * square for jobs) on a curved connector from the agent node, beside its
 * super-short title (the description the spawning agent gave it, ellipsized).
 * Active sub-agents glow teal and running jobs green; finished ones grey out
 * and strike through (failed jobs turn red), so the delegation history stays
 * visible for the parent's lifetime. Each group caps at FAN_SHOW rows; older
 * ones fold into a muted "+N more" row (the node tooltip still lists them all). */
function Fan({
  subAgents,
  bgJobs,
  spawned,
  worker,
  currentId,
}: {
  subAgents: SubAgent[]
  bgJobs: BgJob[]
  spawned: SpawnedAgent[]
  worker?: AgentNode['worker']
  currentId?: string
}) {
  const rows = buildFanRows(subAgents, bgJobs, spawned, worker)
  const n = rows.length
  if (!n) return null
  const h = FAN_ROW * n
  const cy = h / 2
  const yAt = (i: number) => FAN_ROW * i + FAN_ROW / 2
  const W = DOT_X + 4
  return (
    <>
      <svg className="agents-ov__fan-svg" width={W} height={h} viewBox={`0 0 ${W} ${h}`} aria-hidden="true">
        {rows.map((r, i) =>
          r.t === 'more' ? null : (
            <path
              key={`e${i}`}
              className={fanEdgeClass(r)}
              d={`M1,${cy} C${DOT_X / 2},${cy} ${DOT_X / 2},${yAt(i)} ${DOT_X},${yAt(i)}`}
            />
          ),
        )}
        {rows.map((r, i) => {
          if (r.t === 'more') return null
          const y = yAt(i)
          if (r.t === 'spawn')
            return (
              <circle
                key={`d${i}`}
                className={`agents-ov__snode${r.needs ? ' agents-ov__snode--need' : ''}`}
                cx={DOT_X}
                cy={y}
                r={2.8}
              />
            )
          if (r.t === 'sub' || r.t === 'worker')
            return (
              <circle
                key={`d${i}`}
                className={`agents-ov__cnode${r.active ? '' : ' agents-ov__cnode--done'}`}
                cx={DOT_X}
                cy={y}
                r={2.4}
              />
            )
          return (
            <rect
              key={`d${i}`}
              className={`agents-ov__jnode${
                r.status === 'done' ? ' agents-ov__jnode--done' : r.status === 'failed' ? ' agents-ov__jnode--failed' : ''
              }`}
              x={DOT_X - 2.4}
              y={y - 2.4}
              width={4.8}
              height={4.8}
              rx={1}
            />
          )
        })}
      </svg>
      <span className="agents-ov__fan-rows">
        {rows.map((r, i) => {
          const style = { height: `${FAN_ROW}px`, lineHeight: `${FAN_ROW}px` }
          // A spawned agent is a full, live agent — its row clicks through to
          // that agent's full-screen view, like the lane nodes above it.
          if (r.t === 'spawn')
            return (
              <button
                key={i}
                type="button"
                className={`${fanRowClass(r)} agents-ov__fan-btn${r.open.id === currentId ? ' agents-ov__open--current' : ''}`}
                style={style}
                title={`${fanRowTitle(r)} — click: full-screen view`}
                onClick={() => focusAgent(r.open.id, r.open.tab)}
              >
                {/* The project tag (the grouping the standalone lane used to
                    show) sits ahead of the spawned agent's title. */}
                <span className="agents-ov__fan-tag">{r.repo}</span>
                {r.label}
              </button>
            )
          return (
            <span key={i} className={fanRowClass(r)} style={style} title={fanRowTitle(r)}>
              {r.t === 'more' ? (
                `+${r.n} more`
              ) : r.t === 'worker' ? (
                r.active ? `Atlas worker · ${r.phase === 'ingest' ? 'ingesting' : 'recapping'}` : 'Atlas worker'
              ) : (
                r.micro || r.label
              )}
            </span>
          )
        })}
      </span>
    </>
  )
}

function fanEdgeClass(r: SpawnRow | SubRow | JobRow | WorkerRow): string {
  // The spawn (lineage) edge is always gold — it marks descent from the Atlas
  // chat, regardless of the child's run state.
  if (r.t === 'spawn') return 'agents-ov__edge agents-ov__edge--spawn'
  // sub & worker share the plain connector (teal/lit when active, dim when not);
  // jobs get the dashed green one.
  return r.t === 'job'
    ? `agents-ov__edge agents-ov__edge--job${r.status === 'running' ? '' : ' agents-ov__edge--done'}`
    : `agents-ov__edge${r.active ? '' : ' agents-ov__edge--done'}`
}

function fanRowClass(r: FanRow): string {
  if (r.t === 'more') return 'agents-ov__fan-row agents-ov__fan-row--more'
  if (r.t === 'spawn')
    return `agents-ov__fan-row agents-ov__fan-row--spawn${r.needs ? ' agents-ov__fan-row--spawn-need' : ''}`
  if (r.t === 'sub') return `agents-ov__fan-row${r.active ? ' agents-ov__fan-row--active' : ' agents-ov__fan-row--done'}`
  // The paired worker stays muted when standing by (no strike-through — it's
  // alive, not finished) and lights teal while it recaps/ingests.
  if (r.t === 'worker') return `agents-ov__fan-row${r.active ? ' agents-ov__fan-row--active' : ''}`
  return `agents-ov__fan-row${
    r.status === 'done' ? ' agents-ov__fan-row--done' : r.status === 'failed' ? ' agents-ov__fan-row--failed' : ''
  }`
}

function fanRowTitle(r: FanRow): string {
  if (r.t === 'more')
    return `${r.n} more ${r.kind === 'spawn' ? 'spawned agents' : r.kind === 'sub' ? 'sub-agents' : 'background jobs'} — full list in the node tooltip`
  // The fan shows the short micro tag; the full agent-authored label rides the tooltip.
  if (r.t === 'spawn') return `${r.label} — agent spawned by this Atlas chat${r.needs ? ' · awaiting your input' : ''}`
  if (r.t === 'sub') return `${r.label} — sub-agent ${r.active ? 'running' : 'finished'}`
  if (r.t === 'worker')
    return `Paired Atlas knowledge worker — briefs this agent from the Atlas and ingests its results${r.active ? ` · ${r.phase === 'ingest' ? 'ingesting now' : 'recapping now'}` : ''}`
  return `${r.label} — background job ${r.status}`
}
