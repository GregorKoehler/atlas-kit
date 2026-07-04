/* ------------------------------------------------------------------ *
 * Parsers for the wiki's machine-readable navigation files
 * (Wiki/index.md catalog + Wiki/log.md timeline). Shared by the
 * Command Center Knowledge teaser and the Knowledge Base tab.
 * ------------------------------------------------------------------ */
export interface IndexEntry {
  target: string
  label: string
  summary: string
}
export interface IndexGroup {
  heading: string
  entries: IndexEntry[]
}
export interface LogEntry {
  date: string
  op: string
  title: string
  link?: string // source page slug, when the entry links to it ([[slug|title]])
}

/* Wiki page categories (folder under Wiki/) → on-palette colors, shared by the
 * knowledge graph and the browse list. See styles/tokens.css. */
export const CATEGORY_COLORS: Record<string, string> = {
  // work vault
  Projects: '#a78bfa', // violet — top-level project hubs stand out
  'Project Ideas': '#e879f9', // magenta — exploratory idea hubs, distinct from committed Projects
  Topics: '#d2a64f', // amber — hubs stand out
  People: '#22d3ee', // cyan
  Organizations: '#2dd4bf', // teal
  Concepts: '#3fb27f', // green
  Sources: '#76909f', // slate
  // recipes vault
  Recipes: '#fb7185', // rose — the dishes themselves stand out
  Techniques: '#38bdf8', // sky — methods / how-to
  Ingredients: '#84cc16', // lime — fresh produce
  Cuisines: '#c084fc', // purple — regional grouping
  // atlas — tasks (Kanban cards) + their not-yet-created project/area hubs
  Tasks: '#fb923c', // orange — task notes as graph nodes
  Unresolved: '#6b7280', // gray — a [[link]] with no page yet (a faint hub)
  Wiki: '#455866',
}
export const CATEGORY_ORDER = [
  'Projects',
  'Project Ideas',
  'Recipes',
  'Techniques',
  'Ingredients',
  'Cuisines',
  'Topics',
  'People',
  'Organizations',
  'Concepts',
  'Sources',
  'Tasks',
  'Unresolved',
]
export const categoryColor = (cat: string) => CATEGORY_COLORS[cat] ?? CATEGORY_COLORS.Wiki

/* ------------------------------------------------------------------ *
 * Typed-edge vocabulary (Atlas). The graph builder (api/read-routes
 * wikiGraph) tags each edge with a `family`; here we give each family a
 * colour + label for edge colouring, the legend and the lens switcher.
 * Untyped prose [[links]] (family 'link') keep the neutral hairline.
 * ------------------------------------------------------------------ */
export interface EdgeFamily {
  key: string
  label: string
  color: string
}
export const EDGE_FAMILIES: EdgeFamily[] = [
  { key: 'dependency', label: 'depends on', color: '#fb923c' }, // orange — blockers/prereqs stand out
  { key: 'obligation', label: 'owes / owed', color: '#f4c049' }, // gold — open obligations
  { key: 'membership', label: 'project / area', color: '#76909f' }, // slate — structural scaffolding, recedes
  { key: 'social', label: 'people', color: '#22d3ee' }, // cyan — works_with / mentor
  { key: 'semantic', label: 'related / extends', color: '#3fb27f' }, // green — idea links
  // a sibling vault' recipe edge families (Wiki/Legend.md). Only surface on the
  // Recipes graph — the edge legend filters to families actually drawn, so these
  // never clutter the Atlas graph (which has no such edges).
  { key: 'ingredients', label: 'ingredients', color: '#84cc16' }, // lime — the core recipe→ingredient join
  { key: 'uses_technique', label: 'technique', color: '#38bdf8' }, // sky — method / how-to
  { key: 'variant_of', label: 'variant of', color: '#fb7185' }, // rose — recipe → base recipe
  { key: 'pairs_with', label: 'pairs with', color: '#c084fc' }, // purple — serving suggestion
  { key: 'substitute_for', label: 'substitute', color: '#2dd4bf' }, // teal — ingredient swap
  { key: 'from_source', label: 'from source', color: '#94a3b8' }, // slate — clipped source / cookbook
  { key: 'recipe', label: 'to-try → dish', color: '#e879f9' }, // magenta — a to-try task's dish
]
const EDGE_FAMILY_COLOR: Record<string, string> = Object.fromEntries(
  EDGE_FAMILIES.map((f) => [f.key, f.color]),
)
// Concrete stroke for a typed family; undefined for untyped 'link' (CSS hairline).
export const edgeColor = (family?: string): string | undefined =>
  family && family !== 'link' ? EDGE_FAMILY_COLOR[family] : undefined

/* Graph lenses — the Relational Lenses card made spatial. Each lens keeps a set of
 * edge families lit and fades the rest; null = show everything. */
export interface GraphLens {
  key: string
  label: string
  families: string[] | null
}
export const GRAPH_LENSES: GraphLens[] = [
  { key: 'all', label: 'Everything', families: null },
  { key: 'dependency', label: 'Dependencies', families: ['dependency'] },
  { key: 'people', label: 'People', families: ['social', 'obligation'] },
  { key: 'projects', label: 'Projects', families: ['membership'] },
  { key: 'ideas', label: 'Ideas', families: ['semantic', 'link'] },
]

/* The recipe graph's lenses — the recipe edge families grouped for the Recipes
 * tab. The graph is ingredient-centric, so recipe↔ingredient is the DEFAULT lens
 * (see graphLensesFor). `semantic` rides the variants/pairings lens so the shared
 * `related` cross-references light up alongside variant_of / pairs_with. */
export const RECIPE_LENSES: GraphLens[] = [
  { key: 'all', label: 'Everything', families: null },
  { key: 'ingredients', label: 'Ingredients', families: ['ingredients', 'substitute_for'] },
  { key: 'techniques', label: 'Techniques', families: ['uses_technique'] },
  { key: 'related', label: 'Variants & pairings', families: ['variant_of', 'pairs_with', 'semantic'] },
  { key: 'sources', label: 'Sources', families: ['from_source'] },
]

/* Pick the lens set + its default lens from the edge families a graph actually
 * carries: a recipe vault (ingredients / uses_technique / …) gets the
 * ingredient-centric RECIPE_LENSES with recipe↔ingredient as the default;
 * everything else (the Atlas, a plain wiki) gets GRAPH_LENSES defaulting to
 * "Everything". Data-driven so the shared WikiGraph stays vault-name-agnostic. */
const RECIPE_FAMILY_KEYS = [
  'ingredients',
  'uses_technique',
  'variant_of',
  'pairs_with',
  'substitute_for',
  'from_source',
  'recipe',
]
export function graphLensesFor(presentFamilies: string[]): { lenses: GraphLens[]; default: GraphLens } {
  if (presentFamilies.some((f) => RECIPE_FAMILY_KEYS.includes(f))) {
    return { lenses: RECIPE_LENSES, default: RECIPE_LENSES.find((l) => l.key === 'ingredients') ?? RECIPE_LENSES[0] }
  }
  return { lenses: GRAPH_LENSES, default: GRAPH_LENSES[0] }
}

/* Node glyph shape by category, so the typed graph reads at a glance: tasks =
 * diamond (action items), project/idea hubs = square, everything else = a colour-
 * coded dot (people cyan, concepts green, …). Shaped nodes keep the shared
 * .wiki-graph__circle class so hover/selection affordances still apply. */
export type NodeShape = 'diamond' | 'square' | 'dot'
export function nodeShape(type: string): NodeShape {
  if (type === 'Tasks') return 'diamond'
  // Recipe dishes are the hubs of the ingredient-centric recipe graph — square,
  // like the Atlas's project/idea hubs, so they read as anchors among the dots.
  if (type === 'Projects' || type === 'Project Ideas' || type === 'Recipes') return 'square'
  return 'dot'
}

export function parseIndex(md: string): IndexGroup[] {
  const groups: IndexGroup[] = []
  let current: IndexGroup | null = null
  for (const raw of md.split('\n')) {
    const head = raw.match(/^#{2,3}\s+(.*)$/)
    if (head) {
      current = { heading: head[1].trim(), entries: [] }
      groups.push(current)
      continue
    }
    const item = raw.match(/^-\s+\[\[([^\]]+)\]\]\s*(?:[—-]\s*)?(.*)$/)
    if (item && current) {
      const target = item[1].split('|')[0].trim()
      const label = (item[1].split('|')[1] ?? item[1].split('|')[0]).trim()
      current.entries.push({ target, label, summary: item[2].trim() })
    }
  }
  return groups.filter((g) => g.entries.length > 0)
}

export function parseLog(md: string): LogEntry[] {
  const entries: LogEntry[] = []
  for (const line of md.split('\n')) {
    const h = line.match(/^##\s+\[([^\]]+)\]\s+(\S+)\s+\|\s+(.*)$/)
    if (!h) continue
    const raw = h[3].trim()
    // Newer entries link the source page: [[slug|Title]] (or [[slug]]). Older
    // ones are a plain title string — fall back to that for display, no link.
    const wl = raw.match(/^\[\[([^\]]+)\]\]$/)
    if (wl) {
      const target = wl[1].split('|')[0].split('#')[0].trim()
      const label = (wl[1].split('|')[1] ?? target).trim()
      entries.push({ date: h[1], op: h[2], title: label, link: target })
    } else {
      entries.push({ date: h[1], op: h[2], title: raw })
    }
  }
  return entries.reverse()
}
