import { useEffect, useRef, useState } from 'preact/hooks'
import { motion } from 'framer-motion'
import { cardRise, cardReveal } from './Card'
import { Icon } from '../lib/icons'
import { searchVault, type SearchHit, type SearchLeg, type SearchResult } from '../lib/api'
import { useAddons } from '../lib/addons'

const openable = (h: SearchHit) => !!h.path && h.path.toLowerCase().endsWith('.md')

export function SearchBar({
  onOpenWiki,
  vault,
  placeholder,
}: {
  onOpenWiki: (path: string) => void
  vault?: string
  placeholder?: string
}) {
  const [q, setQ] = useState('')
  const [res, setRes] = useState<SearchResult | null>(null)
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const addons = useAddons()

  useEffect(() => {
    if (q.trim().length < 2) {
      setRes(null)
      return
    }
    let alive = true
    const id = setTimeout(async () => {
      const r = await searchVault(q, vault)
      if (!alive) return
      setRes(r)
      setOpen(true)
    }, 180)
    return () => {
      alive = false
      clearTimeout(id)
    }
  }, [q, vault])

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  const choose = (h: SearchHit) => {
    if (h.path && openable(h)) {
      onOpenWiki(h.path)
      setOpen(false)
      setQ('')
    }
  }

  const hits = res?.items ?? []
  const legs = res?.legs ?? []
  /* 🔴 EACH LEG KEEPS ITS OWN BLOCK. The API returns the full-text ranking and
   * every addon leg separately and never fuses them, and the UI must not undo
   * that by concatenating them into one list: which instrument found a page is
   * itself evidence about how much to trust it, and a dense leg's rows come with
   * a similarity precisely because it CANNOT return nothing. */
  const legHits = legs.filter((l) => l.available && l.items.length > 0)

  /* Two different kinds of "this should be here and is not", and both are worth
   * one amber line rather than silence:
   *   · a registered leg that DID NOT RUN — it says why (encoder reinstalling,
   *     index missing, embed timed out), and that reason is the actionable half;
   *   · an addon that is ENABLED and contributes a search leg, but whose leg is
   *     absent from the response entirely — the UI knows the feature is meant to
   *     exist, so it can say so instead of quietly rendering a narrower search. */
  const warnings = [
    ...legs.filter((l) => !l.available && l.reason).map((l) => `${l.label}: ${l.reason}`),
    ...(res
      ? addons.list
          .filter((a) => a.hooks.includes('searchLeg') && !legs.some((l) => l.addon === a.name))
          .map((a) => `${a.name} is enabled but returned no search leg`)
      : []),
  ]

  const showEmpty = q.trim().length >= 2 && res != null && hits.length === 0 && legHits.length === 0
  const showPanel = open && (hits.length > 0 || legHits.length > 0 || showEmpty || warnings.length > 0)

  const hitRow = (h: SearchHit, key: string) => (
    <li key={key}>
      <button type="button" className="search__hit" onClick={() => choose(h)} disabled={!openable(h)}>
        <span className={`tag ${h.type === 'wiki' ? 'tag--wiki' : ''}`}>
          {h.type === 'wiki' ? 'WIKI' : h.type}
        </span>
        <span className="search__hit-body">
          <span className="search__hit-title">
            {h.title}
            {h.section ? <span className="search__hit-section"> › {h.section}</span> : null}
          </span>
          {h.snippet ? <span className="search__hit-snip">{h.snippet}</span> : null}
        </span>
        <span className="search__hit-sub hud-label">
          {/* The cosine is SHOWN, not thresholded: a top similarity of 0.31 means
              "nothing close", and only the reader can decide that. */}
          {h.similarity != null ? h.similarity.toFixed(2) : h.subtitle}
        </span>
      </button>
    </li>
  )

  const legBlock = (l: SearchLeg) => [
    <li key={`hdr-${l.key}`} className="search__leg hud-label">
      {l.label}
      {l.index?.ageMinutes != null ? <span className="search__leg-age"> · indexed {l.index.ageMinutes} min ago</span> : null}
    </li>,
    ...l.items.map((h, i) => hitRow(h, `${l.key}-${i}`)),
  ]

  return (
    <motion.div ref={boxRef} variants={cardRise} transition={cardReveal} className="search col-span-12">
      <div className="search__pill glass-pill">
        <Icon name="search" className="search__icon h-4 w-4" />
        <input
          className="search__input"
          type="text"
          placeholder={placeholder ?? 'Search the vault and wiki…'}
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
          onFocus={() => {
            if (hits.length || legHits.length) setOpen(true)
          }}
        />
      </div>

      {showPanel ? (
        <ul className="search__results glass">
          {warnings.map((w) => (
            <li key={w} className="search__warn">
              <span aria-hidden="true">⚠</span>
              <span>{w}</span>
            </li>
          ))}
          {showEmpty ? <li className="search__empty">No matches.</li> : null}
          {/* The built-in full-text leg is unlabelled while it is the only one —
              a heading over a single list is noise, and this is exactly the
              zero-addon rendering. */}
          {legHits.length && hits.length ? <li className="search__leg hud-label">Full text</li> : null}
          {hits.map((h, i) => hitRow(h, `lex-${i}`))}
          {legHits.flatMap(legBlock)}
        </ul>
      ) : null}
    </motion.div>
  )
}
