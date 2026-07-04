import { useEffect, useState } from 'preact/hooks'

/**
 * Track a CSS media query from JS. The card grid itself is CSS-driven, but a few
 * ordering decisions differ between the one-column and two-column layouts (e.g.
 * the project cards reorder by recency differently to avoid left↔right swaps on
 * desktop), so they need to know the active breakpoint.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const sync = () => setMatches(mql.matches)
    sync()
    mql.addEventListener('change', sync)
    return () => mql.removeEventListener('change', sync)
  }, [query])
  return matches
}
