import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Card, EmptyState } from '../Card'
import { useData } from '../../lib/useData'
import { fetchWikiGraph, type WikiGraph as Graph, type WikiNode, type WikiLink } from '../../lib/api'
import {
  categoryColor,
  CATEGORY_ORDER,
  edgeColor,
  EDGE_FAMILIES,
  graphLensesFor,
  nodeShape,
  type NodeShape,
} from '../../lib/wiki'
import { detectCommunities, membershipHubs, subgraphFrom } from '../../lib/graph'

// An isolated subgraph: the focused node set, a chip label, and which mechanism
// produced it (so the project/cluster <select> can reflect the active choice).
interface Focus {
  label: string
  ids: Set<string>
  kind: 'project' | 'cluster' | 'ego'
  key: string // matches the <select> option value for project/cluster
}

/* A hand-rolled force-directed knowledge graph (no dependency). Same model as
 * Obsidian's: centering + pairwise repulsion + link springs, integrated with
 * velocity damping and a cooling alpha so it settles and stops (no looping
 * motion — this runs on a TV). Click a node to select+highlight it and its
 * neighbors (sticky, so it works without hover on a TV); double-click to open
 * it; hover also highlights; drag to reposition; wheel/drag-background to
 * zoom/pan. */

const W = 1000
const H = 640

// Startup: settle the layout OFF-SCREEN so the graph appears already relaxed
// instead of visibly flinging around. We run physics ticks synchronously down to
// PREWARM_TO — set BELOW the 0.015 on-screen stop threshold so the graph pops in
// static (no settling frames, which on a 600-node/2500-edge graph also avoids
// re-rendering thousands of SVG elements hundreds of times). Bounded two ways so a
// large graph never hangs the main thread: PREWARM_MAX iterations and, whichever
// comes first, a PREWARM_BUDGET_MS wall-clock budget (it then finishes on-screen,
// calmly, thanks to the velocity clamp below).
const PREWARM_TO = 0.012
const PREWARM_MAX = 1000
const PREWARM_BUDGET_MS = 500
// Cap per-tick node travel so a dense, high-energy graph relaxes calmly instead of
// flinging/vibrating — the main "jiggle" lever at Atlas scale. Far above the
// per-tick motion of a small (recipes/work) graph, so those are unaffected.
const MAX_STEP = 22

// Resting "follow-light" (borrowed from performativeUI's node-graph backdrop):
// when the pointer is over the graph and nothing is actively highlighted, dim
// distant nodes/edges and brighten the ones under the cursor. Suppressed while
// a node is highlighted (the neighbor dim/lit logic owns opacity then) and
// absent with no cursor — so a cursorless TV stays at full brightness and
// perfectly still (motion only on interaction).
const SPOT_RADIUS = 230 // graph units — falloff distance from the cursor
const SPOT_NODE_BASE = 0.5 // node opacity far from the cursor
const SPOT_EDGE_BASE = 0.4 // edge opacity far from the cursor

const colorOf = categoryColor

// Legend categories present in a graph, in the canonical order (known categories
// first, any unknown ones after). Vault-agnostic: shows recipe types for the
// recipes vault, work types for the work vault.
function legendFor(nodes: WikiNode[]): string[] {
  const present = [...new Set(nodes.map((n) => n.type))]
  const ordered = CATEGORY_ORDER.filter((c) => present.includes(c))
  const extra = present.filter((c) => !CATEGORY_ORDER.includes(c)).sort()
  return [...ordered, ...extra]
}

interface Sim {
  id: string
  x: number
  y: number
  vx: number
  vy: number
}

function radius(degree: number) {
  return 5 + Math.sqrt(degree) * 2.6
}

// A node's glyph by shape (see nodeShape). Shaped nodes keep the className passed
// in (.wiki-graph__circle) so the hover/selection stroke rules still target them.
function NodeGlyph({
  shape,
  r,
  fill,
  stroke,
  className,
}: {
  shape: NodeShape
  r: number
  fill: string
  stroke?: string
  className?: string
}) {
  if (shape === 'square') {
    return <rect x={-r} y={-r} width={2 * r} height={2 * r} rx={r * 0.3} fill={fill} stroke={stroke} className={className} />
  }
  if (shape === 'diamond') {
    return (
      <rect x={-r} y={-r} width={2 * r} height={2 * r} rx={r * 0.16} transform="rotate(45)" fill={fill} stroke={stroke} className={className} />
    )
  }
  return <circle r={r} fill={fill} stroke={stroke} className={className} />
}

// Collapse a title/slug to a comparison key (lowercase, alphanumerics only) so
// "Attention Is All You Need" and "attention-is-all-you-need" match.
const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '')

// Resolve a sibling card's hover target to a node id. `key` is a page path
// (exact) or a title (normalized against node title, then node id/slug).
function resolveHighlight(nodes: WikiNode[], key: string | null): string | null {
  if (!key) return null
  const byPath = nodes.find((n) => n.path === key)
  if (byPath) return byPath.id
  const byId = nodes.find((n) => n.id === key) // wikilink slug from the log
  if (byId) return byId.id
  const k = normKey(key)
  if (!k) return null
  return (
    nodes.find((n) => normKey(n.title) === k)?.id ??
    nodes.find((n) => normKey(n.id) === k)?.id ??
    null
  )
}

export function WikiGraph({
  className = '',
  onOpenPath,
  highlight = null,
  vault,
}: {
  className?: string
  onOpenPath: (path: string) => void
  highlight?: string | null // page path or title hovered in a sibling card
  vault?: string
}) {
  const { data } = useData(() => fetchWikiGraph(vault), 5 * 60 * 1000)
  const svgRef = useRef<SVGSVGElement>(null)

  const simRef = useRef<Map<string, Sim>>(new Map())
  const sigRef = useRef('')
  const alphaRef = useRef(0)
  const rafRef = useRef(0)
  const tickRef = useRef<() => void>(() => {})
  const dragRef = useRef<{ id: string; moved: boolean; downX: number; downY: number } | null>(null)
  const lastTapRef = useRef<{ id: string; t: number } | null>(null) // for double-tap-to-open
  const panRef = useRef<{ x: number; y: number } | null>(null) // last client pos (1-finger pan)
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const pinchRef = useRef<{ dist: number; mid: { x: number; y: number } } | null>(null)
  const cursorRef = useRef<{ x: number; y: number } | null>(null) // graph-space cursor for the follow-light
  const spotRafRef = useRef(0)

  const [, setFrame] = useState(0)
  const [view, setView] = useState({ x: 0, y: 0, w: W, h: H })
  const [hover, setHover] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  // Null until the operator picks a lens; the active lens then resolves against
  // the vault-appropriate set (its default otherwise — see below).
  const [lensKey, setLensKey] = useState<string | null>(null)
  const [focus, setFocus] = useState<Focus | null>(null)
  const [egoDepth, setEgoDepth] = useState(1)

  const graph: Graph | null = data
  const nodes = graph?.nodes ?? []
  const links = graph?.links ?? []

  // Typed-edge derivations. `hasTyped` gates the lens switcher + edge legend (so a
  // plain LLM-wiki vault keeps the old chrome-free graph). A lens keeps a set of
  // edge families lit; `lensNodes` is the set still touched by an in-lens edge.
  const nodeById = new Map(nodes.map((n) => [n.id, n] as const))
  const hasTyped = links.some((l) => l.family && l.family !== 'link')
  const presentFamilyKeys = [...new Set(links.map((l) => l.family ?? 'link'))]
  const presentFamilies = EDGE_FAMILIES.filter((f) => presentFamilyKeys.includes(f.key))
  // Lens set + default follow the families the graph actually carries: a recipe
  // vault gets the ingredient-centric lenses (recipe↔ingredient default); the
  // Atlas its people/projects set. `lensKey` (operator's pick) wins; else the set's
  // default — which flips to Ingredients once the recipe graph's edges load.
  const { lenses, default: defaultLens } = graphLensesFor(presentFamilyKeys)
  const lens = lenses.find((l) => l.key === lensKey) ?? defaultLens
  const lensFamilies = lens.families
  const inLens = (l: WikiLink) => lensFamilies == null || lensFamilies.includes(l.family ?? 'link')
  const lensNodes = new Set<string>()
  if (lensFamilies)
    for (const l of links)
      if (inLens(l)) {
        lensNodes.add(l.source)
        lensNodes.add(l.target)
      }
  const today = new Date().toISOString().slice(0, 10)

  // (Re)seed positions only when the set of nodes actually changes, so a
  // background poll doesn't reshuffle a settled layout.
  const sig = nodes.map((n) => n.id).join('|')
  if (sig && sig !== sigRef.current) {
    sigRef.current = sig
    const next = new Map<string, Sim>()
    let kept = 0
    nodes.forEach((n, i) => {
      const prev = simRef.current.get(n.id)
      if (prev) kept++
      // Phyllotaxis (sunflower) seed: spread new nodes over a DISK, not a single
      // dense ring — so the layout starts near-relaxed instead of having to
      // violently explode a collapsed ring apart. Big cut to startup motion.
      const rr = 240 * Math.sqrt((i + 0.5) / nodes.length)
      const a = i * 2.399963229 // golden angle (radians)
      next.set(n.id, prev ?? { id: n.id, x: W / 2 + Math.cos(a) * rr, y: H / 2 + Math.sin(a) * rr, vx: 0, vy: 0 })
    })
    simRef.current = next
    // First layout starts hot. A background refresh that mostly reuses already-
    // settled positions only needs a nudge proportional to how much actually
    // changed — so the 15-min poll doesn't reshuffle the whole graph each time.
    const churn = nodes.length ? 1 - kept / nodes.length : 1
    alphaRef.current = kept === 0 ? 1 : Math.min(1, 0.2 + churn)
  }

  // Isolatable subgraphs (recomputed only when structure changes, not every frame):
  // project/area hubs from the typed membership edges (#1) + emergent modularity
  // clusters (#4). Ego neighbourhoods (#3) are computed on demand. Trim each list to
  // what's worth a dropdown slot: hubs need ≥2 members (a lone task isn't a cluster),
  // clusters are the 16 largest (the long tail of size-3 groups isn't useful here).
  const hubs = useMemo(() => membershipHubs(nodes, links).filter((h) => h.count >= 2), [sig, links.length])
  const communities = useMemo(() => detectCommunities(nodes, links).slice(0, 16), [sig, links.length])

  // Force simulation loop. Mutates positions in a ref; bumps a frame counter to
  // re-render. Cools via alpha and stops when settled (or when a node is dragged
  // we keep it warm).
  useLayoutEffect(() => {
    if (!nodes.length) return
    const sim = simRef.current

    // One physics step: pairwise repulsion + link springs + centering, integrated
    // with velocity damping. Mutates node positions in place. `drag` pins the
    // grabbed node. Scaled by `alpha` (the cooling factor).
    const step = (alpha: number, drag: { id: string } | null) => {
      const arr = [...sim.values()]
      // repulsion (O(n²) — fine at this scale)
      for (let i = 0; i < arr.length; i++) {
        for (let j = i + 1; j < arr.length; j++) {
          const a = arr[i]
          const b = arr[j]
          let dx = a.x - b.x
          let dy = a.y - b.y
          let d2 = dx * dx + dy * dy
          if (d2 < 1) d2 = 1
          const f = (4200 / d2) * alpha
          const d = Math.sqrt(d2)
          const fx = (dx / d) * f
          const fy = (dy / d) * f
          a.vx += fx
          a.vy += fy
          b.vx -= fx
          b.vy -= fy
        }
      }
      // link springs
      for (const l of links) {
        const a = sim.get(l.source as string)
        const b = sim.get(l.target as string)
        if (!a || !b) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const d = Math.sqrt(dx * dx + dy * dy) || 1
        const f = ((d - 90) * 0.045) * alpha
        const fx = (dx / d) * f
        const fy = (dy / d) * f
        a.vx += fx
        a.vy += fy
        b.vx -= fx
        b.vy -= fy
      }
      // centering + integrate
      for (const n of arr) {
        n.vx += (W / 2 - n.x) * 0.008 * alpha
        n.vy += (H / 2 - n.y) * 0.008 * alpha
        if (drag && drag.id === n.id) continue // pinned by the cursor
        n.vx *= 0.82
        n.vy *= 0.82
        // Clamp travel so an over-energetic node can't fling across the canvas in
        // one tick (the source of the dense-graph vibration); keeps motion calm.
        const sp = Math.hypot(n.vx, n.vy)
        if (sp > MAX_STEP) {
          n.vx *= MAX_STEP / sp
          n.vy *= MAX_STEP / sp
        }
        n.x += n.vx
        n.y += n.vy
      }
    }
    const cool = (alpha: number) => Math.max(0, alpha * 0.992 - 0.0003)

    // Pre-warm off-screen: burn through the settle synchronously so the first
    // painted frame is already relaxed (ideally fully static). Bounded by both an
    // iteration cap and a wall-clock budget so a huge graph degrades gracefully
    // (finishes on-screen) rather than freezing the tab.
    let a = alphaRef.current
    const t0 = performance.now()
    for (let i = 0; i < PREWARM_MAX && a > PREWARM_TO; i++) {
      step(a, null)
      a = cool(a)
      if ((i & 31) === 0 && performance.now() - t0 > PREWARM_BUDGET_MS) break
    }
    alphaRef.current = a

    const tick = () => {
      step(alphaRef.current, dragRef.current)
      alphaRef.current = cool(alphaRef.current)
      setFrame((f) => f + 1)
      // Keep animating while warm or dragging — but also freeze early once a
      // converged layout has gone visually still (peak node speed ≈ 0), instead of
      // burning frames (re-rendering the whole graph) to cool a motionless graph.
      let peak = 0
      for (const n of sim.values()) {
        const v = n.vx * n.vx + n.vy * n.vy
        if (v > peak) peak = v
      }
      const still = !dragRef.current && alphaRef.current < 0.2 && peak < 0.02 // (≈0.14 u/tick)²
      if ((alphaRef.current > 0.015 && !still) || dragRef.current) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = 0
      }
    }
    tickRef.current = tick
    rafRef.current = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(rafRef.current)
      cancelAnimationFrame(spotRafRef.current)
    }
  }, [sig])

  // Restart the (self-rescheduling) physics loop after it has cooled — used when
  // the user grabs a node so neighbors re-settle around it.
  const reheat = () => {
    // A big graph only needs a small nudge to re-settle neighbours around a grabbed
    // node — a full reheat would shake all 600 nodes. Small graphs reheat fully.
    alphaRef.current = Math.max(alphaRef.current, nodes.length > 200 ? 0.22 : 0.4)
    if (!rafRef.current) rafRef.current = requestAnimationFrame(tickRef.current)
  }

  // Zoom/pan the viewBox to frame a node set (the layout is global and untouched —
  // isolating ghosts the rest in place; this just brings the subgraph up close).
  const fitTo = (ids: Set<string>) => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const id of ids) {
      const p = simRef.current.get(id)
      if (!p) continue
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    if (!Number.isFinite(minX)) return
    const pad = 70
    const w = Math.max(maxX - minX + pad * 2, 160)
    const h = Math.max(maxY - minY + pad * 2, 160)
    setView({ x: minX - pad, y: minY - pad, w, h })
  }

  // Isolate a subgraph (ghost everything else) and frame it; clear restores the
  // whole graph and the default view.
  const isolate = (label: string, ids: Set<string>, kind: Focus['kind'], key: string) => {
    setFocus({ label, ids, kind, key })
    fitTo(ids)
  }
  const clearFocus = () => {
    setFocus(null)
    setView({ x: 0, y: 0, w: W, h: H })
  }
  // #1 / #4 — pick a project hub (membership closure) or an emergent cluster.
  const onPickSubgraph = (value: string) => {
    if (!value) return clearFocus()
    if (value.startsWith('p:')) {
      const id = value.slice(2)
      const hub = hubs.find((h) => h.id === id)
      isolate(hub?.title ?? id, subgraphFrom(links, id, 1, ['membership']), 'project', value)
    } else if (value.startsWith('c:')) {
      const c = communities.find((x) => x.id === value.slice(2))
      if (c) isolate(c.label, c.ids, 'cluster', value)
    }
  }
  // #3 — isolate the selected node's k-hop neighbourhood (any edge family).
  const focusEgo = (depth: number) => {
    if (!selected) return
    const node = nodeById.get(selected)
    isolate(`${node?.title ?? selected} ±${depth}`, subgraphFrom(links, selected, depth, null), 'ego', `e:${selected}`)
  }
  const changeDepth = (d: number) => {
    const nd = Math.max(1, Math.min(3, d))
    setEgoDepth(nd)
    if (focus?.kind === 'ego') focusEgo(nd)
  }

  // Convert a pointer event to viewBox coordinates.
  const toGraph = (e: PointerEvent) => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const m = svg.getScreenCTM()
    if (!m) return { x: 0, y: 0 }
    const p = pt.matrixTransform(m.inverse())
    return { x: p.x, y: p.y }
  }

  // Re-render once (coalesced to a frame) to move the resting follow-light.
  const bumpSpot = () => {
    if (spotRafRef.current) return
    spotRafRef.current = requestAnimationFrame(() => {
      spotRafRef.current = 0
      setFrame((f) => f + 1)
    })
  }
  const trackCursor = (e: PointerEvent) => {
    cursorRef.current = toGraph(e)
    bumpSpot()
  }

  const onNodeDown = (e: PointerEvent, id: string) => {
    e.stopPropagation()
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    dragRef.current = { id, moved: false, downX: e.clientX, downY: e.clientY }
    reheat()
  }
  const onNodeUp = (e: PointerEvent, id: string, path: string) => {
    e.stopPropagation()
    const d = dragRef.current
    dragRef.current = null
    if (!d || d.moved) return // a drag, not a tap
    const now = Date.now()
    const last = lastTapRef.current
    if (last && last.id === id && now - last.t < 350) {
      lastTapRef.current = null
      if (path) onOpenPath(path)
    } else {
      lastTapRef.current = { id, t: now }
      setSelected((s) => (s === id ? null : id)) // tap toggles sticky highlight
    }
  }

  // Background gestures: 1 finger / mouse-drag pans; 2 fingers pinch-zoom + pan
  // (touch). The SVG sets touch-action:none, so we own every gesture here.
  const clampW = (w: number) => Math.min(W * 2.5, Math.max(W * 0.25, w))
  const pdist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y)
  const pmid = (a: { x: number; y: number }, b: { x: number; y: number }) => ({
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  })

  const onBgDown = (e: PointerEvent) => {
    svgRef.current?.setPointerCapture?.(e.pointerId)
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const pts = [...pointersRef.current.values()]
    if (pts.length >= 2) {
      panRef.current = null
      pinchRef.current = { dist: pdist(pts[0], pts[1]), mid: pmid(pts[0], pts[1]) }
    } else {
      panRef.current = { x: e.clientX, y: e.clientY }
    }
  }
  const onBgUp = (e: PointerEvent) => {
    pointersRef.current.delete(e.pointerId)
    const left = [...pointersRef.current.values()]
    if (left.length < 2) pinchRef.current = null
    panRef.current = left.length === 1 ? { x: left[0].x, y: left[0].y } : null
  }
  const onPointerMove = (e: PointerEvent) => {
    const d = dragRef.current
    if (d) {
      // Dead-zone: ignore sub-threshold jitter so a click/double-click isn't
      // misread as a drag (which would suppress tap/double-tap-to-open).
      if (!d.moved && Math.hypot(e.clientX - d.downX, e.clientY - d.downY) <= 4) return
      const p = toGraph(e)
      const n = simRef.current.get(d.id)
      if (n) {
        n.x = p.x
        n.y = p.y
        n.vx = 0
        n.vy = 0
        d.moved = true
      }
      alphaRef.current = Math.max(alphaRef.current, 0.3)
      return
    }
    const svg = svgRef.current
    if (!svg) return
    // Plain hover (no active gesture): drive the resting follow-light.
    if (!panRef.current && !pinchRef.current) trackCursor(e)
    if (pointersRef.current.has(e.pointerId)) {
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    }
    const pts = [...pointersRef.current.values()]
    const rect = svg.getBoundingClientRect()
    if (pts.length >= 2 && pinchRef.current) {
      // pinch-zoom around the finger midpoint, which also follows two-finger pan
      const cur = { dist: Math.max(1, pdist(pts[0], pts[1])), mid: pmid(pts[0], pts[1]) }
      const prev = pinchRef.current
      // dampen the raw distance ratio so pinch-zoom feels less sensitive
      const f = Math.pow(prev.dist / cur.dist, 0.5)
      setView((v) => {
        const focalX = v.x + ((prev.mid.x - rect.left) / rect.width) * v.w
        const focalY = v.y + ((prev.mid.y - rect.top) / rect.height) * v.h
        const w = clampW(v.w * f)
        const h = (w / v.w) * v.h
        return {
          x: focalX - ((cur.mid.x - rect.left) / rect.width) * w,
          y: focalY - ((cur.mid.y - rect.top) / rect.height) * h,
          w,
          h,
        }
      })
      pinchRef.current = cur
      return
    }
    if (panRef.current && pts.length === 1) {
      const dx = e.clientX - panRef.current.x
      const dy = e.clientY - panRef.current.y
      panRef.current = { x: e.clientX, y: e.clientY }
      setView((v) => ({ ...v, x: v.x - (dx / rect.width) * v.w, y: v.y - (dy / rect.height) * v.h }))
    }
  }
  const onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const p = toGraph(e as unknown as PointerEvent)
    const k = e.deltaY > 0 ? 1.06 : 0.943
    setView((v) => {
      const w = clampW(v.w * k)
      const h = (w / v.w) * v.h
      return { x: p.x - (p.x - v.x) * (w / v.w), y: p.y - (p.y - v.y) * (h / v.h), w, h }
    })
  }

  // Neighbor set for highlight. Direct graph hover wins; then a sibling card's
  // hover; then the sticky selection set by a tap (so it works without hover on
  // a TV). `highlight` may be a page path (Browse, exact) or a title (the log,
  // whose capture-time string can differ from the page's H1/slug) — so resolve
  // by path first, then by a normalized title/slug match.
  const extId = resolveHighlight(nodes, highlight)
  const active = hover ?? extId ?? selected
  const neighbors = new Set<string>()
  if (active) {
    neighbors.add(active)
    for (const l of links) {
      if (l.source === active) neighbors.add(l.target as string)
      if (l.target === active) neighbors.add(l.source as string)
    }
  }
  // Suppressed under an isolation: the focus --off ghosting owns opacity then, so
  // the whole focused set reads at full brightness — otherwise selecting a node
  // (required to ego-focus) would grey out everything past its 1-hop ring, leaving
  // the deeper hops of an N-hop focus dim instead of lit.
  const dim = (id: string) => focus == null && active != null && !neighbors.has(id)

  // Isolation: a focused subgraph ghosts every node/edge outside it (reusing the
  // lens --off treatment), so the carved-out cluster reads on its own.
  const focusOff = (id: string) => focus != null && !focus.ids.has(id)
  const edgeInFocus = (l: WikiLink) => focus == null || (focus.ids.has(l.source) && focus.ids.has(l.target))

  // Resting follow-light: only when nothing is actively highlighted and the
  // cursor is over the graph — so the neighbor dim/lit logic is untouched while
  // a node is highlighted, and a cursorless TV stays bright and still. Suppressed
  // under an isolation (the --off ghosting owns opacity then).
  const cursor = cursorRef.current
  const spotlit = active == null && cursor != null && focus == null
  const spot = (x: number, y: number, base: number): number => {
    if (!spotlit) return 1
    const t = Math.max(0, 1 - Math.hypot(x - cursor!.x, y - cursor!.y) / SPOT_RADIUS)
    return base + (1 - base) * t * t
  }

  return (
    <Card
      title="Knowledge Graph"
      className={className}
      actions={
        <div className="wiki-graph__legend">
          {legendFor(nodes).map((t) => (
            <span key={t} className="wiki-graph__lk">
              <span className="wiki-graph__dot" style={{ background: colorOf(t) }} />
              {t}
            </span>
          ))}
        </div>
      }
    >
      {nodes.length === 0 ? (
        <EmptyState>Wiki graph unavailable.</EmptyState>
      ) : (
        <>
          {hasTyped ? (
            <div className="wiki-graph__bar">
              <div className="wiki-graph__lenses">
                {lenses.map((l) => (
                  <button
                    key={l.key}
                    type="button"
                    className={`wiki-cat ${lens.key === l.key ? 'wiki-cat--active' : ''}`}
                    onClick={() => setLensKey(l.key)}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
              <div className="wiki-graph__edge-legend">
                {presentFamilies.map((f) => (
                  <span key={f.key} className="wiki-graph__elk">
                    <span className="wiki-graph__eline" style={{ background: f.color }} />
                    {f.label}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {hasTyped && (hubs.length > 0 || communities.length > 0) ? (
            <div className="wiki-graph__bar wiki-graph__bar--sub">
              <div className="wiki-graph__isolate">
                <span className="wiki-graph__sub-label">Isolate</span>
                <select
                  className="wiki-graph__select"
                  value={focus && focus.kind !== 'ego' ? focus.key : ''}
                  onChange={(e) => onPickSubgraph((e.target as HTMLSelectElement).value)}
                >
                  <option value="">whole graph</option>
                  {hubs.length ? (
                    <optgroup label="Projects & areas">
                      {hubs.map((h) => (
                        <option key={h.id} value={`p:${h.id}`}>
                          {h.title} · {h.count}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                  {communities.length ? (
                    <optgroup label="Clusters">
                      {communities.map((c) => (
                        <option key={c.id} value={`c:${c.id}`}>
                          {c.label} · {c.ids.size}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
                <button
                  type="button"
                  className={`wiki-cat ${focus?.kind === 'ego' ? 'wiki-cat--active' : ''}`}
                  disabled={!selected}
                  onClick={() => focusEgo(egoDepth)}
                  title={selected ? 'Isolate the selected node’s neighbourhood' : 'Tap a node first, then focus its neighbourhood'}
                >
                  ⊙ Focus node
                </button>
                {focus?.kind === 'ego' ? (
                  <span className="wiki-graph__depth">
                    <button type="button" onClick={() => changeDepth(egoDepth - 1)} disabled={egoDepth <= 1}>
                      −
                    </button>
                    <span className="wiki-graph__depth-n">{egoDepth} hop{egoDepth > 1 ? 's' : ''}</span>
                    <button type="button" onClick={() => changeDepth(egoDepth + 1)} disabled={egoDepth >= 3}>
                      +
                    </button>
                  </span>
                ) : null}
              </div>
              {focus ? (
                <button type="button" className="wiki-graph__clear" onClick={clearFocus}>
                  {focus.label} · {focus.ids.size} nodes <span aria-hidden>✕</span>
                </button>
              ) : null}
            </div>
          ) : null}
          <svg
            ref={svgRef}
            className="wiki-graph__svg"
            viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
            onPointerDown={onBgDown}
            onPointerUp={onBgUp}
            onPointerCancel={onBgUp}
            onPointerMove={onPointerMove}
            onPointerLeave={() => {
              cursorRef.current = null
              bumpSpot()
            }}
            onWheel={onWheel}
          >
            <defs>
              {EDGE_FAMILIES.map((f) => (
                <marker
                  key={f.key}
                  id={`arrow-${f.key}`}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  markerUnits="userSpaceOnUse"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" fill={f.color} />
                </marker>
              ))}
            </defs>
            {links.map((l, i) => {
              const a = simRef.current.get(l.source)
              const b = simRef.current.get(l.target)
              if (!a || !b) return null
              const on = inLens(l) && edgeInFocus(l)
              const lit = on && active != null && (l.source === active || l.target === active)
              // Shorten a directed edge so its arrowhead sits just outside the target glyph.
              let x2 = b.x
              let y2 = b.y
              if (l.directed) {
                const tn = nodeById.get(l.target)
                const dx = b.x - a.x
                const dy = b.y - a.y
                const len = Math.hypot(dx, dy) || 1
                const gap = radius(tn ? tn.degree : 0) + 5
                x2 = b.x - (dx / len) * gap
                y2 = b.y - (dy / len) * gap
              }
              return (
                <line
                  key={i}
                  x1={a.x}
                  y1={a.y}
                  x2={x2}
                  y2={y2}
                  stroke={edgeColor(l.family)}
                  markerEnd={l.directed && on ? `url(#arrow-${l.family})` : undefined}
                  style={on && spotlit ? { opacity: spot((a.x + b.x) / 2, (a.y + b.y) / 2, SPOT_EDGE_BASE) } : undefined}
                  className={`wiki-graph__edge ${!on ? 'wiki-graph__edge--off' : ''} ${lit ? 'is-lit' : ''} ${on && active && !lit && focus == null ? 'is-dim' : ''}`}
                />
              )
            })}
            {nodes.map((n) => {
              const s = simRef.current.get(n.id)
              if (!s) return null
              const r = radius(n.degree)
              // Inside a small isolation, label every focused node so the carved-out
              // subgraph reads in full; otherwise the usual hub/neighbour rule.
              const inFocus = focus != null && focus.ids.has(n.id)
              const showLabel = n.degree >= 8 || neighbors.has(n.id) || (inFocus && focus!.ids.size <= 40)
              const shape = nodeShape(n.type)
              const fill = colorOf(n.type)
              const isTask = n.type === 'Tasks'
              const done = isTask && n.status === 'done'
              const waiting = isTask && n.status === 'waiting'
              const overdue = isTask && !!n.due && n.due < today && n.status !== 'done'
              const off = (lensFamilies != null && !lensNodes.has(n.id)) || focusOff(n.id)
              const labelDx = (shape === 'diamond' ? r * 1.4 : r) + 3
              return (
                <g
                  key={n.id}
                  className={`wiki-graph__node ${dim(n.id) ? 'is-dim' : ''} ${off ? 'wiki-graph__node--off' : ''} ${done ? 'wiki-graph__node--done' : ''} ${n.id === selected ? 'is-selected' : ''} ${n.id === extId ? 'is-active' : ''}`}
                  style={spotlit ? { opacity: spot(s.x, s.y, SPOT_NODE_BASE) } : undefined}
                  transform={`translate(${s.x} ${s.y})`}
                  onPointerDown={(e) => onNodeDown(e as unknown as PointerEvent, n.id)}
                  onPointerUp={(e) => onNodeUp(e as unknown as PointerEvent, n.id, n.path)}
                  onPointerEnter={() => setHover(n.id)}
                  onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                >
                  <circle r={r} fill="transparent" />
                  {overdue ? <NodeGlyph shape={shape} r={r + 3} fill="none" className="wiki-graph__overdue" /> : null}
                  <NodeGlyph
                    shape={shape}
                    r={r}
                    fill={waiting ? 'none' : fill}
                    stroke={waiting ? fill : undefined}
                    className="wiki-graph__circle"
                  />
                  {showLabel ? (
                    <text className="wiki-graph__label" x={labelDx} y={3}>
                      {n.title}
                    </text>
                  ) : null}
                </g>
              )
            })}
          </svg>
        </>
      )}
    </Card>
  )
}
