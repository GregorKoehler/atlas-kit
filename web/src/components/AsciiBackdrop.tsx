import { useEffect, useRef, useState } from 'preact/hooks'

/* A faint, cursor-reactive ASCII field behind the dashboard — the "neural
 * background" trope, but honest about it: a static monospace texture that
 * lights up under the cursor. Ported (Canvas2D, no deps) from performativeUI's
 * ascii-hero `bare` variant.
 *
 * Driven by the orthogonal <html data-backdrop> marker (set in lib/theme.ts),
 * so it layers onto any base palette and renders nothing without it:
 *   - "hud"   (Jarvis):        cyan glow over the dark bg  — screen blend (CSS)
 *   - "paper" (Jarvis Claude): warm ink on the paper bg    — multiply blend (CSS)
 *
 * TV-safe by construction: the field is STATIC (no idle animation). The only
 * motion is the cursor spotlight, so a cursorless TV shows a still texture and
 * the draw loop parks itself after the pointer goes idle. */

const RAMP = " .`'\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$"

type Mode = 'hud' | 'paper'
// Per-mode palette + alphas. Blend mode lives in CSS (screen vs. multiply).
const MODES: Record<Mode, { palette: string[]; base: number; spot: number }> = {
  hud: { palette: ['#22d3ee', '#2dd4bf', '#67e8f9'], base: 0.07, spot: 0.42 },
  paper: { palette: ['#3a322a', '#5c5246', '#b8461f'], base: 0.1, spot: 0.3 },
}

const FONT_SIZE = 12
const SPOT_RADIUS = 9 // cells
const RIPPLE_STRENGTH = 1.2
const RIPPLE_RADIUS = 6 // cells
const FRAME_MS = 33 // ~30fps cap while reactive
const IDLE_MS = 1500 // park the loop this long after the last pointer move

const readMode = (): Mode | null => {
  const b = document.documentElement.dataset.backdrop
  return b === 'hud' || b === 'paper' ? b : null
}

export function AsciiBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [mode, setMode] = useState<Mode | null>(readMode)

  // Self-gate to the backdrop marker by watching <html data-backdrop> (themes
  // toggle it through applyTheme — see lib/theme.ts).
  useEffect(() => {
    const el = document.documentElement
    const obs = new MutationObserver(() => setMode(readMode()))
    obs.observe(el, { attributes: true, attributeFilter: ['data-backdrop'] })
    return () => obs.disconnect()
  }, [])

  useEffect(() => {
    if (!mode) return
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const { palette, base: baseOpacity, spot: spotOpacity } = MODES[mode]

    let raf = 0
    let lastFrame = 0
    let lastMove = -Infinity // ms timestamp of the last pointer move
    let restDrawn = false // have we painted the idle (no-spotlight) frame?
    let cols = 0
    let rows = 0
    let cellW = 0
    let cellH = 0
    let baseField = new Float32Array(0)
    const mouse = { x: -9999, y: -9999 }

    // A static height field — radial fade + diagonal stripes. Seeded once per
    // resize; never time-varying (TV-safe).
    const seed = () => {
      baseField = new Float32Array(cols * rows)
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const nx = (x / cols) * 2 - 1
          const ny = (y / rows) * 2 - 1
          const r = Math.sqrt(nx * nx + ny * ny)
          const stripes = 0.5 + 0.5 * Math.sin(nx * 6 + ny * 2)
          const radial = 1 - Math.min(1, r * 1.2)
          baseField[y * cols + x] = 0.25 * stripes + 0.55 * radial
        }
      }
    }

    const resize = () => {
      const w = window.innerWidth
      const h = window.innerHeight
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, Math.floor(w * dpr))
      canvas.height = Math.max(1, Math.floor(h * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.font = `${FONT_SIZE}px 'JetBrains Mono', ui-monospace, monospace`
      ctx.textBaseline = 'top'
      cellW = ctx.measureText('M').width || FONT_SIZE * 0.6
      cellH = FONT_SIZE * 1.15
      cols = Math.max(1, Math.floor(w / cellW))
      rows = Math.max(1, Math.floor(h / cellH))
      seed()
      restDrawn = false
    }

    const draw = (spotlight: boolean) => {
      const w = canvas.width
      const h = canvas.height
      ctx.clearRect(0, 0, w, h)
      const cx = mouse.x / cellW
      const cy = mouse.y / cellH
      const rampMax = RAMP.length - 1
      const spotR2 = SPOT_RADIUS * SPOT_RADIUS * 2
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const fieldVal = baseField[y * cols + x]
          const dx = x - cx
          const dy = (y - cy) * 1.8
          const d2 = dx * dx + dy * dy
          const d = Math.sqrt(d2)
          const ripple = spotlight
            ? RIPPLE_STRENGTH * Math.exp(-d2 / 80) -
              0.6 * Math.exp(-((d - RIPPLE_RADIUS) * (d - RIPPLE_RADIUS)) / 30)
            : 0
          const v = Math.max(0, Math.min(1, fieldVal + ripple))
          const ch = RAMP[Math.floor(v * rampMax)]
          if (ch === ' ') continue
          let alpha = baseOpacity
          if (spotlight) {
            const spot = Math.exp(-d2 / spotR2)
            alpha = baseOpacity + (spotOpacity - baseOpacity) * spot
          }
          if (alpha <= 0.01) continue
          const hue = Math.floor(Math.abs((x * 0.1 + y * 0.07) % palette.length))
          ctx.globalAlpha = alpha
          ctx.fillStyle = palette[hue % palette.length]
          ctx.fillText(ch, x * cellW, y * cellH)
        }
      }
      ctx.globalAlpha = 1
    }

    const render = (t: number) => {
      raf = requestAnimationFrame(render)
      if (t - lastFrame < FRAME_MS) return
      lastFrame = t
      if (cols === 0) {
        resize()
        return
      }
      const active = t - lastMove < IDLE_MS // pointer moved recently
      if (!active && restDrawn) return // idle: the still frame is already up
      const rect = canvas.getBoundingClientRect()
      const inside =
        mouse.x >= rect.left - 24 &&
        mouse.x <= rect.right + 24 &&
        mouse.y >= rect.top - 24 &&
        mouse.y <= rect.bottom + 24
      draw(active && inside)
      if (!active) restDrawn = true // parked until the next move re-arms us
    }

    const onMove = (e: MouseEvent) => {
      mouse.x = e.clientX
      mouse.y = e.clientY
      lastMove = performance.now()
      restDrawn = false
    }

    resize()
    window.addEventListener('resize', resize)
    window.addEventListener('mousemove', onMove, { passive: true })
    raf = requestAnimationFrame(render)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMove)
    }
  }, [mode])

  if (!mode) return null
  return <canvas ref={canvasRef} className="ascii-backdrop" aria-hidden="true" />
}
