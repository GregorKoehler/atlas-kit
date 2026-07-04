import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

export interface DataState<T> {
  data: T | null
  loading: boolean
  error: boolean
  /** Force an immediate refetch (set by useData; absent on one-shot loaders). */
  refetch?: () => void
}

/**
 * Poll a loader on an interval. Keeps the last good value visible across
 * refetches; a failed/missing fetch flips `error` but does not blank the
 * card.
 *
 * Polling is skipped while the tab/app is hidden (TV asleep, phone in pocket)
 * and a fresh fetch fires the moment it becomes visible again — so you never
 * see stale data when actually looking, while an unseen dashboard makes zero
 * requests. This matters because every request goes through the tunnel and
 * counts against its quota.
 */
export function useData<T>(loader: () => Promise<T | null>, intervalMs = 60000): DataState<T> {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  // Holds the live tick fn so the stable refetch() below can invoke it.
  const tickRef = useRef<() => void>(() => {})

  useEffect(() => {
    let alive = true
    const tick = async () => {
      if (document.hidden) return // don't poll a dashboard nobody is looking at
      const result = await loaderRef.current()
      if (!alive) return
      if (result == null) {
        setError(true)
      } else {
        setData(result)
        setError(false)
      }
      setLoading(false)
    }
    tickRef.current = tick
    tick()
    const id = setInterval(tick, intervalMs)
    // Refresh immediately on return so a paused tab is never stale when looked at.
    const onVisible = () => {
      if (!document.hidden) tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [intervalMs])

  const refetch = useCallback(() => tickRef.current(), [])
  return { data, loading, error, refetch }
}

/** One-shot loader that re-runs when `deps` change (for click-driven fetches). */
export function useAsync<T>(loader: () => Promise<T | null>, deps: unknown[]): DataState<T> {
  const [state, setState] = useState<DataState<T>>({ data: null, loading: true, error: false })
  const loaderRef = useRef(loader)
  loaderRef.current = loader

  useEffect(() => {
    let alive = true
    setState({ data: null, loading: true, error: false })
    loaderRef.current().then((result) => {
      if (!alive) return
      setState({ data: result, loading: false, error: result == null })
    })
    return () => {
      alive = false
    }
  }, deps)

  return state
}
