import { useEffect, useMemo, useRef, useState } from 'preact/hooks'
import { Card, EmptyState } from '../Card'
import { CategoryPicker } from '../CategoryPicker'
import { MicField } from '../MicField'
import { useData } from '../../lib/useData'
import { fetchTasks, fetchTaskCategories, resolveCategory, type AtlasTask, type TaskCategorySel } from '../../lib/api'

// The Atlas task lifecycle (Wiki/Legend.md `status` enum) → Kanban columns.
const COLUMNS: { key: string; label: string }[] = [
  { key: 'inbox', label: 'Inbox' },
  { key: 'next', label: 'Next' },
  { key: 'doing', label: 'Doing' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'done', label: 'Done' },
]
const COLUMN_KEYS = new Set(COLUMNS.map((c) => c.key))
// Unknown / unset status → Inbox (the lifecycle's entry point).
const colOf = (status: string) => (COLUMN_KEYS.has(status) ? status : 'inbox')

// A task's color "category" — the visual separator on the board. Its individual
// project (for_project) wins; failing that its project-idea (for_project_idea —
// an exploratory hub, not yet committed); failing that its life area (Health,
// Finance, …), so each gets its own color. The color is the card's BACKGROUND
// tint (status stays on the left border + column).
//
// Hand-tuned [hue, sat%, light%] swatches, spaced around the wheel and kept
// mid-dark so they read as a subtle tint on the dark HUD and as legible chip ink
// on the light Claude themes. Applied to the card as --cat-h/s/l custom props.
const CARD_PALETTE: [number, number, number][] = [
  [205, 72, 52], // blue
  [150, 55, 42], // green
  [38, 78, 48], // amber
  [275, 55, 60], // purple
  [340, 68, 56], // rose
  [95, 50, 40], // olive
  [190, 68, 42], // cyan
  [18, 78, 52], // orange
  [255, 58, 62], // indigo
  [320, 55, 56], // magenta
  [50, 72, 45], // gold
  [168, 55, 38], // teal
]
// Stable djb2 string hash → a category's preferred palette index.
function hashIndex(key: string): number {
  let h = 5381
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0
  return Math.abs(h) % CARD_PALETTE.length
}
// A task's category key, namespaced by kind (`p:`/`i:`/`a:`) so a project, a
// project-idea and an area of the same name don't share a color. null when the
// task has none of the three (→ neutral card).
function categoryKey(t: AtlasTask): { kind: 'project' | 'project-idea' | 'area'; key: string } | null {
  if (t.project) return { kind: 'project', key: `p:${t.project}` }
  if (t.projectIdea) return { kind: 'project-idea', key: `i:${t.projectIdea}` }
  if (t.area) return { kind: 'area', key: `a:${t.area}` }
  return null
}
// Map every distinct category present → a palette swatch. Each takes its hashed
// preferred swatch; collisions linear-probe to the next free one. Sorting the
// keys first makes the assignment stable regardless of task/poll order, so two
// categories never share a color until there are more categories than swatches.
function assignCatColors(keys: Iterable<string>): Map<string, [number, number, number]> {
  const N = CARD_PALETTE.length
  const used = new Array(N).fill(false)
  const map = new Map<string, [number, number, number]>()
  for (const key of [...new Set(keys)].sort()) {
    let i = hashIndex(key)
    for (let n = 0; n < N && used[i]; n++) i = (i + 1) % N
    used[i] = true
    map.set(key, CARD_PALETTE[i])
  }
  return map
}

// Local YYYY-MM-DD, to compare against a task's `due` (also a plain date).
function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// The Done column clears every morning at 7am Berlin time: it shows only tasks
// completed on or after the most recent 7am Europe/Berlin boundary. Older done
// tasks stay in the Atlas (status: done) — they just age off the board.
const DONE_CLEAR_HOUR = 7
// The calendar date (YYYY-MM-DD) and hour in Europe/Berlin, right now.
function berlinNow(): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date())
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) }
}
// Shift a YYYY-MM-DD by whole days (UTC math, so no DST/local drift on the date).
function addDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}
// A done task with `done` before this cutoff has aged off the board. Before 7am
// Berlin the cutoff is yesterday's date (so the night's completions still show);
// at/after 7am it advances to today, clearing everything finished on prior days.
function doneCutoff(): string {
  const { date, hour } = berlinNow()
  return hour >= DONE_CLEAR_HOUR ? date : addDays(date, -1)
}

// Tasks board for the Atlas, grouped by status. Reads live (?vault=) and polls,
// so it auto-updates as the Atlas's Tasks/ change. A card opens its note in the
// reader; dragging a card to another column moves it to that status.
//
// Drag-and-drop is optimistic: a drop moves the card immediately and the move
// survives polling via `overrides` (path → status) until the commit lands and the
// poll catches up. `onMove` persists it through the Atlas commit queue (status
// edit + commit); a failed commit reverts the card to its committed column.
export function Kanban({
  className = '',
  vault,
  onOpen,
  onMove,
  onCreate,
  onSetDue,
  onSetPriority,
  refreshSignal,
}: {
  className?: string
  vault?: string
  onOpen: (path: string) => void
  /** Persist a drag — set `task`'s status to `status`, returning whether the
   *  commit succeeded. The optimistic local move is reverted on failure. */
  onMove?: (task: AtlasTask, status: string) => void | Promise<{ ok: boolean } | void>
  /** Create a new task from `title` (lands in Inbox) with an optional `due`
   *  date, an optional project/area (else inferred), and an optional free-text
   *  `body` (the description below the title), and commit it. When set, the
   *  header shows a "+ New task" composer. */
  onCreate?: (
    title: string,
    due?: string,
    category?: TaskCategorySel,
    body?: string,
  ) => Promise<{ ok: boolean; error?: string } | void> | void
  /** Set (or clear, when `due` is '') a task's due date and commit it. When set,
   *  each card's due shows as an editable chip. The optimistic edit reverts on
   *  failure. */
  onSetDue?: (task: AtlasTask, due: string) => void | Promise<{ ok: boolean } | void>
  /** Set (`'high'`) or clear (`''`) a task's priority and commit it. When set,
   *  each card shows a flame toggle that flags it high. The optimistic edit
   *  reverts on failure. */
  onSetPriority?: (task: AtlasTask, priority: string) => void | Promise<{ ok: boolean } | void>
  /** A bumped counter that forces an immediate re-poll — used so a category edit
   *  made in the note reader re-colours the board without waiting for the poll. */
  refreshSignal?: number
}) {
  const { data, refetch } = useData(() => fetchTasks(vault), 30_000)
  const tasks = data ?? []
  // Project/area vocabulary for the composer picker (changes slowly → poll lazily).
  const { data: categories } = useData(() => fetchTaskCategories(vault), 120_000)

  // Re-poll when the reader signals a category change so the card re-colours now.
  useEffect(() => {
    if (refreshSignal) refetch?.()
  }, [refreshSignal])

  // "+ New task" composer (header button → inline input above the board).
  const [composing, setComposing] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const [newBody, setNewBody] = useState('')
  const [newDue, setNewDue] = useState('')
  const [newCat, setNewCat] = useState('')
  const [creating, setCreating] = useState(false)
  const [createErr, setCreateErr] = useState<string | null>(null)
  const newInputRef = useRef<HTMLInputElement>(null)

  // Focus the input the moment the composer opens.
  useEffect(() => {
    if (composing) newInputRef.current?.focus()
  }, [composing])

  const submitNew = async (e: Event) => {
    e.preventDefault()
    const title = newTitle.trim()
    if (!title || creating) return
    setCreating(true)
    setCreateErr(null)
    // Empty picker → no category sent → the server infers one from the title.
    const category = newCat.trim() ? resolveCategory(newCat, categories) : undefined
    const r = await Promise.resolve(onCreate?.(title, newDue || undefined, category, newBody.trim() || undefined))
    setCreating(false)
    if (r && r.ok === false) {
      setCreateErr(r.error || 'Could not create task')
      return
    }
    setNewTitle('')
    setNewBody('')
    setNewDue('')
    setNewCat('')
    setComposing(false)
    refetch?.() // pull the freshly-committed task in instead of waiting for the poll
  }

  // Optimistic status overrides from drag-and-drop, applied over the polled data.
  const [overrides, setOverrides] = useState<Map<string, string>>(new Map())
  const [dragPath, setDragPath] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)

  // Legend filter: when a category is selected (its `p:`/`a:` key), the board
  // shows only that project/area's cards. Toggled by clicking its legend chip;
  // null = show everything. Cleared automatically if the category leaves the board.
  const [filterKey, setFilterKey] = useState<string | null>(null)
  // The horizontally-scrolling board, so a filter can page to its first
  // non-empty column (esp. on mobile, where only one column is visible).
  const boardRef = useRef<HTMLDivElement>(null)

  // Drop overrides the committed data has caught up to (or whose task is gone),
  // so the map can't grow stale once persistence lands.
  useEffect(() => {
    if (!data) return
    setOverrides((prev) => {
      if (prev.size === 0) return prev
      const next = new Map(prev)
      for (const [path, status] of prev) {
        const t = data.find((x) => x.path === path)
        if (!t || colOf(t.status) === status) next.delete(path)
      }
      return next.size === prev.size ? prev : next
    })
  }, [data])

  const effStatus = (t: AtlasTask) => overrides.get(t.path) ?? colOf(t.status)

  // Optimistic due edits from a card's due chip ('' = cleared), applied over the
  // polled data; reconciled away once the committed data catches up (mirrors the
  // status overrides above).
  const [dueOverrides, setDueOverrides] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    if (!data) return
    setDueOverrides((prev) => {
      if (prev.size === 0) return prev
      const next = new Map(prev)
      for (const [path, due] of prev) {
        const t = data.find((x) => x.path === path)
        if (!t || (t.due ?? '') === due) next.delete(path)
      }
      return next.size === prev.size ? prev : next
    })
  }, [data])
  const effDue = (t: AtlasTask) => (dueOverrides.has(t.path) ? dueOverrides.get(t.path)! : t.due ?? '')

  // Set/clear a card's due date: optimistically restage, then persist. A failed
  // commit drops the override so the chip snaps back to its committed value.
  const changeDue = (task: AtlasTask, due: string) => {
    if (effDue(task) === due) return
    setDueOverrides((prev) => new Map(prev).set(task.path, due))
    Promise.resolve(onSetDue?.(task, due)).then((r) => {
      if (r && r.ok === false) {
        setDueOverrides((prev) => {
          if (prev.get(task.path) !== due) return prev
          const next = new Map(prev)
          next.delete(task.path)
          return next
        })
      } else {
        refetch?.() // pull the committed due in instead of waiting for the poll
      }
    })
  }

  // Optimistic priority edits from a card's flame toggle ('' = cleared), applied
  // over the polled data; reconciled away once the committed data catches up
  // (mirrors the due overrides above).
  const [prioOverrides, setPrioOverrides] = useState<Map<string, string>>(new Map())
  useEffect(() => {
    if (!data) return
    setPrioOverrides((prev) => {
      if (prev.size === 0) return prev
      const next = new Map(prev)
      for (const [path, prio] of prev) {
        const t = data.find((x) => x.path === path)
        if (!t || (t.priority ?? '') === prio) next.delete(path)
      }
      return next.size === prev.size ? prev : next
    })
  }, [data])
  const effPriority = (t: AtlasTask) => (prioOverrides.has(t.path) ? prioOverrides.get(t.path)! : t.priority ?? '')

  // Toggle a card's high-priority flag: optimistically restage, then persist. A
  // failed commit drops the override so the flame snaps back to its committed state.
  const changePriority = (task: AtlasTask, priority: string) => {
    if (effPriority(task) === priority) return
    setPrioOverrides((prev) => new Map(prev).set(task.path, priority))
    Promise.resolve(onSetPriority?.(task, priority)).then((r) => {
      if (r && r.ok === false) {
        setPrioOverrides((prev) => {
          if (prev.get(task.path) !== priority) return prev
          const next = new Map(prev)
          next.delete(task.path)
          return next
        })
      } else {
        refetch?.() // pull the committed priority in instead of waiting for the poll
      }
    })
  }

  // Recomputed every render, so the board self-clears within a poll of 7am Berlin.
  const doneAge = doneCutoff()

  const byCol = useMemo(() => {
    const m = new Map<string, AtlasTask[]>()
    for (const c of COLUMNS) m.set(c.key, [])
    for (const t of tasks) {
      // Legend filter: when active, only the selected category's cards show.
      if (filterKey && categoryKey(t)?.key !== filterKey) continue
      const col = overrides.get(t.path) ?? colOf(t.status)
      // Done tasks finished before this morning's 7am cutoff age off the board
      // (they stay in the Atlas). A just-dragged card has no `done` date yet, so
      // it's never hidden until it's both committed and from a prior day.
      if (col === 'done' && t.done && t.done < doneAge) continue
      m.get(col)!.push(t)
    }
    // Flamed (high-priority) first so urgent tasks pin to the top, then soonest
    // due (dated before undated), then alphabetical. effPriority so an optimistic
    // flame toggle re-sorts the card up immediately.
    const isHigh = (t: AtlasTask) => effPriority(t) === 'high'
    for (const list of m.values()) {
      list.sort((a, b) => {
        const ah = isHigh(a)
        const bh = isHigh(b)
        if (ah !== bh) return ah ? -1 : 1
        if (a.due && b.due) return a.due.localeCompare(b.due)
        if (a.due) return -1
        if (b.due) return 1
        return a.title.localeCompare(b.title)
      })
    }
    return m
  }, [tasks, overrides, prioOverrides, doneAge, filterKey])

  // When a filter is applied, page the board to its first column that actually
  // has a matching card — otherwise (on the mobile snap carousel especially) you
  // land on an empty column and have to swipe to find where the cards went. Keyed
  // on filterKey only (via a ref for the latest columns) so a background poll
  // while filtered never yanks the board back from where the operator swiped.
  const byColRef = useRef(byCol)
  byColRef.current = byCol
  useEffect(() => {
    if (!filterKey) return
    const board = boardRef.current
    if (!board) return
    const idx = COLUMNS.findIndex((c) => (byColRef.current.get(c.key)?.length ?? 0) > 0)
    if (idx < 0) return
    const col = board.children[idx] as HTMLElement | undefined
    col?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
  }, [filterKey])

  // Stable color per category (project/area) across the whole board.
  const catColors = useMemo(() => {
    const keys: string[] = []
    for (const t of tasks) {
      const ck = categoryKey(t)
      if (ck) keys.push(ck.key)
    }
    return assignCatColors(keys)
  }, [tasks])

  // Header legend: each category (project/area) present on the board with its
  // swatch, so the card tints are self-explanatory — mirrors the Knowledge
  // Graph's type legend. catColors is keyed in stable sorted order, so the
  // legend order is stable too. The `p:`/`a:` namespace prefix is stripped for
  // display (it only exists to keep a project and a like-named area distinct).
  const legend = useMemo(
    () => [...catColors].map(([key, hsl]) => ({ key, name: key.slice(2), hsl })),
    [catColors],
  )

  // Drop the filter if its category has left the board (else it'd hide everything).
  useEffect(() => {
    if (filterKey && !catColors.has(filterKey)) setFilterKey(null)
  }, [catColors, filterKey])

  const today = todayStr()

  // Tasks actually on the board (excludes done tasks aged off at the 7am cutoff).
  const shownCount = useMemo(() => {
    let n = 0
    for (const list of byCol.values()) n += list.length
    return n
  }, [byCol])

  // Drop a card into `target` column: optimistically restage, then (later) persist.
  const moveTo = (path: string, target: string) => {
    setDragPath(null)
    setOverCol(null)
    if (!path) return
    const task = tasks.find((t) => t.path === path)
    if (!task || effStatus(task) === target) return
    setOverrides((prev) => new Map(prev).set(path, target))
    // Persist via the commit queue; on failure, drop the override so the card
    // snaps back to its committed column.
    Promise.resolve(onMove?.(task, target)).then((r) => {
      if (r && r.ok === false) {
        setOverrides((prev) => {
          if (prev.get(path) !== target) return prev
          const next = new Map(prev)
          next.delete(path)
          return next
        })
      }
    })
  }

  return (
    <Card
      title="Kanban"
      className={`kanban-card ${className}`}
      actions={
        <div className="kanban__actions">
          {legend.length ? (
            <div
              className={`kanban__legend${filterKey ? ' kanban__legend--filtering' : ''}`}
              title="Card color = its project or life area — click to show only that one"
            >
              {legend.map((c) => {
                const active = filterKey === c.key
                return (
                  <button
                    key={c.key}
                    type="button"
                    className={`kanban__lk${active ? ' kanban__lk--active' : ''}`}
                    aria-pressed={active}
                    title={active ? `Showing only ${c.name} — click to clear` : `Show only ${c.name}`}
                    onClick={() => setFilterKey(active ? null : c.key)}
                  >
                    <span
                      className="kanban__legend-dot"
                      style={{ background: `hsl(${c.hsl[0]} ${c.hsl[1]}% ${c.hsl[2]}%)` }}
                    />
                    {c.name}
                  </button>
                )
              })}
            </div>
          ) : null}
          <span className="kanban__count">
            {shownCount} task{shownCount === 1 ? '' : 's'}
          </span>
          {onCreate ? (
            <button
              type="button"
              className="btn kanban__new-btn"
              onClick={() => {
                setCreateErr(null)
                setComposing((c) => !c)
              }}
            >
              {composing ? 'Cancel' : '+ New task'}
            </button>
          ) : null}
        </div>
      }
    >
      {composing && onCreate ? (
        <form className="kanban__new" onSubmit={submitNew}>
          <MicField value={newTitle} onChange={setNewTitle}>
            <input
              ref={newInputRef}
              className="kanban__new-input"
              type="text"
              placeholder="New task — lands in Inbox"
              value={newTitle}
              disabled={creating}
              onInput={(e) => setNewTitle((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setComposing(false)
                  setCreateErr(null)
                }
              }}
            />
          </MicField>
          <MicField value={newBody} onChange={setNewBody} multiline>
            <textarea
              className="kanban__new-body"
              placeholder="Details (optional) — markdown body below the title"
              value={newBody}
              disabled={creating}
              onInput={(e) => setNewBody((e.target as HTMLTextAreaElement).value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setComposing(false)
                  setCreateErr(null)
                }
              }}
            />
          </MicField>
          <input
            className="kanban__new-due"
            type="date"
            title="Due date (optional)"
            value={newDue}
            disabled={creating}
            onInput={(e) => setNewDue((e.target as HTMLInputElement).value)}
          />
          <CategoryPicker
            value={newCat}
            categories={categories}
            placeholder="project:Name / project-idea:Name / area:Name — blank to auto-detect"
            disabled={creating}
            onInput={setNewCat}
          />
          <button type="submit" className="btn btn--approve" disabled={creating || !newTitle.trim()}>
            {creating ? 'Adding…' : 'Add'}
          </button>
        </form>
      ) : null}
      {createErr ? <div className="kanban__new-error">{createErr}</div> : null}
      {tasks.length === 0 ? (
        <EmptyState>No tasks yet — add type: task notes to the Atlas's Tasks/ folder.</EmptyState>
      ) : (
        <div className="kanban" ref={boardRef}>
          {COLUMNS.map((c) => {
            const list = byCol.get(c.key) ?? []
            return (
              <div
                key={c.key}
                className={`kanban__col kanban__col--${c.key}${overCol === c.key ? ' kanban__col--over' : ''}`}
                onDragOver={(e) => {
                  if (!dragPath) return // ignore drags that didn't start on a card
                  e.preventDefault()
                  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
                  if (overCol !== c.key) setOverCol(c.key)
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  moveTo(e.dataTransfer?.getData('text/plain') || dragPath || '', c.key)
                }}
              >
                <div
                  className="kanban__col-head"
                  title={
                    c.key === 'done'
                      ? 'Completed tasks clear from the board at 7am (Berlin time) — they stay in the Atlas.'
                      : undefined
                  }
                >
                  <span className="kanban__col-title">{c.label}</span>
                  <span className="kanban__col-n">{list.length}</span>
                </div>
                <div className="kanban__col-body">
                  {list.length === 0 ? (
                    <div className="kanban__empty">—</div>
                  ) : (
                    list.map((t) => {
                      const due = effDue(t)
                      const overdue = !!due && effStatus(t) !== 'done' && due < today
                      const high = effPriority(t) === 'high'
                      const ck = categoryKey(t)
                      const hsl = ck ? catColors.get(ck.key) : undefined
                      const cat = ck && hsl ? { kind: ck.kind, hsl } : null
                      return (
                        <div
                          key={t.path}
                          role="button"
                          tabIndex={0}
                          className={`kanban__card${cat ? ' kanban__card--cat' : ''}${high ? ' kanban__card--high' : ''}${dragPath === t.path ? ' kanban__card--dragging' : ''}`}
                          style={
                            cat ? `--cat-h:${cat.hsl[0]};--cat-s:${cat.hsl[1]}%;--cat-l:${cat.hsl[2]}%` : undefined
                          }
                          draggable
                          onDragStart={(e) => {
                            if (e.dataTransfer) {
                              e.dataTransfer.setData('text/plain', t.path)
                              e.dataTransfer.effectAllowed = 'move'
                            }
                            setDragPath(t.path)
                          }}
                          onDragEnd={() => {
                            setDragPath(null)
                            setOverCol(null)
                          }}
                          onClick={() => onOpen(t.path)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              onOpen(t.path)
                            }
                          }}
                        >
                          <div className="kanban__card-head">
                            <span className="kanban__card-title">{t.title}</span>
                            {onSetPriority ? (
                              <button
                                type="button"
                                className={`kanban__flame${high ? ' kanban__flame--on' : ''}`}
                                title={high ? 'High priority — click to clear' : 'Flag as high priority'}
                                aria-label={high ? 'Clear high priority' : 'Flag as high priority'}
                                aria-pressed={high}
                                draggable={false}
                                onDragStart={(e) => e.preventDefault()}
                                onKeyDown={(e) => e.stopPropagation()}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  changePriority(t, high ? '' : 'high')
                                }}
                              >
                                🔥
                              </button>
                            ) : null}
                          </div>
                          {onSetDue || due || t.project || t.projectIdea || t.area || t.owes.length ? (
                            <span className="kanban__chips">
                              {onSetDue ? (
                                <DueEditor due={due} overdue={overdue} onChange={(d) => changeDue(t, d)} />
                              ) : due ? (
                                <span
                                  className={`kanban__chip${overdue ? ' kanban__chip--overdue' : ''}`}
                                >
                                  {overdue ? 'overdue ' : 'due '}
                                  {due}
                                </span>
                              ) : null}
                              {t.project ? (
                                <span
                                  className={`kanban__chip ${cat?.kind === 'project' ? 'kanban__chip--cat' : 'kanban__chip--project'}`}
                                >
                                  {t.project}
                                </span>
                              ) : null}
                              {t.projectIdea ? (
                                <span
                                  className={`kanban__chip${cat?.kind === 'project-idea' ? ' kanban__chip--cat' : ''}`}
                                  title="Project idea (exploratory — not yet a committed project)"
                                >
                                  💡 {t.projectIdea}
                                </span>
                              ) : null}
                              {t.area ? (
                                <span
                                  className={`kanban__chip${cat?.kind === 'area' ? ' kanban__chip--cat' : ''}`}
                                >
                                  {t.area}
                                </span>
                              ) : null}
                              {t.owes.map((o) => (
                                <span key={o} className="kanban__chip kanban__chip--owes">
                                  owe {o}
                                </span>
                              ))}
                            </span>
                          ) : null}
                        </div>
                      )
                    })
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

// A card's due chip, editable in place: the chip opens a native date picker
// (or "+ due" when unset); a successful pick/clear persists via `onChange`.
// Clicks/keys are stopped from bubbling so they don't open the reader or drag.
function DueEditor({
  due,
  overdue,
  onChange,
}: {
  due: string
  overdue: boolean
  onChange: (due: string) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const openPicker = (e: Event) => {
    e.stopPropagation()
    const el = ref.current
    if (el && typeof el.showPicker === 'function') {
      try {
        el.showPicker()
        return
      } catch {
        /* not allowed here — fall back to focusing the input */
      }
    }
    el?.focus()
  }
  return (
    <span
      className="kanban__due-edit"
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={`kanban__chip kanban__chip--due${due ? '' : ' kanban__chip--due-empty'}${overdue ? ' kanban__chip--overdue' : ''}`}
        onClick={openPicker}
      >
        {due ? `${overdue ? 'overdue' : 'due'} ${due}` : '+ due'}
      </button>
      <input
        ref={ref}
        type="date"
        className="kanban__due-input"
        value={due}
        onClick={(e) => e.stopPropagation()}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
      />
      {due ? (
        <button
          type="button"
          className="kanban__due-clear"
          title="Clear due date"
          aria-label="Clear due date"
          onClick={(e) => {
            e.stopPropagation()
            onChange('')
          }}
        >
          ×
        </button>
      ) : null}
    </span>
  )
}
