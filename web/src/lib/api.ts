/* ------------------------------------------------------------------ *
 * Central API layer. ONE place defines where data comes from.
 *
 * Interim (Phase D): the Vite dev plugin (vite-dev-api.ts) serves these
 * /api/* routes read-only from the vault. Phase G replaces that with the
 * Express API behind Caddy on the SAME /api/* contract — so going live
 * needs no client change beyond, at most, this constant.
 * ------------------------------------------------------------------ */
export const API_BASE = '/api'

/* --- Data shapes (the API response shapes) -------------------- */
export type Trend = 'up' | 'down' | 'neutral'
export interface Stat {
  label: string
  value: string
  trend?: Trend
  /** Optional group name — stats sharing one cluster into a headed frame on the
   *  Scorecard; stats without it fall into a leading headerless frame. */
  group?: string
}
export interface Scorecard {
  generated: string
  stats: Stat[]
}

export interface CalEvent {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  location?: string
  calendar?: string
  url?: string
}
export interface Calendar {
  generated: string
  events: CalEvent[]
}

export interface GmailItem {
  id: string
  /** Which inbox this came from — "Personal" | "Work". */
  account: string
  /** The inbox's address — used to deep-link into the right Gmail account. */
  accountEmail: string
  subject: string
  from: string
  date: string // YYYY-MM-DD
  time?: string // HH:MM (24-hour, local)
  snippet: string
  threadId: string
}
export interface GmailHighlights {
  generated: string
  items: GmailItem[]
}

export type Health = 'green' | 'amber' | 'red'
export interface Engagement {
  id: string
  name: string
  stage: 'Active' | 'Planning' | 'Blocked' | 'Done' | string
  lastActivity?: string
  blocked?: boolean
  blocker?: string
  health: Health
}

export interface HeatDay {
  date: string
  count: number
}
export interface Heatmap {
  generated: string
  days: HeatDay[]
}

export interface ActionItem {
  id: string
  suggestion: string
  skill?: string
  args?: Record<string, unknown>
  priority?: number
}

export interface Skill {
  id: string
  label: string
  icon?: string
  type: 'skill' | 'session'
  command?: string
  project?: string
  args?: Record<string, unknown>
}

export interface WikiPage {
  title: string
  path: string
  folder: string
  mtime?: number
}

export interface WikiNode {
  id: string
  title: string
  path: string
  type: string
  degree: number
  status?: string | null // tasks: lifecycle status (inbox/next/doing/waiting/done)
  due?: string | null // tasks: due date (YYYY-MM-DD)
}
export interface WikiLink {
  source: string
  target: string
  type?: string // edge key ('depends_on', …) or 'link' for an untyped [[wikilink]]
  family?: string // semantic family for colour + lensing (see EDGE_FAMILIES)
  directed?: boolean // draw an arrowhead source → target
}
export interface WikiGraph {
  generated: string
  nodes: WikiNode[]
  links: WikiLink[]
}

export type HitType = 'wiki' | 'note' | 'data'
export interface SearchHit {
  type: HitType
  title: string
  subtitle: string
  path: string | null
  snippet: string
  score: number
}

export interface NoteRef {
  name: string
  path: string
  title: string
}

export interface NewsStory {
  id: number
  title: string
  url: string | null
  points: number
  comments: number
  author: string
  hnUrl: string
}
export interface NewsData {
  generated: string
  source: string
  stories: NewsStory[]
}

export interface HeiseStory {
  id: number
  title: string
  url: string
  published: string
  author: string
  summary: string
}
export interface HeiseNewsData {
  generated: string
  source: string
  stories: HeiseStory[]
}

export interface ProjectCommit {
  hash: string
  subject: string
  relative: string
  author: string
  committedAt: string
}
export interface Project {
  name: string
  tag: string
  /** Bridge repos.json key + opt-in flag for this project's dashboard agent
   *  surface. Empty = no agent card. */
  agentRepo: string
  /** This project IS the app on this box → show the self-deploy button. */
  selfDeploy: boolean
  repo: string
  github: string
  now: string
  goal: string
  path: string
  reachable: boolean
  commit: ProjectCommit | null
  relatedSources: number
}

// Bundled Command Center payload (GET /api/dashboard) — one request feeds all
// the polling cards instead of each fetching its own endpoint.
export interface DashboardData {
  scorecard: Scorecard | null
  calendar: Calendar | null
  gmailHighlights: GmailHighlights | null
  engagements: Engagement[] | null
  heatmap: Heatmap | null
  actions: ActionItem[] | null
  skills: Skill[] | null
  briefings: NoteRef[] | null
  wikiPages: WikiPage[] | null
}

// Claude subscription usage (GET /api/usage) — the 5-hour rolling + weekly
// limits shown by Claude Code's /usage, for the hero budget readout.
export interface UsageWindow {
  /** Percent of the limit consumed (0–100). */
  utilization: number
  /** ISO timestamp when this window resets. */
  resetsAt: string
}
export interface ClaudeUsage {
  ok: boolean
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
}

// Live host memory (GET /api/host) — RAM + swap, for the hero readout under
// the Claude limits, so box memory pressure is visible at a glance.
export interface HostGauge {
  /** Percent used (0–100). */
  pct: number
  usedMb: number
  totalMb: number
}
export interface HostStats {
  ok: boolean
  mem: HostGauge
  /** null when the box has no swap configured. */
  swap: HostGauge | null
}

/* --- Fetch helpers: return null/[] on failure so cards stay graceful */
async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

async function getText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return await res.text()
  } catch {
    return null
  }
}

export function fetchData<T>(name: string): Promise<T | null> {
  return getJson<T>(`${API_BASE}/data/${name}`)
}

export function fetchDashboard(): Promise<DashboardData | null> {
  return getJson<DashboardData>(`${API_BASE}/dashboard`)
}

export function fetchUsage(): Promise<ClaudeUsage | null> {
  return getJson<ClaudeUsage>(`${API_BASE}/usage`)
}

export function fetchHost(): Promise<HostStats | null> {
  return getJson<HostStats>(`${API_BASE}/host`)
}

/** Append a ?vault=/&vault= selector to a read path; absent → the configured default vault. */
function vaultQuery(url: string, vault?: string): string {
  if (!vault) return url
  return url + (url.includes('?') ? '&' : '?') + `vault=${encodeURIComponent(vault)}`
}

/** Is this a TYPED, queryable Atlas vault (the main `atlas` or a sibling like
 *  `a sibling vault`)? The dashboard's typed surfaces — the task-write Kanban, the
 *  reader's task-edit affordances — exist only here; plain vaults (work, recipes)
 *  are read-only. Mirrors the API's `isTypedVault` (Wiki/Legend.md presence) via
 *  the `atlas` naming convention every typed sibling follows. */
export const isTypedVault = (vault?: string): boolean => !!vault && vault.startsWith('atlas')

export async function fetchWikiIndex(vault?: string): Promise<string | null> {
  return getText(vaultQuery(`${API_BASE}/wiki/index`, vault))
}
export async function fetchWikiLog(vault?: string): Promise<string | null> {
  return getText(vaultQuery(`${API_BASE}/wiki/log`, vault))
}
export async function fetchWikiPages(vault?: string): Promise<WikiPage[]> {
  const r = await getJson<{ items: WikiPage[] }>(vaultQuery(`${API_BASE}/wiki/pages`, vault))
  return r?.items ?? []
}
export function fetchWikiGraph(vault?: string): Promise<WikiGraph | null> {
  return getJson<WikiGraph>(vaultQuery(`${API_BASE}/wiki/graph`, vault))
}

export interface AtlasTask {
  path: string
  title: string
  /** Lifecycle status (inbox|next|doing|waiting|done); '' if unset. */
  status: string
  /** Priority (high|medium|low); null if unset. The Kanban flames high. */
  priority: string | null
  /** Provenance facet (the Legend `source` enum, e.g. "email" for tasks filed by
   *  the hourly email pass); null if unset. */
  source: string | null
  due: string | null
  done: string | null
  created: string | null
  updated: string | null
  /** First for_project link target (basename), for display. */
  project: string | null
  /** First for_project_idea link target — an exploratory idea hub, not yet a
   *  committed project (Legend node type `project-idea`). */
  projectIdea: string | null
  area: string | null
  owes: string[]
  dependsOn: string[]
  tags: string[]
  mtime: number
}
/** type:task notes in a vault's Tasks/ folder — the Kanban source (vault-aware). */
export async function fetchTasks(vault?: string): Promise<AtlasTask[]> {
  const r = await getJson<{ tasks: AtlasTask[] }>(vaultQuery(`${API_BASE}/tasks`, vault))
  return r?.tasks ?? []
}
/** Restage a task (Kanban drag) — persist its new status to the Atlas via the
 *  single-writer commit queue. The bearer is injected server-side (Caddy); the
 *  browser holds none. `path` is the task's vault-relative Tasks/<slug>.md. */
export async function moveTask(
  path: string,
  status: string,
  vault?: string,
): Promise<{ ok: boolean; warning?: string; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/tasks/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, status, vault }),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; warning?: string; error?: string }
    if (!res.ok) return { ok: false, error: data.error || data.warning || `HTTP ${res.status}` }
    return { ok: data.ok !== false, warning: data.warning }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}
/** A task's project / project-idea / area selection. A name sets that edge; ''
 *  clears it; an omitted field is left untouched. The Kanban keeps one colour per
 *  card, so a pick sets one kind and clears the others. */
export interface TaskCategorySel {
  project?: string
  projectIdea?: string
  area?: string
}

/** Create a new Atlas task (Kanban "+ New task") — writes a type:task note to
 *  Tasks/ (status: inbox, optional `due`, optional free-text `body` below the
 *  title) and commits it via the single-writer commit queue. The bearer is
 *  injected server-side (Caddy); the browser holds none. With no `category`, the
 *  server infers a project/area from the title; pass one to set it explicitly.
 *  Returns the new task's path + resolved project/area on success. */
export async function createTask(
  title: string,
  due?: string,
  category?: TaskCategorySel,
  body?: string,
  vault?: string,
): Promise<{
  ok: boolean
  path?: string
  project?: string | null
  projectIdea?: string | null
  area?: string | null
  warning?: string
  error?: string
}> {
  try {
    const res = await fetch(`${API_BASE}/tasks/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title,
        due: due || undefined,
        body: body || undefined,
        project: category?.project || undefined,
        projectIdea: category?.projectIdea || undefined,
        area: category?.area || undefined,
        vault,
      }),
    })
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      path?: string
      project?: string | null
      projectIdea?: string | null
      area?: string | null
      warning?: string
      error?: string
    }
    if (!res.ok) return { ok: false, error: data.error || data.warning || `HTTP ${res.status}` }
    return {
      ok: data.ok !== false,
      path: data.path,
      project: data.project ?? null,
      projectIdea: data.projectIdea ?? null,
      area: data.area ?? null,
      warning: data.warning,
    }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** Set (or clear, when `due` is '') an Atlas task's due date — rewrites its
 *  `due:` frontmatter and commits via the single-writer commit queue. The bearer
 *  is injected server-side (Caddy); the browser holds none. `path` is the task's
 *  vault-relative Tasks/<slug>.md. */
export async function setTaskDue(
  path: string,
  due: string,
  vault?: string,
): Promise<{ ok: boolean; warning?: string; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/tasks/due`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, due, vault }),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; warning?: string; error?: string }
    if (!res.ok) return { ok: false, error: data.error || data.warning || `HTTP ${res.status}` }
    return { ok: data.ok !== false, warning: data.warning }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}
/** Set (or clear, when `priority` is '') an Atlas task's priority — rewrites its
 *  `priority:` frontmatter (high|medium|low) and commits via the single-writer
 *  commit queue. The Kanban flame toggle sends 'high' to flag a card and '' to
 *  clear it. The bearer is injected server-side (Caddy); the browser holds none. */
export async function setTaskPriority(
  path: string,
  priority: string,
  vault?: string,
): Promise<{ ok: boolean; warning?: string; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/tasks/priority`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, priority, vault }),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; warning?: string; error?: string }
    if (!res.ok) return { ok: false, error: data.error || data.warning || `HTTP ${res.status}` }
    return { ok: data.ok !== false, warning: data.warning }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}
/** Replace an Atlas task's body (the description below the title) — rewrites
 *  everything after the frontmatter and commits via the single-writer commit
 *  queue. The bearer is injected server-side (Caddy); the browser holds none.
 *  `path` is the task's vault-relative Tasks/<slug>.md. */
export async function setTaskBody(
  path: string,
  body: string,
  vault?: string,
): Promise<{ ok: boolean; warning?: string; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/tasks/body`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, body, vault }),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; warning?: string; error?: string }
    if (!res.ok) return { ok: false, error: data.error || data.warning || `HTTP ${res.status}` }
    return { ok: data.ok !== false, warning: data.warning }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}
/** Set (or correct) an Atlas task's project/area — rewrites its `for_project` /
 *  `area` frontmatter and commits via the single-writer commit queue. Sends both
 *  fields so a pick sets one and clears the other (one colour per card). The
 *  bearer is injected server-side (Caddy); the browser holds none. */
export async function setTaskCategory(
  path: string,
  category: TaskCategorySel,
  vault?: string,
): Promise<{ ok: boolean; warning?: string; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/tasks/category`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, ...category, vault }),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; warning?: string; error?: string }
    if (!res.ok) return { ok: false, error: data.error || data.warning || `HTTP ${res.status}` }
    return { ok: data.ok !== false, warning: data.warning }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** The project/project-idea/area vocabulary in a vault — what the Kanban picker
 *  offers and inference matches against. Projects come from Wiki/Projects +
 *  for_project edges; project-ideas from for_project_idea edges; areas from
 *  `area` edges (vault-aware). */
export interface TaskCategories {
  projects: string[]
  projectIdeas: string[]
  areas: string[]
}
export async function fetchTaskCategories(vault?: string): Promise<TaskCategories | null> {
  return getJson<TaskCategories>(vaultQuery(`${API_BASE}/tasks/categories`, vault))
}

/** Resolve a typed/picked picker value into a task category selection. The
 *  picker speaks `project:Name` / `project-idea:Name` / `area:Name`:
 *   - an explicit `project:`/`project-idea:`/`area:` prefix sets that kind (the
 *     name is matched to an existing entry case-insensitively, else added NEW);
 *   - a bare value matching a known project/project-idea/area resolves to it;
 *   - any other bare text → a new area (the lightweight "just add an area" path);
 *   - empty → cleared.
 *  Always returns all three fields so the chosen kind is set and the others
 *  cleared (one colour per card). */
export function resolveCategory(value: string, cats: TaskCategories | null): TaskCategorySel {
  const v = value.trim()
  const empty: TaskCategorySel = { project: '', projectIdea: '', area: '' }
  if (!v) return empty
  const canon = (name: string, list?: string[]) =>
    list?.find((x) => x.toLowerCase() === name.toLowerCase()) ?? name
  // `project-idea` must precede `project` in the alternation (longer prefix wins).
  const m = v.match(/^(project-idea|project|area)\s*:(.*)$/i)
  if (m) {
    const name = m[2].trim()
    if (!name) return empty // bare "project:" / "project-idea:" / "area:" → nothing yet
    const kind = m[1].toLowerCase()
    if (kind === 'project') return { ...empty, project: canon(name, cats?.projects) }
    if (kind === 'project-idea') return { ...empty, projectIdea: canon(name, cats?.projectIdeas) }
    return { ...empty, area: canon(name, cats?.areas) }
  }
  const p = cats?.projects.find((x) => x.toLowerCase() === v.toLowerCase())
  if (p) return { ...empty, project: p }
  const pi = cats?.projectIdeas.find((x) => x.toLowerCase() === v.toLowerCase())
  if (pi) return { ...empty, projectIdea: pi }
  const a = cats?.areas.find((x) => x.toLowerCase() === v.toLowerCase())
  return { ...empty, area: a ?? v }
}

/** A category's picker display string — the `project:Name` / `project-idea:Name`
 *  / `area:Name` form the picker reads back (project wins, then project-idea;
 *  '' when none is set). */
export function displayCategory(
  project?: string | null,
  projectIdea?: string | null,
  area?: string | null,
): string {
  if (project) return `project:${project}`
  if (projectIdea) return `project-idea:${projectIdea}`
  if (area) return `area:${area}`
  return ''
}

export async function fetchProjects(): Promise<Project[]> {
  const r = await getJson<{ projects: Project[] }>(`${API_BASE}/projects`)
  return r?.projects ?? []
}

/* --- Atlas typed query (relational + temporal) --------------------- *
 * The payoff of the typed layer (Guide §7): exact filters/traversals over
 * typed edges, node types, status, and dates — the counterpart of the fuzzy
 * full-text search. Powers the Atlas tab's Relational Lenses card. */
export type AtlasDateWindow = 'overdue' | 'today' | 'next_7d' | 'this_week' | 'this_month' | 'past_7d'
export interface AtlasDateFilter {
  before?: string
  after?: string
  on?: string
  window?: AtlasDateWindow
}
export interface AtlasQuerySpec {
  type?: string | string[]
  tag?: string | string[]
  status?: string | string[]
  priority?: string | string[]
  /** Provenance facet (the Legend `source` enum, e.g. "email"). */
  source?: string | string[]
  /** Forward typed-edge filters (snake_case keys), AND-combined. */
  edges?: { key: string; target?: string }[]
  /** Pages with ANY typed edge pointing at this target. */
  linkedTo?: string
  due?: AtlasDateFilter
  last_contact?: AtlasDateFilter
  created?: AtlasDateFilter
  updated?: AtlasDateFilter
  done?: AtlasDateFilter
  /** Personal contacts where last_contact + cadence_days < today. */
  past_cadence?: boolean
  /** Full-text filter applied within the typed-filtered set (hybrid). */
  text?: string
  sort?: string
  limit?: number
}
export interface AtlasQueryRow {
  path: string
  title: string
  type: string
  tags?: string[]
  status?: string
  priority?: string
  /** Present date fields, e.g. { due: "2026-06-20", last_contact: "…" }. */
  dates?: Record<string, string>
  /** Present typed edges, e.g. { for_project: ["My-Project"], area: ["Health"] }. */
  edges?: Record<string, string[]>
  /** Days past the desired contact cadence (only on past_cadence queries). */
  daysOverdue?: number
  snippet?: string
}
export interface AtlasQueryResult {
  generated: string
  count: number
  /** True when more rows matched than the limit returned. */
  truncated: boolean
  pages: AtlasQueryRow[]
}
/** Run a typed relational/temporal query against a vault (default: atlas). A read,
 *  transported via POST because the query spec is a structured JSON body. */
export async function queryAtlas(spec: AtlasQuerySpec, vault = 'atlas'): Promise<AtlasQueryResult | null> {
  try {
    const res = await fetch(vaultQuery(`${API_BASE}/atlas/query`, vault), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(spec),
    })
    if (!res.ok) return null
    return (await res.json()) as AtlasQueryResult
  } catch {
    return null
  }
}

/* --- Atlas Type Registry ------------------------------------------- *
 * A live inventory of a vault's typed vocabulary (node types, edge keys,
 * property keys) actually in use, cross-referenced with its Legend. The Atlas
 * tab's Type Registry card renders it and lets the operator flag suspected
 * duplicates (a server-side annotation, not a write into the Atlas repo). */
export type AtlasTypeCategoryKey = 'node' | 'edge' | 'property'
export interface AtlasTypeEntry {
  /** The type value / edge key / property key. */
  name: string
  /** How many pages (Wiki/ + Tasks/) use it; 0 = declared in the Legend but unused. */
  count: number
  /** Present in the Legend's registry for this category. */
  registered: boolean
  /** A ★ fixed-core key (used verbatim, no synonyms). */
  core: boolean
  /** The Legend's "Means" description; '' when unregistered. */
  description: string
  /** Up to 5 example page paths using it (for the count tooltip). */
  examples: string[]
  /** Operator-set "suspected duplicate" flag. */
  flagged: boolean
}
export interface AtlasTypeCategory {
  key: AtlasTypeCategoryKey
  label: string
  entries: AtlasTypeEntry[]
}
export interface AtlasTypes {
  generated: string
  /** Vault-relative path of the Legend page, for the card's link. */
  legendPath: string
  /** False when the vault has no Wiki/Legend.md (everything reads as unregistered). */
  hasLegend: boolean
  categories: AtlasTypeCategory[]
}
/** The live type/edge/property inventory for a vault (vault-aware). */
export async function fetchAtlasTypes(vault?: string): Promise<AtlasTypes | null> {
  return getJson<AtlasTypes>(vaultQuery(`${API_BASE}/atlas/types`, vault))
}
/** Toggle the operator's "suspected duplicate" flag on a Type Registry entry.
 *  Server-side metadata only (not committed to the Atlas). Bearer injected
 *  server-side (Caddy); the browser holds none. */
export async function flagAtlasType(body: {
  vault?: string
  category: AtlasTypeCategoryKey
  name: string
  flagged: boolean
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/atlas/type-flag`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` }
    return { ok: data.ok !== false }
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

export async function fetchNote(relPath: string, vault?: string): Promise<string | null> {
  return getText(vaultQuery(`${API_BASE}/note?path=${encodeURIComponent(relPath)}`, vault))
}
/** Raw HTML of an experimental HTML wiki page (rendered via iframe srcdoc). */
export async function fetchWikiHtml(relPath: string, vault?: string): Promise<string | null> {
  return getText(vaultQuery(`${API_BASE}/wiki-html?path=${encodeURIComponent(relPath)}`, vault))
}
export async function fetchNotes(folder: string): Promise<NoteRef[]> {
  const r = await getJson<{ items: NoteRef[] }>(
    `${API_BASE}/notes?folder=${encodeURIComponent(folder)}`,
  )
  return r?.items ?? []
}
export async function searchVault(q: string, vault?: string): Promise<SearchHit[]> {
  const r = await getJson<{ items: SearchHit[] }>(
    vaultQuery(`${API_BASE}/search?q=${encodeURIComponent(q)}`, vault),
  )
  return r?.items ?? []
}

/** Fire the server-side GitHub data refresh (cooldown-guarded server-side). */
export async function refreshGithub(): Promise<void> {
  try {
    await fetch(`${API_BASE}/refresh/github`, { method: 'POST' })
  } catch {
    /* best-effort; data still served from the last refresh */
  }
}


/* --- Dev-agent control -------------------------- *
 * Drive Claude Code sessions in the workstation's dev containers. The
 * dashboard proxies these to the host `agent-bridge` over the Tailscale
 * tailnet (bearer injected server-side, like capture/research). Until that
 * bridge lands, the dev API serves an in-memory mock on this SAME contract,
 * so the card is built and exercised first (per the card-first slice).
 */
export type AgentStatus = 'running' | 'idle' | 'done' | 'error' | 'dormant'
export interface AgentSession {
  id: string
  /** 'dev' (worktree + branch on a repo), 'knowledge' (a chat over a vault,
   * spawned from the Knowledge Base / Atlas tab — no branch), 'atlas' (a
   * short-lived Atlas worker — only the STANDALONE cleanup-ingest one surfaces,
   * as its own overview node), or 'atlas-pass' (one of the Atlas's autonomous
   * background passes — the hourly email scan / daily task triage — surfaced
   * while it runs and nested under the Atlas hub in the constellation; read-only,
   * never carries executor controls). Sessions from the workstation bridge
   * predate the field — treat absent as 'dev'. */
  kind?: 'dev' | 'knowledge' | 'atlas' | 'atlas-pass'
  /** Knowledge chats only: which vault this chat is grounded in (`vault.key`).
   * Absent on dev agents and on pre-field knowledge chats (legacy records that
   * predate the field — those grounded in the 'work' vault). The Atlas tab's chats carry 'atlas'. */
  vault?: string
  task: string
  /** Short display title generated at spawn (a `claude -p` haiku pass over the
   * task prompt), decorated onto the session by the dashboard proxy. Absent
   * until generation lands (or when it failed) — fall back to `task`. */
  title?: string
  /** Ultra-short tag (~1-2 words, ≤18 chars) generated alongside `title` in the
   * same spawn-time pass, for the compact agents overview / narrow & mobile
   * views. Absent until generation lands — fall back to `title`, then `task`. */
  micro?: string
  repo: string
  /** Each dev agent runs on its own `agent/<task>` worktree branch (isolation).
   * Knowledge agents live in the vault itself and have none. */
  branch?: string
  status: AgentStatus
  /** Tail of the session's output (full output is a later /output?id= fetch). */
  lastOutput: string
  /** Idle AND parked on something the respond toolbar can drive. `menuKind`
   * says which, so the card shows the right confirm button:
   *  - 'choice'   → numbered menu (plan/permission/trust); confirm with Enter
   *  - 'complete' → `@`/`/` autocomplete; insert+send (Tab then Enter)
   *  - null       → no menu (just idle at the prompt). `menu` is `!!menuKind`. */
  menu?: boolean
  menuKind?: 'choice' | 'complete' | null
  /** A pending choice menu's numbered options, parsed from the TUI pane server-
   * side (menu.mjs), and which option the `❯` highlight currently sits on. The
   * chat view renders these as clickable buttons. Absent on a bridge that
   * predates the field (the chat view then points at the terminal view). */
  menuOptions?: { n: number; text: string }[]
  menuHighlighted?: number
  /** The prompt/question text the choice menu shows above its options (parsed
   * from the TUI pane, menu.mjs), so the chat view can display WHAT is being
   * asked — not just bare answer buttons. Absent when no prompt was captured. */
  menuQuestion?: string
  startedAt: string
  /** Knowledge chat closing gracefully (✕ pressed): it's running a final
   * wrap-up turn that works unsaved insights into the vault, and disappears
   * when that turn ends. A second ✕ force-closes. */
  closing?: boolean
  /** The persisted box-local lifecycle state (spawned · working · ship_ready ·
   * shipping · shipped · ingesting · ingested · reaping · needs_attention). The
   * card switches on `closing`/`closePhase`/`shipState`/`shipQueue` (above), not
   * on this — it's surfaced for observability/debugging. Absent for remote agents. */
  lifecycle?: string
  /** Box dev agent paired with an Atlas knowledge worker: the card shows a 📚
   * chip and the ✕ is a GRACEFUL close (recap → the worker logs it to the Atlas). */
  atlasWorker?: boolean
  /** The session id of the agent that SPAWNED this one (the Atlas orchestrator,
   * via its spawn_agent tool). Absent = operator-spawned (a root). Drives the
   * spawn-lineage edges in the Agent constellation (AgentGraph). */
  spawnedBy?: string
  /** While a paired dev agent is closing: 'recap' (it's writing its session recap)
   * → 'ingest' (the worker is folding it into the Atlas). */
  closePhase?: 'recap' | 'ingest'
  /** Prompts parked to send when this session next goes idle (queued while it was
   * running), in FIFO order — delivered one per turn. The card shows each as a
   * cancellable chip; `images` is the attachment count. `summary` is a one-sentence
   * gist of an Atlas briefing (debug aid — lets the operator see what the brief
   * surfaced). Absent when nothing is queued. (A bridge predating the multi-queue
   * upgrade may still send a single object — the card's `queuedList` tolerates both.) */
  queued?: Array<{ text: string; images: number; kind?: 'atlas-brief'; summary?: string }>
  /** Approx context-window fill from the agent's latest turn — `contextTokens`
   * of `contextWindow` tokens. Box-local agents only (the box can read their
   * transcripts); omitted when no transcript is readable, so the bar is optional. */
  contextTokens?: number
  contextWindow?: number
  /** Spawn-time picks: the resolved Claude Code model ID (e.g.
   * `claude-opus-4-8[1m]`) and effort level (`high`/`xhigh`/`max`). Shown as a
   * small label by the context meter. Absent on sessions spawned before the
   * field landed. */
  model?: string
  effort?: string
  /** Spawn-time t-shirt size of the task (S/M/L), estimated by the title agent —
   * a coarse "how much work" tag that also sharpens the run-time estimate
   * (durations bucket on it). Absent until classified / on older sessions. */
  size?: string
  /** Time tracking (box-local agents directly, workstation agents from the bridge
   * poll's phase shadows — see agent-timings.mjs). `phase` is
   * the current phase: 'run' (busy), 'wait' (idle, your turn), or 'done'. While
   * running, the card ticks `runStartedAt`→now against the rough `runEstimateMs`
   * (recency-weighted from past runs in this kind·model·effort·size bucket) and
   * its `runEstimateLoMs`–`runEstimateHiMs` p25–p75 "typically" band; the bar
   * warms amber once past the band. When idle it freezes and shows `lastRunMs`
   * ("last run 4m"). `endedAt` freezes the "alive" clock once the agent is done.
   * The band fields are absent until a bucket has enough history (cold start). */
  phase?: 'run' | 'wait' | 'done'
  runStartedAt?: string
  runEstimateMs?: number
  runEstimateLoMs?: number
  runEstimateHiMs?: number
  lastRunMs?: number
  endedAt?: string
  /** Sub-agents this agent spawned via Claude Code's Task tool,
   * parsed from its transcript — `active` is still-running (no result yet).
   * `micro` is the short glance-form tag (≤18 chars), derived from `label` by the
   * same haiku pass dev agents use; absent until it lands — fall back to `label`.
   * Box-local agents only (needs the on-disk transcript); absent otherwise. */
  subAgents?: { label: string; micro?: string; active: boolean }[]
  /** Background jobs this agent launched (Bash run_in_background — detached
   * processes, e.g. a long crawl), parsed from its transcript: 'running' until
   * the harness's completion notification flips it to 'done' (exit 0) or
   * 'failed'. `micro` is the short glance-form tag (as for `subAgents`); `sub` is
   * set when a SUB-AGENT spawned the job — the owner's index into `subAgents`.
   * Box-local agents only; absent otherwise. */
  bgJobs?: { label: string; micro?: string; status: 'running' | 'done' | 'failed'; sub?: number }[]
  /** Live stats the agent publishes itself while it works — its long-running
   * background scripts rewrite a small JSON file with their latest numbers,
   * and the box samples it, accumulating each counter's history. Rendered as a
   * strip of mini-tiles: a plain number is a counter with an area sparkline of
   * `points` (the scorecard's cumulative-contributions look, shrunk); an entry
   * with `max` is a completion bar (value of max). Temporary by construction
   * (the file is per-session; deleting it clears the strip). Box-local agents
   * sample their own file; workstation agents publish it in their container and
   * the bridge surfaces the latest values, which the box accumulates the same way. */
  stats?: { label: string; value: number; max?: number; points?: number[] }[]
  /** Ship state the agent signaled itself, via marker lines in its replies:
   * 'ready' (it judges the branch mergeable → the Ship button highlights) or
   * 'shipped' (its PR is merged → the Ship button becomes a check). `shipInfo`
   * carries the SHIPPED detail (PR number + SHA). Scanned off the transcript by
   * both executors — box-local agents AND workstation agents (the bridge scans
   * the container transcript the same way). */
  shipState?: 'ready' | 'shipped'
  shipInfo?: string
  /** Place in the serial ship train, if the operator queued this agent to ship.
   * `pos` is 1-based; `active` is true while it's the one currently merging (the
   * train advances to the next when it prints ATLAS:SHIPPED). Box-local dev
   * agents get real train positions; a workstation agent has no train, so once
   * the operator ships it the server overlays a synthetic `{ pos: 1, active: true }`
   * (the "shipping…" spinner) until its ATLAS:SHIPPED marker lands. */
  shipQueue?: { pos: number; active: boolean }
  /** Live-app slot: a same-origin path the dashboard can embed in an iframe to
   * show a web app (Streamlit etc.) the agent is running, side-by-side with the
   * transcript in full-screen. `appUp` is whether something is currently serving
   * it (a TCP probe of the slot) — the split pane only appears when up. Dev
   * agents only (a knowledge chat has no app slot). `appPort` is the port the
   * app must bind (loopback :8701 on the box; the session's container-band slot
   * on a workstation) — surfaced so the empty-pane placeholder can name it. */
  appPath?: string
  appPort?: number
  appUp?: boolean
  /** The session's tmux was torn down out from under it (a host/container
   * restart, a kill-server) — status reads 'done' but it never ended its turn.
   * The card shows a "lost" badge instead of a normal "done". */
  interrupted?: boolean
}
export interface AgentsView {
  generated: string
  /** Any bridge serving agents? (the box-local executor OR the workstation bridge). */
  reachable: boolean
  /** Human label for the workstation device. */
  workstation: string
  /** Is the remote workstation bridge answering? (box-local repos are always up.) */
  workstationReachable: boolean
  /** Repo keys served by the box-local executor on the box (always reachable). */
  localRepos: string[]
  /** Per-bridge reachability + the repos each remote bridge owns. The default
   *  (catch-all) bridge has `repos: []` and mirrors `workstation`/
   *  `workstationReachable`. A repo in no bridge's `repos` falls to the catch-all.
   *  `spawnRepos` is the dev-repo keys the bridge ADVERTISES as spawnable (for the
   *  catch-all, from AGENT_BRIDGE_REPOS; surfaced to orchestrators via list_agents).
   *  Absent on older servers → treat as just the workstation. */
  bridges?: { label: string; reachable: boolean; repos: string[]; spawnRepos?: string[] }[]
  /** Persistent recency floor per bridge repo: repo key → ISO timestamp of the
   *  most recent dev-agent spawn. Unlike `sessions` it survives kill/cleanup, so
   *  project cards keep ranking by past agent activity after all a repo's
   *  sessions are closed. */
  lastSpawn: Record<string, string>
  /** Dev-agent working time in the current calendar month, summed per repo (ms).
   *  Project cards show their own `agentRepo`'s total — both box-local repos and
   *  workstation repos (the latter tracked from the bridge poll). Absent → 0. */
  monthRunMsByRepo: Record<string, number>
  sessions: AgentSession[]
  /** Pending scheduled actions (a spawn or a prompt) waiting for their due time —
   *  fired by the server's scheduler. The card renders a prompt job as a ⏱ chip on
   *  its target agent and a spawn job as a pending row. Absent on older servers. */
  scheduled?: ScheduledAction[]
  /** Atlas-originated deep-research jobs (a separate capture-pipeline job, not a
   *  first-class agent session) with their fan-out sub-agents — the Agent
   *  constellation hangs these off the Atlas root so a research run's fan-out shows
   *  even though it lives outside `sessions`. (The autonomous email-scan / task-
   *  triage passes are surfaced separately, as `kind:'atlas-pass'` sessions.)
   *  Absent on older servers. */
  activities?: AgentActivity[]
}

/** A non-session Atlas deep-research job surfaced in the constellation
 *  (GET /api/agents) — carries its fan-out `subAgents`. */
export interface AgentActivity {
  id: string
  type: 'research'
  label: string
  status: 'running' | 'done' | 'error'
  subAgents?: { label: string; active: boolean }[]
}

/** A spawn or prompt the operator scheduled for a future time (GET /api/agents). */
export interface ScheduledAction {
  id: string
  action: 'spawn' | 'prompt'
  /** ISO timestamp it fires at. */
  at: string
  /** Preview text — the task (spawn) or the prompt body (prompt). */
  label: string
  /** Spawn: the target repo (dev agent). */
  repo?: string
  /** Spawn: the target vault (knowledge/Atlas agent). */
  vault?: string
  /** Spawn: 'knowledge' for a vault chat. */
  kind?: 'knowledge'
  /** Prompt: the session id it will be queued to. */
  targetId?: string
}

export interface AgentActionResult {
  ok: boolean
  error?: string
  /** Spawn only: the id of the session just created (e.g. to focus its chat). */
  id?: string
}

/** Bundled view of the workstation's agent sessions (GET /api/agents). */
export function fetchAgents(): Promise<AgentsView | null> {
  return getJson<AgentsView>(`${API_BASE}/agents`)
}

/** Aggregate dev/knowledge-agent time-tracking stats (GET /api/agent-stats) —
 * the corpus behind the Scorecard's "Agent work" group. `daily` is per-day
 * working time over a trailing window (zero-filled, today last and still
 * growing); `accuracy` is actual/estimate per run over time (1.0 = spot on, >1 =
 * ran longer than estimated). Buckets are per kind·model·effort·size, busiest
 * first. */
export interface AgentStatsBucket {
  kind: string
  model: string | null
  effort: string | null
  /** Spawn-time t-shirt size (S/M/L) of the tasks in this bucket; null for runs
   * recorded before sizing landed (or never classified). */
  size: string | null
  count: number
  medianRunMs: number
  estimateMs: number
}
export interface AgentStats {
  totalRunMs: number
  /** Working time in the current local calendar month (all kinds). */
  monthRunMs: number
  daily: { date: string; runMs: number }[]
  accuracy: { at: string; ratio: number }[]
  buckets: AgentStatsBucket[]
}
export function fetchAgentStats(): Promise<AgentStats | null> {
  return getJson<AgentStats>(`${API_BASE}/agent-stats`)
}

/** Fuller output capture for one session (the card's expand-transcript view).
 * Requests the route's max — the backend grows the agent's tmux pane and returns
 * its full visible height (bounded by the pane rows, not this number), so the
 * transcript carries the whole conversation that fits rather than a short tail. */
export async function fetchAgentOutput(id: string, lines = 2000): Promise<string | null> {
  const r = await getJson<{ ok?: boolean; output?: string }>(
    `${API_BASE}/agents/output?id=${encodeURIComponent(id)}&lines=${lines}`,
  )
  return r && typeof r.output === 'string' ? r.output : null
}

/** One reconstructed chat message from an agent's on-disk `.jsonl` history. */
export interface AgentHistoryTool {
  name: string
  summary: string
}
export interface AgentHistoryMessage {
  role: 'user' | 'assistant'
  ts: string | null
  text: string
  tools: AgentHistoryTool[]
  /** Set when this user turn was injected by an Atlas orchestrator steering this
   * agent (not the operator) — the chat view colors it apart. Absent otherwise. */
  source?: 'atlas'
}
export interface AgentHistory {
  messages: AgentHistoryMessage[]
  sessions: number
  truncated: boolean
  /** Opaque fingerprint of the on-disk transcript state — echo it on the next
   * poll and the route answers `unchanged` instead of resending everything. */
  rev?: string
}
/** Full conversation reconstructed from Claude Code's on-disk transcript(s) —
 * the card's chat view. Unlike fetchAgentOutput (the live tmux tail), this is
 * the complete chat, stitched across resume-forked session files. Pass the
 * last result's `rev` when polling: `{ unchanged: true }` means keep what you
 * have (nothing new on disk). */
export async function fetchAgentHistory(
  id: string,
  rev?: string,
): Promise<AgentHistory | { unchanged: true } | null> {
  const r = await getJson<{ ok?: boolean; unchanged?: boolean } & Partial<AgentHistory>>(
    `${API_BASE}/agents/history?id=${encodeURIComponent(id)}${rev ? `&rev=${encodeURIComponent(rev)}` : ''}`,
  )
  if (r?.unchanged) return { unchanged: true }
  return r && Array.isArray(r.messages)
    ? { messages: r.messages, sessions: r.sessions ?? 0, truncated: !!r.truncated, rev: r.rev }
    : null
}

async function agentPost(action: string, body: unknown): Promise<AgentActionResult> {
  try {
    const res = await fetch(`${API_BASE}/agents/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await res.json().catch(() => ({}))) as AgentActionResult
    if (!res.ok) return { ok: false, error: data.error || `HTTP ${res.status}` }
    return data
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

/** Spawn a new agent on a fresh `agent/<task>` worktree branch in `repo` —
 * or, with `kind: 'knowledge'`, a vault-grounded knowledge chat (no repo;
 * `task` is the opening question). */
export function spawnAgent(body: {
  task: string
  repo?: string
  kind?: 'knowledge'
  /** Knowledge chats only: the vault key to chat over (absent → the configured
   * default vault, now the Atlas). The Atlas tab passes 'atlas' to chat over the typed Atlas. */
  vault?: string
  model?: string
  effort?: string
  /** File attachments folded into the spawn prompt (dev agents only) — the same
   * base64 `data:` URLs as a prompt's, capped at the API's AGENT_MAX_IMAGES. */
  images?: AgentAttachment[]
}): Promise<AgentActionResult> {
  return agentPost('spawn', body)
}
/** A file attachment for a prompt — a base64 `data:` URL + its filename. Images
 * and common text/data files (CSV, etc.) are supported; the `images` request
 * field is the historical wire name. */
export interface AgentAttachment {
  name: string
  dataUrl: string
}
/** Send a prompt to a running session, optionally with file attachments. The
 * backend refuses (409 `error: 'menu'`) if a choice menu is pending, so a typed
 * prompt can't silently accept a preselected option; `force` bypasses that guard
 * and is set by the card only after it has dismissed the menu (Esc) itself. */
export function promptAgent(body: {
  id: string
  text: string
  images?: AgentAttachment[]
  force?: boolean
}): Promise<AgentActionResult> {
  return agentPost('prompt', body)
}
/** Interrupt a running session (Esc) and immediately send added context — the
 * work it did this turn is kept, the agent resumes with it plus your input. */
export function interruptAgent(body: {
  id: string
  text: string
  images?: AgentAttachment[]
}): Promise<AgentActionResult> {
  return agentPost('interrupt', body)
}
/** Queue a prompt to be delivered when the session next finishes its current turn. */
export function queueAgent(body: {
  id: string
  text: string
  images?: AgentAttachment[]
}): Promise<AgentActionResult> {
  return agentPost('queue', body)
}
/** Cancel a session's queued prompt(s). With `index`, drop just that one from the
 * FIFO queue; without it, clear the whole queue. */
export function unqueueAgent(id: string, index?: number): Promise<AgentActionResult> {
  return agentPost('unqueue', { id, ...(index !== undefined ? { index } : {}) })
}
/** Enqueue a ship into the SERIAL ship train — box-local agents merge one at a
 * time (each re-syncs onto the previous merge), so several "ready" agents can be
 * shipped at once without racing. `text` is the ship prompt the card built;
 * `position` (1-based) comes back so the card can show the queue place. */
export function shipAgent(
  body: { id: string; text: string },
): Promise<AgentActionResult & { position?: number }> {
  return agentPost('ship', body) as Promise<AgentActionResult & { position?: number }>
}
/** Remove a not-yet-shipping agent from the ship train. */
export function unshipAgent(id: string): Promise<AgentActionResult> {
  return agentPost('unship', { id })
}
/** Send a session's queued prompt now — interrupt the current turn and deliver the
 * parked prompt immediately, instead of waiting for the turn to finish. */
export function sendQueuedNowAgent(id: string): Promise<AgentActionResult> {
  return agentPost('send-now', { id })
}
/** Send navigation/confirm keys to a session's TUI (select a menu option or accept). */
export function sendAgentKeys(body: { id: string; keys: string[] }): Promise<AgentActionResult> {
  return agentPost('keys', body)
}
/** Kill a session (its worktree/branch persist for review). */
export function killAgent(id: string): Promise<AgentActionResult> {
  return agentPost('kill', { id })
}
/** Destructive: kill + remove the worktree + delete the agent/<id> branch. */
export function cleanupAgent(id: string): Promise<AgentActionResult> {
  return agentPost('cleanup', { id })
}
/** Abort an in-flight graceful close (✕/⌦ pressed by mistake) — stop the wrap-up
 * and clear the closing markers; the agent keeps running, nothing is removed. */
export function abortAgentClose(id: string): Promise<AgentActionResult> {
  return agentPost('abort-close', { id })
}
/** Revive a dormant box-local agent — relaunch its Claude session on the existing
 * worktree. Memory-gated server-side (refused if the box is low on RAM). */
export function reviveAgent(id: string): Promise<AgentActionResult> {
  return agentPost('revive', { id })
}
/** Memory-aware bulk revive ("Revive all") — brings back every dormant box-local
 * agent that still fits in RAM. Resolves with { revived, held } on success. */
export function reviveAllAgents(): Promise<AgentActionResult & { revived?: number; held?: number }> {
  return agentPost('revive-all', {}) as Promise<AgentActionResult & { revived?: number; held?: number }>
}

/** Schedule a spawn or a prompt for a future time `at` (ISO). The server stores
 * it and fires it when due — a spawn replays the full spawn flow, a prompt is
 * queued to its target agent. Text-only (no attachments). Returns the job id. */
export function scheduleAgent(body: {
  action: 'spawn' | 'prompt'
  at: string
  /** spawn: { task, repo? , model?, effort?, kind?, vault? } · prompt: { id, text } */
  payload: Record<string, unknown>
}): Promise<AgentActionResult & { at?: string }> {
  return agentPost('schedule', body) as Promise<AgentActionResult & { at?: string }>
}
/** Cancel a pending scheduled job by its id. */
export function unscheduleAgent(id: string): Promise<AgentActionResult> {
  return agentPost('unschedule', { id })
}
