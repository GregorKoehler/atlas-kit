import { createContext } from 'preact'
import type { ComponentChildren } from 'preact'
import { useContext } from 'preact/hooks'
import { useData, type DataState } from './useData'
import { fetchDashboard, type DashboardData } from './api'

const EMPTY: DataState<DashboardData> = { data: null, loading: true, error: false }
const DashboardCtx = createContext<DataState<DashboardData>>(EMPTY)

// One shared poll of /api/dashboard for every Command Center card, so a refresh
// is a single request instead of ~8. Inherits useData's visibility-aware
// polling.
export function DashboardProvider({ children }: { children: ComponentChildren }) {
  const state = useData(() => fetchDashboard())
  return <DashboardCtx.Provider value={state}>{children}</DashboardCtx.Provider>
}

// Read one card's slice from the shared payload, in the same {data, loading,
// error} shape useData returns so cards barely change. `refetch` re-polls the
// whole bundle (e.g. after a card fires an on-demand sync).
export function useDashboardSlice<K extends keyof DashboardData>(
  key: K,
): DataState<DashboardData[K]> {
  const { data, loading, error, refetch } = useContext(DashboardCtx)
  return { data: data ? data[key] : null, loading, error, refetch }
}
