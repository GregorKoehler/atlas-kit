/* ------------------------------------------------------------------ *
 * Theme switching. Each theme is a set of CSS-variable overrides keyed
 * off <html data-theme="…"> (see styles/tokens.css). The out-of-the-box
 * default is "contrast-claude" (a warm-paper / terracotta look); "jarvis"
 * is the Holographic HUD (dark, cyan-on-black), fully available in the
 * ThemeSwitcher. Selection persists in localStorage.
 * ------------------------------------------------------------------ */
export type ThemeId = 'jarvis' | 'claude' | 'contrast-claude' | 'jarvis-claude'

export const THEMES: { id: ThemeId; label: string }[] = [
  { id: 'jarvis', label: 'Jarvis' },
  { id: 'jarvis-claude', label: 'Jarvis Claude' },
  { id: 'claude', label: 'Claude' },
  { id: 'contrast-claude', label: 'Contrast Claude' },
]

const KEY = 'atlas-kit-theme'

export function getTheme(): ThemeId {
  try {
    const t = localStorage.getItem(KEY)
    if (t === 'jarvis' || t === 'claude' || t === 'contrast-claude' || t === 'jarvis-claude')
      return t
  } catch {
    /* localStorage unavailable — fall through to default */
  }
  return 'contrast-claude'
}

/** Apply a theme to the document (no persistence).
 *
 * The ASCII backdrop is an orthogonal layer signalled by `data-backdrop`, so
 * "jarvis-claude" is just the contrast-claude palette with the paper backdrop
 * layered on — it renders as `data-theme="contrast-claude"` plus the marker. */
export function applyTheme(t: ThemeId): void {
  const root = document.documentElement
  if (t === 'jarvis-claude') {
    root.dataset.theme = 'contrast-claude'
    root.dataset.backdrop = 'paper'
  } else if (t === 'jarvis') {
    root.dataset.theme = 'jarvis'
    root.dataset.backdrop = 'hud'
  } else {
    root.dataset.theme = t
    delete root.dataset.backdrop
  }
}

/** Apply AND remember the choice. */
export function setTheme(t: ThemeId): void {
  applyTheme(t)
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* best-effort; the in-memory attribute still applies */
  }
}
