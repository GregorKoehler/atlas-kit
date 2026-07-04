import { useRef } from 'preact/hooks'
import { Card, EmptyState } from '../Card'
import { useData } from '../../lib/useData'
import { useAgents } from '../../lib/useAgents'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { AgentList, fmtDur } from './AgentList'
import { fetchProjects, type Project, type AgentSession } from '../../lib/api'

// One full card per project (so each can later host that project's live
// Claude Code session/agent status). Lays out two-up on wide screens.
const SPAN = 'col-span-12 lg:col-span-6'

// Cards reorder by most-recent dev-agent activity, where "activity" is the
// latest dev-agent session spawn time (startedAt) for the project's bridge repo
// (the project's `agentRepo` ↔ a session's `repo`). Projects with no dev-agent
// session sink to the bottom, stable in their incoming (alphabetical) order.
function activityTime(p: Project, latestByRepo: Map<string, number>): number {
  if (!p.agentRepo) return -Infinity
  const t = latestByRepo.get(p.agentRepo)
  return t === undefined ? -Infinity : t
}

// Reduce the shared agents poll to one timestamp per repo: the freshest signal
// of dev-agent activity (ms). Two inputs are folded together, max wins:
//   • live sessions still in the registry (their `startedAt`), and
//   • the API's persisted last-spawn-per-repo floor (`lastSpawn`), which it keeps
//     even after a repo's sessions are all closed/cleaned up.
// So a project that once ran an agent stays ranked above one that never did,
// indefinitely. Repos with neither never get an entry (→ -Infinity, sunk).
function latestActivityByRepo(
  sessions: AgentSession[],
  lastSpawn: Record<string, string>,
): Map<string, number> {
  const m = new Map<string, number>()
  const bump = (repo: string, t: number) => {
    if (!repo || Number.isNaN(t)) return
    const prev = m.get(repo)
    if (prev === undefined || t > prev) m.set(repo, t)
  }
  for (const s of sessions) bump(s.repo, Date.parse(s.startedAt))
  for (const [repo, at] of Object.entries(lastSpawn)) bump(repo, Date.parse(at))
  return m
}

// Descending by recency (freshest first). Avoids Infinity − Infinity = NaN (a
// NaN comparator is undefined-order); equal times return 0 so the stable sort
// keeps base order. On mobile (one column) this order is used as-is, top to
// bottom; on desktop it feeds the column-pinning below.
function byRecency(latestByRepo: Map<string, number>) {
  return (a: Project, b: Project): number => {
    const ta = activityTime(a, latestByRepo)
    const tb = activityTime(b, latestByRepo)
    if (ta === tb) return 0
    return tb > ta ? 1 : -1
  }
}

// Desktop is a two-column grid filled row-major (1st card → top-left, 2nd →
// top-right, 3rd → 2nd-left, …). A plain global re-sort hops a card across the
// left↔right divide whenever its rank parity changes, which reads as a
// disorienting sideways jump. So we PIN each project to a column: the columns
// are seeded once — walking the current recency order and dropping each project
// into the emptier column (ties → left), which lays the freshest cards out
// row-major so the initial grid still reads sorted — then frozen for the life of
// the page. Thereafter we only re-sort WITHIN each column, so a project rising
// on recency moves up its own column and never switches sides. A reload re-seeds
// from the latest global order.
//
// `columns` is the persisted assignment (projectName → 0 left | 1 right),
// mutated here to place any not-yet-seen project (initial seed, or a project
// added later) without disturbing the ones already placed.
function pinnedOrder(globalOrder: Project[], columns: Map<string, 0 | 1>): Project[] {
  const counts: [number, number] = [0, 0]
  for (const c of columns.values()) counts[c]++
  for (const p of globalOrder) {
    if (columns.has(p.name)) continue
    const col: 0 | 1 = counts[0] <= counts[1] ? 0 : 1
    columns.set(p.name, col)
    counts[col]++
  }
  const left = globalOrder.filter((p) => columns.get(p.name) === 0)
  const right = globalOrder.filter((p) => columns.get(p.name) === 1)
  const merged: Project[] = []
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (i < left.length) merged.push(left[i])
    if (i < right.length) merged.push(right[i])
  }
  return merged
}

export function Projects() {
  const { data, loading } = useData(() => fetchProjects())
  // One shared agents poll feeds both the per-card agent lists and this ordering.
  const { view } = useAgents()
  // lg breakpoint = the two-column grid (matches `lg:col-span-6` on each card).
  const twoColumn = useMediaQuery('(min-width: 1024px)')
  // Frozen-once column assignment for the pinned desktop layout (see pinnedOrder);
  // a ref so it survives re-renders/polls and resets only on a full reload.
  const columns = useRef<Map<string, 0 | 1>>(new Map()).current

  if (!data) {
    return (
      <Card title="Projects" className={SPAN}>
        <div className="note-status tnum">{loading ? 'LOADING…' : 'UNAVAILABLE'}</div>
      </Card>
    )
  }
  if (data.length === 0) {
    return (
      <Card title="Projects" className={SPAN}>
        <EmptyState>No projects yet — add a `type: project` page under Wiki/Projects/ in your vault (with an optional `agent_repo:` to bind a spawnable repo).</EmptyState>
      </Card>
    )
  }
  const globalOrder = [...data].sort(byRecency(latestActivityByRepo(view?.sessions ?? [], view?.lastSpawn ?? {})))
  // Single column has no left/right to preserve → follow the global recency
  // order directly. Desktop pins columns, but only seeds them once the agents
  // view has loaded so the seed reflects real recency, not the fetch order.
  const ordered = twoColumn && (view || columns.size) ? pinnedOrder(globalOrder, columns) : globalOrder
  return (
    <>
      {ordered.map((p) => (
        <ProjectCard key={p.name} p={p} />
      ))}
    </>
  )
}

// Reachability of the remote bridge that owns `repo`: the bridge explicitly
// listing it, else the catch-all (repos:[]). Falls back to the legacy
// `workstationReachable` when an old server omits `bridges`.
function bridgeReachableFor(
  view: { workstationReachable: boolean; bridges?: { reachable: boolean; repos: string[] }[] },
  repo: string,
): boolean {
  if (!view.bridges) return view.workstationReachable
  const owner =
    view.bridges.find((b) => b.repos.includes(repo)) || view.bridges.find((b) => b.repos.length === 0)
  return owner ? owner.reachable : false
}

function ProjectCard({ p }: { p: Project }) {
  // Dev-agent binding. A project opts into its agent surface by declaring
  // `agent_repo` (its bridge repos.json key) in frontmatter — that explicit flag
  // is both the key the card spawns/filters with and the signal that this project
  // is agent-enabled (the card can't read the bridge's gitignored repos.json to
  // auto-detect mapping). One shared poll feeds every card.
  const { view, kick } = useAgents()
  const agentKey = p.agentRepo
  // Cumulative dev-agent working time this month for this project's repo (the
  // box-local timings roll-up, via the shared agents view; absent → 0).
  const monthMs = (agentKey && view?.monthRunMsByRepo?.[agentKey]) || 0
  // Per-bridge reachability: a box-local repo is always up; everything else
  // depends on the bridge that owns the repo (the workstation by default). So a
  // project's section shows even when another bridge is offline, as long as its
  // own bridge is up.
  const repoReachable =
    !!view && !!agentKey && (view.localRepos.includes(agentKey) || bridgeReachableFor(view, agentKey))

  // The status dot reflects this project's dev-agent integration, NOT git repo
  // reachability: green = integration set up and its bridge is up, amber = set
  // up but the bridge is currently offline, red = no integration configured
  // (the project never declared an `agent_repo`).
  const dotState = !agentKey ? 'down' : repoReachable ? 'ok' : 'warn'
  const dotTitle = !agentKey
    ? 'no dev agents integration'
    : repoReachable
      ? 'dev agents integration active'
      : 'dev agents integration set up — bridge offline'
  const dot = <span className={`proj-dot proj-dot--${dotState}`} title={dotTitle} />

  return (
    <Card title={p.name} titleHref={p.github || undefined} className={SPAN} actions={dot}>
      <div className="proj-card">
        <div className="proj-goals">
          {p.now ? (
            <div className="proj-kv">
              <span className="proj-kv__k proj-kv__k--now">Now</span>
              <span className="proj-kv__v proj-kv__v--now">{p.now}</span>
            </div>
          ) : null}
          {p.goal ? (
            <div className="proj-kv">
              <span className="proj-kv__k proj-kv__k--goal">Goal</span>
              <span className="proj-kv__v proj-kv__v--goal">{p.goal}</span>
            </div>
          ) : null}
        </div>

        {p.repo && !p.commit ? (
          <div className="proj-commit proj-commit--down">repo not reachable: {p.repo}</div>
        ) : p.commit ? (
          <div className="proj-commit">
            <span className="proj-commit__hash tnum">{p.commit.hash}</span>
            <span className="proj-commit__subject">{p.commit.subject}</span>
            <span className="proj-commit__when tnum" title={p.commit.committedAt}>
              {p.commit.relative}
            </span>
          </div>
        ) : null}

        {agentKey || p.tag ? (
          <div className="proj-related">
            {agentKey ? (
              <>
                <span className="proj-related__n tnum">{monthMs > 0 ? fmtDur(monthMs) : '—'}</span>
                <span className="proj-related__l">agent time · this month</span>
              </>
            ) : null}
            {p.tag ? <span className="proj-related__tag">#{p.tag}</span> : null}
          </div>
        ) : null}

        {repoReachable ? (
          <div className="proj-agents">
            <div className="proj-agents__head hud-label">
              Dev agents · <span className="proj-agents__key">{agentKey}</span>
            </div>
            <AgentList sessions={view!.sessions} repo={agentKey} github={p.github} scheduled={view!.scheduled} onChanged={kick} />
          </div>
        ) : null}
      </div>
    </Card>
  )
}
