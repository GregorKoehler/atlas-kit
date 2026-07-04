import { useEffect, useRef, useState } from 'preact/hooks'
import { THEMES, getTheme, setTheme, type ThemeId } from '../lib/theme'

/** Header dropdown to switch the dashboard theme (Jarvis / Claude / …). */
export function ThemeSwitcher() {
  const [theme, setThemeState] = useState<ThemeId>(getTheme())
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const choose = (id: ThemeId) => {
    setTheme(id)
    setThemeState(id)
    setOpen(false)
  }

  const current = THEMES.find((t) => t.id === theme) ?? THEMES[0]

  return (
    <div className="theme-switch" ref={ref}>
      <button
        type="button"
        className="theme-switch__btn hud-label"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Theme: ${current.label}`}
      >
        <span className="theme-switch__swatch" />
        {current.label}
        <span className="theme-switch__caret">▾</span>
      </button>
      {open && (
        <ul className="theme-switch__menu glass" role="listbox">
          {THEMES.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                role="option"
                aria-selected={t.id === theme}
                className={`theme-switch__opt${t.id === theme ? ' is-active' : ''}`}
                onClick={() => choose(t.id)}
              >
                {t.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
