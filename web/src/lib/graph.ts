/* ------------------------------------------------------------------ *
 * Subgraph extraction for the knowledge graph — pure, dependency-free
 * helpers that carve the graph into meaningful, isolatable node sets.
 * The WikiGraph card turns any such set into a "focus" (the set shows,
 * the rest ghosts via the existing --off treatment). Three sources:
 *   - membershipHubs → a project/area and the members assigned to it
 *     (the typed `membership` edges made spatial; #1)
 *   - subgraphFrom   → a node's k-hop neighbourhood (ego focus; #3)
 *   - detectCommunities → emergent clusters (label propagation; #4)
 * ------------------------------------------------------------------ */
import type { WikiNode, WikiLink } from './api'

// Undirected adjacency over the links, optionally restricted to edge families
// (null = every family). Used for both BFS closures and community detection.
function adjacency(links: WikiLink[], families: string[] | null): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>()
  const add = (a: string, b: string) => (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b)
  for (const l of links) {
    if (families && !families.includes(l.family ?? 'link')) continue
    add(l.source, l.target)
    add(l.target, l.source)
  }
  return adj
}

/* BFS closure: the seed plus every node within `depth` hops, following only edges
 * whose family is allowed (treating edges as undirected so a project reaches the
 * tasks that point INTO it). depth 1 over `membership` = "this project's members";
 * depth k over all families = an ego neighbourhood. */
export function subgraphFrom(
  links: WikiLink[],
  seed: string,
  depth: number,
  families: string[] | null,
): Set<string> {
  const adj = adjacency(links, families)
  const seen = new Set<string>([seed])
  let frontier = [seed]
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = []
    for (const id of frontier)
      for (const nb of adj.get(id) ?? [])
        if (!seen.has(nb)) {
          seen.add(nb)
          next.push(nb)
        }
    frontier = next
  }
  return seen
}

export interface Hub {
  id: string
  title: string
  count: number // distinct members assigned via a membership edge
}

/* Project/area hubs that actually gather members: any node that is the TARGET of
 * a `membership` edge (for_project / for_project_idea / area / stakeholders). The
 * count is its distinct members, so the list reads "My-Project · 12". Sorted by member
 * count (desc), then title — the busiest projects first. A declared Projects page
 * nobody references via a typed edge simply doesn't appear (it has no members to
 * isolate); ego-focus still covers it. */
export function membershipHubs(nodes: WikiNode[], links: WikiLink[]): Hub[] {
  const members = new Map<string, Set<string>>()
  for (const l of links) {
    if (l.family !== 'membership') continue
    ;(members.get(l.target) ?? members.set(l.target, new Set()).get(l.target)!).add(l.source)
  }
  const titleOf = new Map(nodes.map((n) => [n.id, n.title] as const))
  return [...members.entries()]
    .map(([id, set]) => ({ id, title: titleOf.get(id) ?? id, count: set.size }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
}

export interface Community {
  id: string // representative (highest-degree) node id — stable label across renders
  label: string // that node's title
  ids: Set<string>
}

/* Emergent clusters via modularity optimization (one Louvain local-moving level).
 * Plain label propagation collapses a dense graph — the Atlas's "related/extends"
 * core hairballs into one mega-cluster (~60% of nodes) that's useless to isolate.
 * Modularity (dense-within / sparse-between) instead splits it into real sub-themes
 * (Transformer Architecture, LLM Inference, AI in Healthcare …). A single level is
 * enough at this scale, so we skip the aggregate-and-recurse phases — minimal code.
 *
 * Deterministic: nodes are visited in array order with strict-greater gain
 * comparisons (first-best wins, ties keep the node where it is), so it's
 * reproducible for an identical graph — no Math.random. A structural change between
 * the 15-min polls can still redraw boundaries. Each cluster is named by its
 * highest-degree member; clusters under `minSize` are dropped, rest largest-first. */
export function detectCommunities(nodes: WikiNode[], links: WikiLink[], minSize = 3): Community[] {
  const N = nodes.length
  const idx = new Map(nodes.map((n, i) => [n.id, i] as const))
  // Integer-indexed weighted adjacency (parallel typed edges between a pair sum).
  const adj: Array<Map<number, number>> = Array.from({ length: N }, () => new Map())
  for (const l of links) {
    const a = idx.get(l.source)
    const b = idx.get(l.target)
    if (a == null || b == null || a === b) continue
    adj[a].set(b, (adj[a].get(b) ?? 0) + 1)
    adj[b].set(a, (adj[b].get(a) ?? 0) + 1)
  }
  const k = new Array(N).fill(0) // weighted degree
  let m2 = 0 // 2m — total edge weight ×2
  for (let i = 0; i < N; i++)
    for (const w of adj[i].values()) {
      k[i] += w
      m2 += w
    }
  const comm = Array.from({ length: N }, (_, i) => i)
  const stot = k.slice() // Σtot per community (sum of degrees)
  if (m2 > 0)
    for (let pass = 0, moved = true; moved && pass < 20; pass++) {
      moved = false
      for (let i = 0; i < N; i++) {
        const ci = comm[i]
        const wTo = new Map<number, number>() // weight from i to each neighbour community
        for (const [j, w] of adj[i]) {
          const cj = comm[j]
          wTo.set(cj, (wTo.get(cj) ?? 0) + w)
        }
        stot[ci] -= k[i] // pull i out of its community
        let best = ci
        let bestGain = (wTo.get(ci) ?? 0) - (stot[ci] * k[i]) / m2 // gain of staying
        for (const [c, wic] of wTo) {
          const gain = wic - (stot[c] * k[i]) / m2
          if (gain > bestGain + 1e-12) {
            bestGain = gain
            best = c
          }
        }
        stot[best] += k[i]
        if (best !== ci) {
          comm[i] = best
          moved = true
        }
      }
    }
  const degOf = new Map(nodes.map((n) => [n.id, n.degree] as const))
  const groups = new Map<number, Set<string>>()
  for (let i = 0; i < N; i++)
    (groups.get(comm[i]) ?? groups.set(comm[i], new Set()).get(comm[i])!).add(nodes[i].id)
  const titleOf = new Map(nodes.map((n) => [n.id, n.title] as const))
  const out: Community[] = []
  for (const ids of groups.values()) {
    if (ids.size < minSize) continue
    let rep = ''
    let repDeg = -1
    for (const id of ids) {
      const d = degOf.get(id) ?? 0
      if (d > repDeg || (d === repDeg && id < rep)) {
        rep = id
        repDeg = d
      }
    }
    out.push({ id: rep, label: titleOf.get(rep) ?? rep, ids })
  }
  return out.sort((a, b) => b.ids.size - a.ids.size || a.label.localeCompare(b.label))
}
