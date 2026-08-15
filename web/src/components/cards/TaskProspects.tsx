import { useState } from 'preact/hooks'
import { Card, EmptyState } from '../Card'
import { useData } from '../../lib/useData'
import { fetchProspects, approveProspect, rejectProspect, type TaskProspect } from '../../lib/api'

/* Task Prospects — the review inbox for work the AGENTS proposed rather than
 * filed. Nothing here exists in the vault yet: Approve writes the real
 * `Tasks/<slug>.md` note through the same serial commit queue every other task
 * write uses, and Reject discards it without the vault ever seeing it.
 *
 * Both actions hide the row OPTIMISTICALLY and restore it if the server says no
 * — a queue you have to wait on is a queue you stop using, and the failure case
 * (a commit that didn't land) must not look like a success. */
export function TaskProspects({ className = '' }: { className?: string }) {
  const { data: prospects, refetch } = useData(fetchProspects, 30000)
  // Rows hidden pending their server round-trip; restored on failure.
  const [gone, setGone] = useState<Set<string>>(new Set())
  const drop = (key: string) => setGone((g) => new Set(g).add(key))
  const restore = (key: string) =>
    setGone((g) => {
      const next = new Set(g)
      next.delete(key)
      return next
    })

  const pending = (prospects ?? []).filter((p) => !gone.has(p.id))

  const approve = async (p: TaskProspect, edits?: { title?: string; due?: string; area?: string }) => {
    drop(p.id)
    const r = await approveProspect(p.id, edits)
    if (!r.ok) restore(p.id)
    else refetch?.()
  }
  const reject = async (id: string) => {
    drop(id)
    const r = await rejectProspect(id)
    if (!r.ok) restore(id)
  }

  return (
    <Card
      title="Task prospects"
      className={className}
      actions={pending.length ? <span className="atlas-lens__count">{pending.length}</span> : null}
    >
      <div className="dpass">
        <p className="dpass__sub">
          Follow-up work your agents PROPOSED rather than filed. Nothing reaches the board until you approve it.
        </p>
        {pending.length ? (
          <ul className="dpass__list">
            {pending.map((p) => (
              <ProspectRow key={p.id} p={p} onApprove={approve} onReject={reject} />
            ))}
          </ul>
        ) : (
          <EmptyState>No proposals waiting.</EmptyState>
        )}
      </div>
    </Card>
  )
}

function ProspectRow({
  p,
  onApprove,
  onReject,
}: {
  p: TaskProspect
  onApprove: (p: TaskProspect, edits?: { title?: string; due?: string; area?: string }) => Promise<void>
  onReject: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(p.title)
  const [due, setDue] = useState(p.due || '')
  const [area, setArea] = useState(p.area || '')
  const [busy, setBusy] = useState(false)

  const approveNow = async () => {
    if (busy) return
    setBusy(true)
    await onApprove(p, editing ? { title, due: due || undefined, area: area || undefined } : undefined)
    // On success the parent hides this row (it unmounts); a failure resets busy.
    setBusy(false)
  }

  return (
    <li className="dpass-item">
      <div className="dpass-item__head">
        <span className="dpass-item__chip">{p.producer || p.source || 'prospect'}</span>
        {editing ? (
          <input className="wiki-browse__filter" value={title} onInput={(e) => setTitle(e.currentTarget.value)} />
        ) : (
          <span className="dpass-item__task">{p.title}</span>
        )}
        {p.due ? <span className="dpass-item__conf">{p.due}</span> : null}
      </div>
      {p.body ? <div className="dpass-item__detail">{p.body}</div> : null}
      {editing ? (
        <div className="dpass-item__head">
          <input className="wiki-browse__filter" type="date" value={due} onInput={(e) => setDue(e.currentTarget.value)} />
          <input
            className="wiki-browse__filter"
            placeholder="area / project"
            value={area}
            onInput={(e) => setArea(e.currentTarget.value)}
          />
        </div>
      ) : null}
      <div className="dpass-item__foot">
        <span />
        <div className="dpass-item__btns">
          <button type="button" className="btn" onClick={() => setEditing((v) => !v)} disabled={busy}>
            {editing ? 'Cancel' : 'Edit'}
          </button>
          <button type="button" className="btn btn--approve" onClick={approveNow} disabled={busy}>
            {busy ? '…' : 'Approve'}
          </button>
          <button type="button" className="btn btn--dismiss" onClick={() => onReject(p.id)} disabled={busy}>
            Reject
          </button>
        </div>
      </div>
    </li>
  )
}
