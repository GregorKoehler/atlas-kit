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

/** A file on a paste/drop/📎 transfer, as far as the plan needs it. */
export interface TransferFile {
  name: string
  type: string
  size: number
}

/** What one transfer does to the draft. Indexes point into the input `files`. */
export interface TransferPlan {
  /** Text for the caret ('' = none). */
  insert: string
  /** Per `[Image N]` in `insert`, in order: its bytes (a file index or an <img>
   * src) — or `over`, when the draft has no room left for it. */
  marked: { n: number; src: number | string; over?: true }[]
  /** Files attached under their own name, like a 📎 pick. */
  chips: number[]
  /** One visible line per kind of file that was NOT attached. */
  refused: string[]
}

const filesWord = (k: number) => (k === 1 ? '1 file' : `${k} files`)

/**
 * The one decision behind every way a file reaches a composer — a paste, a
 * drop on the field (`at: 'field'`), a drop beside it or a 📎 pick
 * (`at: 'beside'`). Null = not ours: a plain-text paste stays the browser's.
 *
 * In the field, a paste or drop is the same thing: images get an `[Image N]`
 * at the caret (pastePlan decides which ones), every other file becomes a
 * chip. Beside the field, everything is a chip. A drag's text/plain is ignored
 * — it is the file's name or URL, not something the operator typed — so a file
 * drop is always taken over. Either way the transfer only fills the draft:
 * nothing here sends or spawns.
 *
 * Nothing goes silently: a file over the server's per-file limit, an empty one
 * (or a folder), or one past the `room` left under the `max` files is listed in
 * `refused`; a marker past the cap is flagged `over` (the composer rewrites it
 * to overCapMarker, as a paste always has). Markers claim room first.
 */
export function planTransfer(
  dt: { html: string; plain: string; files: TransferFile[] },
  o: { drop: boolean; at: 'field' | 'beside'; firstN: number; room: number; max: number; maxBytes: number },
): TransferPlan | null {
  const big: string[] = []
  const empty: string[] = []
  const ok: number[] = []
  dt.files.forEach((f, i) => {
    if (f.size > o.maxBytes) big.push(f.name)
    else if (!f.size) empty.push(f.name)
    else ok.push(i)
  })
  const isImage = (i: number) => dt.files[i].type.startsWith('image/')
  let insert = ''
  let marked: TransferPlan['marked'] = []
  let chips = ok
  if (o.at === 'field') {
    const images = ok.filter(isImage)
    // Refused images count for the takeover, so a lone oversize screenshot
    // pasted is refused out loud rather than left to the browser.
    const plan = pastePlan(dt.html, o.drop ? '' : dt.plain, dt.files.filter((f) => f.type.startsWith('image/')).length)
    if (plan === 'native' && !o.drop) return null
    chips = ok.filter((i) => !isImage(i))
    if (plan === 'html') {
      const parsed = htmlToMarkedText(dt.html, o.firstN)
      insert = parsed.text
      // The transfer's own image files are the real bytes when they match one
      // to one (a browser's "Copy image"); otherwise read each <img>'s source.
      marked = parsed.images.map((im, k) => ({ n: im.n, src: images.length === parsed.images.length ? images[k] : im.src }))
    } else if (plan === 'files') {
      marked = images.map((i, k) => ({ n: o.firstN + k, src: i }))
      insert = marked.map((m) => `[Image ${m.n}]`).join('\n')
    }
  }
  marked = marked.map((m, k) => (k < o.room ? m : { ...m, over: true }))
  const fit = Math.max(0, o.room - marked.length)
  const refused: string[] = []
  const mb = Math.round(o.maxBytes / (1024 * 1024))
  if (big.length) refused.push(`${big.length === 1 ? big[0] : filesWord(big.length)} not attached — larger than ${mb} MB`)
  if (empty.length) refused.push(`${empty.length === 1 ? empty[0] : filesWord(empty.length)} not attached — empty, or a folder`)
  if (chips.length > fit) refused.push(overCapNote(chips.length - fit, o.max))
  return { insert, marked, chips: chips.slice(0, fit), refused }
}

/** The chip line for `k` files that did not fit under the file cap. */
export function overCapNote(k: number, max: number): string {
  return `${filesWord(k)} not attached — file limit reached (max ${max})`
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
