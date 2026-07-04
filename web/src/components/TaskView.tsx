import { useEffect, useRef, useState } from 'preact/hooks'
import { Markdown, renderInline, type MdOptions } from '../lib/markdown'
import { parseTaskMeta, taskBody, asList } from '../lib/task'
import { useAsync } from '../lib/useData'
import { displayCategory, fetchTaskCategories, resolveCategory, setTaskCategory, setTaskBody, moveTask, isTypedVault } from '../lib/api'
import { CategoryPicker } from './CategoryPicker'
import { MicField } from './MicField'

/* A focused view for a `type: task` note: the typed frontmatter (status,
 * priority, due, project/area, links, tags) shown as a header, then the body.
 * Wired in from NoteInline when frontmatter type === "task" — so the Kanban's
 * cards open in full instead of just their one-line body.
 *
 * For typed-vault tasks (the Atlas or a sibling like a sibling vault, with a known
 * path) the status/project/area/body are editable instead of static chips — so
 * the operator can set or correct them; the commit re-colours the Kanban card. */

const STATUS_LABEL: Record<string, string> = {
  inbox: 'Inbox',
  next: 'Next',
  doing: 'Doing',
  waiting: 'Waiting',
  done: 'Done',
}
// The Kanban column order — the segmented move control walks it left→right.
const STATUS_ORDER = ['inbox', 'next', 'doing', 'waiting', 'done']

function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// "[[Project-X|alias]]" / "Project-X" → "Project-X" (the picker's plain value).
const linkText = (s: string) => s.replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0].split('#')[0].trim()
const firstLink = (v?: string | string[]) => asList(v).map(linkText).filter(Boolean)[0] || ''

export function TaskView({ source, path, options }: { source: string; path?: string; options?: MdOptions }) {
  const meta = parseTaskMeta(source)
  const sourceBody = taskBody(source)
  const opts = options ?? {}
  // Status is local state so a tap-to-move (the editable segmented control
  // below) reflects immediately. The reader doesn't refetch the note, so seed
  // from the parsed meta and reset when it navigates to another note.
  const [status, setStatus] = useState((meta.status || 'inbox').toLowerCase())
  useEffect(() => {
    setStatus((meta.status || 'inbox').toLowerCase())
  }, [source])
  const overdue = !!meta.due && status !== 'done' && meta.due < todayStr()

  // Editable only where there's a write surface for it (a typed Atlas vault —
  // the main Atlas or a sibling like a sibling vault; the task writes target it).
  const editable = isTypedVault(opts.vault) && !!path
  const { data: cats } = useAsync(
    () => (editable ? fetchTaskCategories(opts.vault) : Promise.resolve(null)),
    [editable, opts.vault],
  )
  // The picker speaks `project:Name` / `project-idea:Name` / `area:Name`; the
  // current value renders the same way, and '' is no category.
  const curCat = displayCategory(
    firstLink(meta.for_project),
    firstLink(meta.for_project_idea),
    firstLink(meta.area),
  )
  const [catText, setCatText] = useState(curCat)
  // Refs so the commit can run from the picker AND the unmount flush below
  // without going stale: `savedRef` is the value persisted to the Atlas (the
  // de-dupe guard — it also survives across edits since the reader doesn't
  // refetch the note); `draftRef` is the latest typed value to flush on close.
  const savedRef = useRef(curCat)
  const draftRef = useRef(curCat)
  const pathRef = useRef(path)
  pathRef.current = path
  const catsRef = useRef(cats)
  catsRef.current = cats
  const changedRef = useRef(opts.onTaskChanged)
  changedRef.current = opts.onTaskChanged
  useEffect(() => {
    savedRef.current = curCat
    draftRef.current = curCat
    setCatText(curCat)
  }, [curCat])

  // Tap-to-move: the editable status control commits a column change via the
  // same endpoint as the desktop drag (the touch path, since drag-and-drop is
  // mouse-only). Optimistic — the status flips now; a failed commit reverts,
  // a successful one re-polls the Kanban so the card lands in its new column.
  const [moving, setMoving] = useState(false)
  const moveStatus = (next: string) => {
    const p = pathRef.current
    if (!p || next === status || moving) return
    const prev = status
    setStatus(next)
    setMoving(true)
    moveTask(p, next, opts.vault).then((r) => {
      setMoving(false)
      if (r.ok === false) setStatus(prev)
      else changedRef.current?.()
    })
  }

  // Persist a category change, guarded by savedRef so re-committing the same
  // value (and the close flush) doesn't re-POST. No per-keystroke commit: this
  // fires only on a dropdown pick, on Enter, or from the close flush.
  const commitCat = (display: string) => {
    const p = pathRef.current
    if (!p) return
    const next = display.trim()
    const prev = savedRef.current
    if (next.toLowerCase() === prev.trim().toLowerCase()) return
    savedRef.current = next
    setTaskCategory(p, resolveCategory(next, catsRef.current), opts.vault).then((r) => {
      if (r.ok) changedRef.current?.()
      else savedRef.current = prev // failed → let a later flush/retry re-send it
    })
  }

  // Wait until the operator is done with the card: flush any pending typed value
  // when the reader closes or navigates away (TaskView unmounts).
  useEffect(() => () => commitCat(draftRef.current), [])

  // Editable body (the description below the title), behind explicit Edit/Save —
  // only on the Atlas, where there's a write surface. `bodyText` is what's shown;
  // a save persists it and (since the reader doesn't refetch) updates it locally.
  // Unlike the category picker there's no close-flush: Save commits, Cancel/close
  // discards. The title may live in the first body line, so a save re-polls the
  // Kanban (onTaskChanged) to pick up a changed title.
  const [bodyText, setBodyText] = useState(sourceBody)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(sourceBody)
  const [saving, setSaving] = useState(false)
  const [bodyErr, setBodyErr] = useState<string | null>(null)
  // Reset when the reader navigates to a different note.
  useEffect(() => {
    setBodyText(sourceBody)
    setEditing(false)
    setBodyErr(null)
  }, [sourceBody])

  const saveBody = async () => {
    const p = pathRef.current
    if (!p) return
    const next = draft.replace(/\r\n/g, '\n').trim()
    if (next === bodyText.trim()) {
      setEditing(false)
      return
    }
    setSaving(true)
    setBodyErr(null)
    const r = await setTaskBody(p, next, opts.vault)
    setSaving(false)
    if (r.ok) {
      setBodyText(next)
      setEditing(false)
      changedRef.current?.() // re-poll the Kanban — a changed first line moves the title
    } else {
      setBodyErr(r.error || 'Could not save')
    }
  }

  // A typed-edge chip group: label + each [[link]] rendered clickable.
  const edge = (label: string, vals: string[], mod: string) =>
    vals.map((v, i) => (
      <span key={`${mod}${i}`} className={`task__chip task__chip--${mod}`}>
        <span className="task__chip-k">{label}</span> {renderInline(v, opts)}
      </span>
    ))

  return (
    <div className="task">
      <div className="task__meta">
        {editable ? (
          <div className="task__statusbar" role="group" aria-label="Status — tap a column to move">
            {STATUS_ORDER.map((s) => (
              <button
                key={s}
                type="button"
                className={`task__status-btn task__status-btn--${s}${s === status ? ' task__status-btn--active' : ''}`}
                aria-pressed={s === status}
                disabled={moving}
                onClick={() => moveStatus(s)}
              >
                {STATUS_LABEL[s]}
              </button>
            ))}
          </div>
        ) : (
          <span className={`task__status task__status--${status}`}>{STATUS_LABEL[status] ?? status}</span>
        )}
        {meta.priority ? (
          <span className={`task__prio task__prio--${meta.priority.toLowerCase()}`}>{meta.priority}</span>
        ) : null}
        {meta.due ? (
          <span className={`task__chip${overdue ? ' task__chip--overdue' : ''}`}>
            <span className="task__chip-k">{overdue ? 'overdue' : 'due'}</span> {meta.due}
          </span>
        ) : null}
        {meta.done ? (
          <span className="task__chip">
            <span className="task__chip-k">done</span> {meta.done}
          </span>
        ) : null}
        {editable ? (
          <span className="task__catedit">
            <span className="task__chip-k">project / idea / area</span>
            <CategoryPicker
              value={catText}
              categories={cats}
              placeholder="project:Name, project-idea:Name or area:Name"
              onInput={(v) => {
                setCatText(v)
                draftRef.current = v
              }}
              onCommit={commitCat}
            />
          </span>
        ) : (
          <>
            {edge('project', asList(meta.for_project), 'project')}
            {edge('project idea', asList(meta.for_project_idea), 'idea')}
            {edge('area', asList(meta.area), 'area')}
          </>
        )}
        {edge('depends on', asList(meta.depends_on), 'dep')}
        {edge('owe', asList(meta.owes), 'owes')}
        {edge('owed by', asList(meta.owed_by), 'owes')}
      </div>

      {meta.tags?.length ? (
        <div className="task__tags">
          {meta.tags.map((t) => (
            <span key={t} className="task__tag">
              #{t}
            </span>
          ))}
        </div>
      ) : null}

      <div className={`task__body${editing ? ' task__body--editing' : ''}`}>
        {editing ? (
          <>
            <MicField value={draft} onChange={setDraft} multiline>
              <textarea
                className="task__body-input"
                placeholder="Description (markdown) — the title is the first line"
                value={draft}
                disabled={saving}
                onInput={(e) => setDraft((e.target as HTMLTextAreaElement).value)}
                autoFocus
              />
            </MicField>
            {bodyErr ? <div className="task__body-err">{bodyErr}</div> : null}
            <div className="task__body-actions">
              <button type="button" className="btn btn--approve" disabled={saving} onClick={saveBody}>
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                className="btn"
                disabled={saving}
                onClick={() => {
                  setEditing(false)
                  setBodyErr(null)
                }}
              >
                Cancel
              </button>
            </div>
          </>
        ) : (
          <>
            {editable ? (
              <button
                type="button"
                className="btn task__body-edit"
                onClick={() => {
                  setDraft(bodyText)
                  setBodyErr(null)
                  setEditing(true)
                }}
              >
                {bodyText ? 'Edit' : '+ Add description'}
              </button>
            ) : null}
            {bodyText ? (
              <Markdown source={bodyText} options={opts} />
            ) : (
              <p className="task__empty">No description.</p>
            )}
          </>
        )}
      </div>

      {meta.created || meta.updated ? (
        <div className="task__foot">
          {meta.created ? <span>created {meta.created}</span> : null}
          {meta.updated ? <span>updated {meta.updated}</span> : null}
        </div>
      ) : null}
    </div>
  )
}
