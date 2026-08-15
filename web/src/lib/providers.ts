/* ------------------------------------------------------------------ *
 * Which model-BACKEND profiles this box offers — the RUNTIME gate for the
 * spawn form's provider picker.
 *
 * Same shape (and same reason) as lib/addons.ts: one build of `web/dist` serves
 * every install, so the picker must appear because THIS box has profiles
 * configured, never because someone compiled a different bundle. A kit with no
 * `providers.json` gets an empty list and no picker at all.
 *
 * Names and labels only — a profile's env (the operator's API key) never leaves
 * the server, so there is nothing here to keep out of the browser.
 * ------------------------------------------------------------------ */
import { useData } from './useData'
import { fetchProviders, type ProviderProfile, type ProvidersView } from './api'

const POLL_MS = 5 * 60 * 1000

/* One answer serves every spawn form in the window — the global Dev Agents card
 * and one per project card would otherwise each poll. TTL-shared exactly like
 * fetchAddonsShared, for the same mount-storm reason. */
let cached: { at: number; view: Promise<ProvidersView | null> } | null = null
function fetchProvidersShared(): Promise<ProvidersView | null> {
  const now = Date.now()
  if (!cached || now - cached.at > POLL_MS / 2) cached = { at: now, view: fetchProviders() }
  return cached.view
}

export function useProviders(): ProviderProfile[] {
  const { data } = useData<ProvidersView>(fetchProvidersShared, POLL_MS)
  return data?.providers ?? []
}
