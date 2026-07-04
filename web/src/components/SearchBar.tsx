import { useEffect, useRef, useState } from 'preact/hooks'
import { motion } from 'framer-motion'
import { cardRise, cardReveal } from './Card'
import { Icon } from '../lib/icons'
import { searchVault, type SearchHit } from '../lib/api'

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
  const [hits, setHits] = useState<SearchHit[]>([])
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([])
      return
    }
    let alive = true
    const id = setTimeout(async () => {
      const r = await searchVault(q, vault)
      if (!alive) return
      setHits(r)
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

  const showEmpty = open && q.trim().length >= 2 && hits.length === 0

  return (
    <motion.div
      ref={boxRef}
      variants={cardRise}
      transition={cardReveal}
      className="search col-span-12"
    >
      <div className="search__pill glass-pill">
        <Icon name="search" className="search__icon h-4 w-4" />
        <input
          className="search__input"
          type="text"
          placeholder={placeholder ?? 'Search the vault and wiki…'}
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
          onFocus={() => {
            if (hits.length) setOpen(true)
          }}
        />
      </div>

      {open && hits.length > 0 ? (
        <ul className="search__results glass">
          {hits.map((h, i) => (
            <li key={i}>
              <button
                type="button"
                className="search__hit"
                onClick={() => choose(h)}
                disabled={!openable(h)}
              >
                <span className={`tag ${h.type === 'wiki' ? 'tag--wiki' : ''}`}>
                  {h.type === 'wiki' ? 'WIKI' : h.type}
                </span>
                <span className="search__hit-body">
                  <span className="search__hit-title">{h.title}</span>
                  {h.snippet ? <span className="search__hit-snip">{h.snippet}</span> : null}
                </span>
                <span className="search__hit-sub hud-label">{h.subtitle}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : showEmpty ? (
        <ul className="search__results glass">
          <li className="search__empty">No matches.</li>
        </ul>
      ) : null}
    </motion.div>
  )
}
