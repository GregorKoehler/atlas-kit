/* ------------------------------------------------------------------ *
 * Pasting a message with screenshots in it — the pure half.
 *
 * Copy a chat or mail message with several inline screenshots and paste it
 * into an agent chat in one go, the way a notes app takes it: paragraphs kept,
 * every image at its place, the agent able to tell which image belongs to
 * which sentence. The composer (components/AgentAttach.tsx) wires the
 * clipboard event; everything that can be decided without a DOM or a network
 * lives here, so it is testable under plain node (pasteImages.test.mjs).
 *
 * The contract with the executors (api/src/agent-attachments.mjs): the text
 * carries `[Image N]` where image N sat, and image N travels as a file named
 * `image-N.<ext>`. The server swaps each marker for `[Image N: <saved path>]`;
 * a marker with no file (unreadable, or its chip removed) is left as typed.
 *
 * An image that cannot be read is never dropped: it keeps its place as
 * `[Image N unreadable: <src>]` and the composer shows a warning. Chat apps
 * often serve images behind authenticated URLs a page cannot fetch; WebKit
 * (Safari, iOS) turns a pasted web archive's subresources into readable
 * `blob:` URLs, other browsers may hand over only the https URL.
 * ------------------------------------------------------------------ */

export interface PastedHtml {
  /** Plain text with line breaks, list bullets and an `[Image N]` per image. */
  text: string
  /** One entry per marker, in document order. */
  images: { n: number; src: string }[]
}

// Elements that end a line. `p` (and headings) end a PARAGRAPH — a blank line —
// because that is what a chat/word-processor/mail paragraph is; a `div` is a
// line, as notes apps and webmail write one div per line (a blank line there is
// its own `<div><br></div>`).
const LINE = new Set([
  'div', 'li', 'tr', 'ul', 'ol', 'table', 'blockquote', 'pre', 'section', 'article',
  'header', 'footer', 'dd', 'dt', 'dl', 'figure', 'figcaption', 'hr', 'address',
])
const PARA = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
// Never text: their content is markup or metadata.
const SKIP = new Set(['style', 'script', 'head', 'title', 'template', 'noscript', 'xml'])

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    }
    return NAMED[e.toLowerCase()] ?? m
  })
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs)
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : null
}

// Chat and mail clients send every emoji as an <img> whose alt IS the emoji —
// that is text, not a screenshot, and must not become a marker or a file.
const EMOJI_ALT = /^[\p{Extended_Pictographic}\p{Emoji_Component}‍️]{1,16}$/u
function emojiOf(attrs: string): string | null {
  const alt = attr(attrs, 'alt')
  const itemtype = attr(attrs, 'itemtype') || ''
  const cls = attr(attrs, 'class') || ''
  const pictographic = !!alt && EMOJI_ALT.test(alt) && /\p{Extended_Pictographic}/u.test(alt)
  if (alt && (pictographic || /emoji|emoticon/i.test(itemtype + ' ' + cls))) return alt
  return null
}

/** Clipboard HTML → plain text with `[Image N]` markers, numbered from `firstN`.
 * Kept plain on purpose: no markdown beyond line breaks and `• ` bullets. */
export function htmlToMarkedText(html: string, firstN: number): PastedHtml {
  const images: PastedHtml['images'] = []
  let out = ''
  let skip = 0
  let pre = 0
  const atLineStart = () => !out || out.endsWith('\n')
  const lineBreak = () => {
    if (!atLineStart()) out += '\n'
  }
  const paraBreak = () => {
    if (!out) return
    lineBreak()
    if (!out.endsWith('\n\n')) out += '\n'
  }
  const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!?\/?([a-z][a-z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</gi
  let m: RegExpExecArray | null
  while ((m = TOKEN.exec(html))) {
    const [tok, rawName, attrs = '', text] = m
    if (text !== undefined || tok === '<') {
      if (skip) continue
      let t = decodeEntities(text ?? tok)
      if (!pre) {
        t = t.replace(/[ \t\r\n\f]+/g, ' ')
        if (atLineStart()) t = t.replace(/^ /, '')
      }
      out += t
      continue
    }
    if (!rawName) continue // comment / CDATA / doctype
    const name = rawName.toLowerCase()
    const closing = tok[1] === '/'
    if (SKIP.has(name)) {
      if (!closing && !/\/\s*>$/.test(tok)) skip++
      else if (closing && skip) skip--
      continue
    }
    if (skip) continue
    if (name === 'br') {
      out += '\n'
    } else if (name === 'img' && !closing) {
      const emoji = emojiOf(attrs)
      if (emoji !== null) {
        out += emoji
      } else {
        const n = firstN + images.length
        images.push({ n, src: attr(attrs, 'src') || '' })
        out += `[Image ${n}]`
      }
    } else if (name === 'li' && !closing) {
      lineBreak()
      out += '• '
    } else if (PARA.has(name)) {
      paraBreak()
    } else if (LINE.has(name)) {
      if (name === 'pre') pre += closing ? (pre ? -1 : 0) : 1
      lineBreak()
    } else if ((name === 'td' || name === 'th') && closing) {
      out += ' '
    }
  }
  const textOut = out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text: textOut, images }
}

/** What the composer does with a paste: leave it to the browser, take the
 * clipboard's image FILES (a bare screenshot), or take the HTML with its images.
 *
 * Only an image takes the paste over. Text with no `<img>` stays native even
 * when the clipboard also carries an image file — office apps put a rendered
 * PNG of the copied selection there, and that picture is not what the
 * operator meant to paste. */
export function pastePlan(html: string, plain: string, imageFiles: number): 'native' | 'files' | 'html' {
  if (html && htmlToMarkedText(html, 1).images.length) return 'html'
  if (imageFiles && !plain.trim()) return 'files'
  return 'native'
}

/** The next free image number in a draft: past every `[Image N…` already in the
 * text and every attached file — 📎-picked ones count too, and a removed chip
 * never frees its number (its marker may still be in the text). */
export function nextImageN(text: string, names: string[]): number {
  let max = names.length
  for (const m of text.matchAll(/\[Image (\d+)/g)) max = Math.max(max, Number(m[1]))
  for (const name of names) {
    const m = /^image-(\d+)\./.exec(name)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

/** The marker an image keeps when its bytes could not be read. */
export function unreadableMarker(n: number, src: string): string {
  const s = src.replace(/\s+/g, '').replace(/\]/g, '%5D')
  return `[Image ${n} unreadable: ${s ? (s.length > 200 ? `${s.slice(0, 200)}…` : s) : '(no source)'}]`
}

/** The marker an image keeps when the draft already holds the maximum files. */
export function overCapMarker(n: number, max: number): string {
  return `[Image ${n} not attached: max ${max} files]`
}

const EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/heic': 'heic', 'image/tiff': 'tif',
}
/** The wire name of pasted image N — the executors map N back off it. */
export function pastedFileName(n: number, mime: string): string {
  return `image-${n}.${EXT[mime.toLowerCase()] || 'png'}`
}

/** The composer's warning chips, derived from the draft itself — so editing a
 * marker away also clears its warning. */
export function pasteWarnings(text: string): string[] {
  const unread = text.match(/\[Image \d+ unreadable:/g)?.length ?? 0
  const over = text.match(/\[Image \d+ not attached:/g)?.length ?? 0
  const images = (k: number) => (k === 1 ? '1 image' : `${k} images`)
  const out: string[] = []
  if (unread) out.push(`${images(unread)} unreadable — paste in Safari, or copy each image on its own`)
  if (over) out.push(`${images(over)} not attached — file limit reached`)
  return out
}
