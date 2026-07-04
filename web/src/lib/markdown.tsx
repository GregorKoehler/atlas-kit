/* ------------------------------------------------------------------ *
 * Minimal, dependency-free markdown renderer (no CDN, no innerHTML).
 * Renders the subset the wiki uses: headings, paragraphs, bold/italic,
 * inline code, links, [[wikilinks]], blockquotes, ordered/unordered
 * lists, hr, code blocks, and the recipes vault's `{timer: 20m}` step
 * convention (rendered as a live countdown chip).
 * Output is Preact VNodes, so it is XSS-safe by construction.
 * ------------------------------------------------------------------ */
import type { ComponentChildren, JSX } from 'preact'
import { useEffect, useState } from 'preact/hooks'

export interface MdOptions {
  onWikiLink?: (target: string) => void
  // Vault-relative folder of the note being rendered, used to resolve relative
  // image paths (e.g. `assets/foo/01.jpg`) to the /api/asset endpoint.
  basePath?: string
  // The vault the note lives in. Threaded onto the asset URL so images on a
  // non-default vault's pages (e.g. recipes) resolve there, not the default vault.
  vault?: string
  // Fired after an in-reader edit persists (the Atlas TaskView's project/area
  // picker), so the opener (e.g. the Kanban) can re-poll and reflect the change.
  onTaskChanged?: () => void
}

// Turn a markdown image src into a loadable URL. Absolute/data URLs pass
// through; vault-relative paths are resolved against the note's folder and
// served via /api/asset (carrying the vault so it reads the right repo).
function resolveImageSrc(src: string, basePath?: string, vault?: string): string {
  if (/^(https?:|data:)/i.test(src)) return src
  let rel = src.replace(/^\.\//, '')
  if (!rel.startsWith('/') && basePath) rel = basePath.replace(/\/+$/, '') + '/' + rel
  const q = vault ? `&vault=${encodeURIComponent(vault)}` : ''
  return `/api/asset?path=${encodeURIComponent(rel.replace(/^\/+/, ''))}${q}`
}

// Split a GFM table row into trimmed cells, tolerating optional outer pipes.
// Splits only on UNescaped pipes, then unescapes `\|` (e.g. inside a
// [[wikilink\|alias]]) so it survives as literal text in the cell.
function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'))
}
// A table's separator row: every cell is dashes with optional alignment colons.
function isTableSeparator(line: string): boolean {
  if (!line.includes('-')) return false
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c))
}

export function Markdown({ source, options }: { source: string; options?: MdOptions }) {
  return <div className="prose">{renderBlocks(stripFrontmatter(source), options ?? {})}</div>
}

export function stripFrontmatter(md: string): string {
  if (md.startsWith('---')) {
    const end = md.indexOf('\n---', 3)
    if (end !== -1) {
      const nl = md.indexOf('\n', end + 1)
      return nl !== -1 ? md.slice(nl + 1) : ''
    }
  }
  return md
}

function renderBlocks(md: string, opts: MdOptions): JSX.Element[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out: JSX.Element[] = []
  let i = 0
  let key = 0
  const k = () => `b${key++}`

  while (i < lines.length) {
    const line = lines[i]

    if (line.trim() === '') {
      i++
      continue
    }

    // Code fence
    if (line.trim().startsWith('```')) {
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i])
        i++
      }
      i++ // closing fence
      out.push(
        <pre key={k()} className="prose__pre">
          <code>{buf.join('\n')}</code>
        </pre>,
      )
      continue
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push(<hr key={k()} className="prose__hr" />)
      i++
      continue
    }

    // Heading
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      const Tag = `h${Math.min(level, 6)}` as keyof JSX.IntrinsicElements
      out.push(
        <Tag key={k()} className={`prose__h prose__h${level}`}>
          {renderInline(h[2], opts)}
        </Tag>,
      )
      i++
      continue
    }

    // Blockquote / callout (consecutive '>' lines). An Obsidian callout starts
    // with `[!type] Optional Title` on the first line.
    if (line.startsWith('>')) {
      const buf: string[] = []
      while (i < lines.length && lines[i].startsWith('>')) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i++
      }
      const co = buf[0]?.match(/^\[!(\w+)\]\s*(.*)$/)
      if (co) {
        const type = co[1].toLowerCase()
        const title = co[2].trim() || type.charAt(0).toUpperCase() + type.slice(1)
        const body = buf.slice(1).join(' ').trim()
        out.push(
          <div key={k()} className={`prose__callout prose__callout--${type}`}>
            <div className="prose__callout-title">{title}</div>
            {body ? <div className="prose__callout-body">{renderInline(body, opts)}</div> : null}
          </div>,
        )
      } else {
        out.push(
          <blockquote key={k()} className="prose__quote">
            {renderInline(buf.join(' '), opts)}
          </blockquote>,
        )
      }
      continue
    }

    // GFM table: a header row immediately followed by a `---` separator row.
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = splitTableRow(line)
      i += 2 // consume header + separator
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(splitTableRow(lines[i]))
        i++
      }
      out.push(
        <table key={k()} className="prose__table">
          <thead>
            <tr>
              {header.map((c, ci) => (
                <th key={ci}>{renderInline(c, opts)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((c, ci) => (
                  <td key={ci}>{renderInline(c, opts)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      )
      continue
    }

    // Unordered list (consecutive '- ' / '* ' lines)
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
        i++
      }
      out.push(
        <ul key={k()} className="prose__ul">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, opts)}</li>
          ))}
        </ul>,
      )
      continue
    }

    // Ordered list (consecutive '1. ' / '2. ' lines) — e.g. recipe steps.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      out.push(
        <ol key={k()} className="prose__ol">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it, opts)}</li>
          ))}
        </ol>,
      )
      continue
    }

    // Paragraph (gather until blank or a block starter)
    const buf: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^(#{1,6}\s|>|\s*[-*]\s|\s*\d+\.\s|```|-{3,}\s*$|\*{3,}\s*$)/.test(lines[i])
    ) {
      buf.push(lines[i])
      i++
    }
    out.push(
      <p key={k()} className="prose__p">
        {renderInline(buf.join(' '), opts)}
      </p>,
    )
  }

  return out
}

const INLINE =
  /(!\[[^\]]*\]\([^)]+\))|(`[^`]+`)|(\*\*[^*]+\*\*)|(\[\[[^\]]+\]\])|(\[[^\]]+\]\([^)]+\))|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)|(\{timer:\s*[^}]+\})/g

export function renderInline(text: string, opts: MdOptions): ComponentChildren {
  const nodes: ComponentChildren[] = []
  let last = 0
  let m: RegExpExecArray | null
  let key = 0
  INLINE.lastIndex = 0

  while ((m = INLINE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const token = m[0]

    if (m[1]) {
      const im = token.match(/^!\[([^\]]*)\]\(([^)]+)\)$/)
      if (im) {
        nodes.push(
          <img
            key={key++}
            className="prose__img"
            src={resolveImageSrc(im[2].trim(), opts.basePath, opts.vault)}
            alt={im[1]}
            loading="lazy"
          />,
        )
      } else {
        nodes.push(token)
      }
    } else if (m[2]) {
      nodes.push(<code key={key++} className="prose__code">{token.slice(1, -1)}</code>)
    } else if (m[3]) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>)
    } else if (m[4]) {
      const inner = token.slice(2, -2)
      const [target, alias] = inner.split('|')
      const label = (alias ?? target).trim()
      const tgt = target.trim()
      if (opts.onWikiLink) {
        nodes.push(
          <button
            key={key++}
            type="button"
            className="wikilink"
            onClick={() => opts.onWikiLink?.(tgt)}
          >
            {label}
          </button>,
        )
      } else {
        nodes.push(<span key={key++} className="wikilink wikilink--static">{label}</span>)
      }
    } else if (m[5]) {
      const lm = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (lm) {
        nodes.push(
          <a key={key++} className="prose__a" href={lm[2]} target="_blank" rel="noopener noreferrer">
            {lm[1]}
          </a>,
        )
      } else {
        nodes.push(token)
      }
    } else if (m[6]) {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>)
    } else if (m[7]) {
      nodes.push(<em key={key++}>{token.slice(1, -1)}</em>)
    } else if (m[8]) {
      const spec = token.replace(/^\{timer:\s*/, '').replace(/\}$/, '').trim()
      nodes.push(<TimerChip key={key++} spec={spec} />)
    }

    last = m.index + token.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/* --- {timer: …} recipe-step countdowns --------------------------------- *
 * The recipes vault marks timed steps with `{timer: 20m}` (see its CLAUDE.md).
 * We parse the duration and render a click-to-start countdown chip. Robust to
 * the common spellings — `1h30m`, `90s`, `20 min`, German `20 Minuten`, or a
 * bare number (taken as minutes). Returns 0 (→ literal text) if unparseable. */
function parseDuration(spec: string): number {
  const s = spec.trim().toLowerCase()
  let total = 0
  let matched = false
  const re = /(\d+)\s*(h|hours?|std|stunden?|m|min(?:utes?|uten)?|s|sec(?:onds?|unden)?|sek(?:unden?)?)/g
  let mm: RegExpExecArray | null
  while ((mm = re.exec(s)) !== null) {
    matched = true
    const n = parseInt(mm[1], 10)
    const u = mm[2]
    if (u[0] === 'h' || u.startsWith('st')) total += n * 3600
    else if (u[0] === 'm') total += n * 60
    else total += n // s / sec / sekunde
  }
  if (!matched) {
    const n = parseInt(s, 10)
    if (!Number.isNaN(n)) total = n * 60 // bare number → minutes
  }
  return total
}

function formatClock(total: number): string {
  const t = Math.max(0, total)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const sec = t % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

function TimerChip({ spec }: { spec: string }) {
  const total = parseDuration(spec)
  const [remaining, setRemaining] = useState(total)
  const [running, setRunning] = useState(false)
  const done = total > 0 && remaining <= 0

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => setRemaining((r) => (r <= 1 ? 0 : r - 1)), 1000)
    return () => clearInterval(id)
  }, [running])

  // Stop the interval when it reaches zero (can't set state inside the updater).
  useEffect(() => {
    if (running && remaining <= 0) setRunning(false)
  }, [running, remaining])

  // Unparseable → show the original marker as plain text, don't swallow it.
  if (total <= 0) return <span className="prose__code">{`{timer: ${spec}}`}</span>

  const toggle = () => {
    if (done) return
    setRunning((x) => !x)
  }
  const reset = (e: JSX.TargetedMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    setRunning(false)
    setRemaining(total)
  }
  const showReset = running || done || remaining !== total

  return (
    <span className={`timer${running ? ' timer--running' : ''}${done ? ' timer--done' : ''}`}>
      <button
        type="button"
        className="timer__main"
        onClick={toggle}
        title={done ? 'Done' : running ? 'Pause' : 'Start timer'}
      >
        <span className="timer__icon" aria-hidden="true">
          {done ? '✓' : running ? '❚❚' : '▶'}
        </span>
        <span className="timer__time tnum">{done ? 'done' : formatClock(remaining)}</span>
      </button>
      {showReset ? (
        <button
          type="button"
          className="timer__reset"
          onClick={reset}
          title="Reset"
          aria-label="Reset timer"
        >
          ↺
        </button>
      ) : null}
    </span>
  )
}
