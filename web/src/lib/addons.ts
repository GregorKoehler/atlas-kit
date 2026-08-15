/* ------------------------------------------------------------------ *
 * Which optional addons this box runs — the RUNTIME gate for addon surfaces.
 *
 * One build of `web/dist` serves every install, so a card, a section or a
 * warning must appear because the addon is enabled ON THIS BOX, never because
 * someone compiled a different bundle. `GET /api/addons` is that fact.
 *
 * Polled rather than fetched once: enabling an addon is an operator action
 * followed by an API restart, and a dashboard left open on a wall should pick it
 * up without a reload. Five minutes is far more often than addons change and far
 * cheaper than the dashboard bundle already polled beside it.
 * ------------------------------------------------------------------ */
import { useData } from './useData'
import { fetchAddons, type AddonInfo, type AddonsView } from './api'

const POLL_MS = 5 * 60 * 1000

/* One answer serves every caller in the window. This started as one call per
 * card; MicField made it one per TEXT FIELD, and a Kanban with its new-task
 * fields open would otherwise fire half a dozen identical requests through the
 * tunnel on mount. Each subscriber keeps its own timer (they drift apart), so
 * the cache is a TTL rather than a shared loop — half the poll interval, which
 * collapses the mount storm without ever serving an answer older than one cycle. */
let cached: { at: number; view: Promise<AddonsView | null> } | null = null
function fetchAddonsShared(): Promise<AddonsView | null> {
  const now = Date.now()
  if (!cached || now - cached.at > POLL_MS / 2) cached = { at: now, view: fetchAddons() }
  return cached.view
}

export function useAddons() {
  const { data } = useData<AddonsView>(fetchAddonsShared, POLL_MS)
  const list = data?.addons ?? []
  return {
    /** False until the first answer — callers must not read "not yet loaded"
     *  as "not enabled", which would flash an addon surface out of existence. */
    ready: data != null,
    list,
    enabled: (name: string) => list.some((a) => a.name === name),
    get: (name: string): AddonInfo | null => list.find((a) => a.name === name) ?? null,
  }
}
