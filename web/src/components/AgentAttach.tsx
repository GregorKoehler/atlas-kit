import { type Ref } from 'preact'
import { useLayoutEffect, useRef, type Dispatch, type StateUpdater } from 'preact/hooks'
import { type AgentAttachment } from '../lib/api'
import { type FileReads } from '../lib/fileReads'
import {
  htmlToMarkedText,
  nextImageN,
  overCapMarker,
  pastedFileName,
  pastePlan,
  pasteWarnings,
  unreadableMarker,
} from '../lib/pasteImages'

/**
 * The 📎 attach control, the attached-file chip row and the prompt field that
 * takes a pasted message with screenshots in it — ONE implementation for every
 * site that can carry files: the dev spawn form, a running agent's prompt box
 * (card and full screen render the same body), and the knowledge/Atlas Ask
 * form (AgentList / KnowledgeAgents).
 *
 * Two components for the files rather than one because the sites lay them out
 * differently: the button sits inside the form row, the chips go in a block
 * below it. They share the caller's `files` state, so `setFiles` is the
 * caller's own setter, and the caller's `reads` (lib/fileReads.ts), so every
 * send path is held while any file is still being read.
 *
 * Any file type, not just images — the `images` wire field is historical.
 */

/** Cap on attachments per prompt/spawn (mirrors the API's AGENT_MAX_IMAGES). */
export const MAX_ATTACHMENTS = 20

// Read a File/Blob into a `data:…;base64,…` URL — how an attachment travels.
function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

interface Props {
  files: AgentAttachment[]
  setFiles: Dispatch<StateUpdater<AgentAttachment[]>>
  disabled?: boolean
}

export function AttachButton({
  files,
  setFiles,
  reads,
  onError,
  disabled = false,
}: Props & { reads: FileReads; onError: (msg: string) => void }) {
  const full = files.length >= MAX_ATTACHMENTS
  // Attach picked files (capped at MAX_ATTACHMENTS total), reading each to a data
  // URL. The input is cleared so re-picking the same file fires again.
  const add = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement
    const picked = Array.from(input.files || [])
    input.value = ''
    if (!picked.length) return
    const work = Promise.all(picked.map(async (f) => ({ name: f.name, dataUrl: await readAsDataUrl(f) })))
    reads
      .read(work, (read) => setFiles((prev) => [...prev, ...read].slice(0, MAX_ATTACHMENTS)))
      .catch(() => onError('could not read the attached file(s)'))
  }
  return (
    <label
      className={`agent__attach${full ? ' agent__attach--full' : ''}`}
      title={full ? `max ${MAX_ATTACHMENTS} files` : 'attach file(s) — any type'}
    >
      📎
      <input type="file" multiple hidden disabled={disabled || full} onChange={add} />
    </label>
  )
}

/** The chip row, plus a warning chip per kind of pasted image that did not make
 * it (`text` = the draft; see pasteWarnings — derived, so it clears with the
 * marker). */
export function AttachChips({
  files,
  setFiles,
  disabled = false,
  text = '',
  reading = 0,
}: Props & { text?: string; reading?: number }) {
  const warnings = pasteWarnings(text)
  if (!files.length && !warnings.length && !reading) return null
  return (
    <div className="agent__imgs" role="group" aria-label="attached files">
      {reading ? (
        <span className="agent__img" role="status">
          ⏳ reading files…
        </span>
      ) : null}
      {warnings.map((w) => (
        <span className="agent__img agent__img--warn" role="status" key={w}>
          ⚠ {w}
        </span>
      ))}
      {files.map((f, i) => (
        <span className="agent__img" key={`${f.name}-${i}`} title={f.name}>
          {f.dataUrl.startsWith('data:image/') ? (
            <img className="agent__img-thumb" src={f.dataUrl} alt={f.name} />
          ) : (
            <span className="agent__img-thumb agent__img-thumb--file" aria-hidden="true">
              📄
            </span>
          )}
          <span className="agent__img-name">{f.name}</span>
          <button
            type="button"
            className="agent__img-rm"
            onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
            disabled={disabled}
            title="remove attachment"
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}

// How long one image URL gets before it counts as unreadable — an
// authenticated https URL fails fast on CORS, but a hung host must not hold
// the paste.
const FETCH_TIMEOUT_MS = 6000

// The bytes behind a pasted <img src>, as a data URL, or null. `data:` and
// `blob:` (what WebKit makes of a pasted web archive) read fine; an https
// source is tried once and usually refused (CORS, auth). Anything that does
// not come back as an image — a login page, say — is unreadable too.
async function readImageSrc(src: string): Promise<{ dataUrl: string; type: string } | null> {
  if (!/^(data|blob|https?):/i.test(src)) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(src, { signal: ctrl.signal })
    if (!r.ok) return null
    const blob = await r.blob()
    if (!blob.type.startsWith('image/')) return null
    return { dataUrl: await readAsDataUrl(blob), type: blob.type }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The prompt field: an auto-growing textarea (capped by CSS, then it scrolls).
 * Enter submits the surrounding form, Shift+Enter is a newline, and Enter that
 * confirms an IME composition never sends.
 *
 * Paste: a message with images in it (a chat app, a notes app, a web page) is
 * taken over — its text lands at the caret with an `[Image N]` per image and
 * each image becomes an attachment named `image-N.<ext>` (the executors put
 * its path at the marker; lib/pasteImages.ts has the contract). A bare
 * screenshot lands the same way. Plain text pastes stay the browser's own.
 *
 * The bytes arrive AFTER the text (an https source can take the whole fetch
 * timeout), so each paste is one read on the caller's `reads` and the caller
 * holds every send path while any is pending — sent in that window, the
 * markers would go out bare and the images would land in the NEXT draft. A
 * read that resolves after the draft was sent (the caller's `reads.discard()`)
 * never lands; nor does one whose draft was emptied by hand: `gen` moves on
 * every empty draft, and a pasted image only lands in the draft it was pasted
 * into.
 */
export function PromptTextarea({
  value,
  setValue,
  files,
  setFiles,
  reads,
  inputRef,
  className = 'capture__input capture__input--sm',
  placeholder,
  onFocus,
  disabled,
}: {
  value: string
  setValue: (v: string | ((prev: string) => string)) => void
  files: AgentAttachment[]
  setFiles: Dispatch<StateUpdater<AgentAttachment[]>>
  reads: FileReads
  inputRef?: Ref<HTMLTextAreaElement>
  className?: string
  placeholder?: string
  onFocus?: () => void
  disabled?: boolean
}) {
  const own = useRef<HTMLTextAreaElement>(null)
  // Grow with the text; the CSS max-height caps it and the overflow scrolls.
  // Empty stays one row — Chrome counts a wrapped placeholder in scrollHeight.
  useLayoutEffect(() => {
    const t = own.current
    if (!t) return
    t.style.height = ''
    const grown = !!t.value && t.scrollHeight > t.clientHeight + 1
    if (grown) t.style.height = `${t.scrollHeight + t.offsetHeight - t.clientHeight}px`
    // Read by the CSS: a one-row field keeps its row's stretch-to-height look,
    // a grown one sends the buttons to its foot. Not a prop — Preact never
    // owns it, so a render cannot reset it.
    if (grown) t.dataset.grown = ''
    else delete t.dataset.grown
  }, [value])
  const gen = useRef(0)
  useLayoutEffect(() => {
    if (!value) gen.current++
  }, [value])
  // Where the caret goes after a programmatic insert (applied post-render).
  const caret = useRef<number | null>(null)
  useLayoutEffect(() => {
    const t = own.current
    if (t && caret.current !== null) t.setSelectionRange(caret.current, caret.current)
    caret.current = null
  }, [value])

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return
    e.preventDefault()
    ;(e.currentTarget as HTMLTextAreaElement).form?.requestSubmit()
  }

  const onPaste = (e: ClipboardEvent) => {
    const cd = e.clipboardData
    if (!cd) return
    const html = cd.getData('text/html')
    const plain = cd.getData('text/plain')
    const imageFiles = Array.from(cd.files || []).filter((f) => f.type.startsWith('image/'))
    // A screenshot can come only as an item on some browsers.
    if (!imageFiles.length)
      for (const it of Array.from(cd.items || []))
        if (it.kind === 'file' && it.type.startsWith('image/')) {
          const f = it.getAsFile()
          if (f) imageFiles.push(f)
        }
    const plan = pastePlan(html, plain, imageFiles.length)
    if (plan === 'native') return
    e.preventDefault()
    const t = e.currentTarget as HTMLTextAreaElement
    const first = nextImageN(t.value, files.map((f) => f.name))
    let insert: string
    // Per image, in marker order: its number and where its bytes come from.
    let jobs: { n: number; src: Blob | string }[]
    if (plan === 'html') {
      const parsed = htmlToMarkedText(html, first)
      insert = parsed.text
      // The clipboard's own files are the real bytes when they match one to one
      // (a browser's "Copy image"); otherwise read each <img>'s source.
      jobs = parsed.images.map((im, i) => ({
        n: im.n,
        src: imageFiles.length === parsed.images.length ? imageFiles[i] : im.src,
      }))
    } else {
      jobs = imageFiles.map((f, i) => ({ n: first + i, src: f }))
      insert = jobs.map((j) => `[Image ${j.n}]`).join('\n')
    }
    const a = t.selectionStart ?? t.value.length
    const b = t.selectionEnd ?? a
    caret.current = a + insert.length
    setValue(t.value.slice(0, a) + insert + t.value.slice(b))
    // The text is in now; the bytes follow. A marker whose image cannot be read,
    // or would pass the file cap, is rewritten in place — never dropped.
    const room = MAX_ATTACHMENTS - files.length
    const pastedInto = gen.current
    const mark = (n: number, to: string) => setValue((prev) => prev.replace(`[Image ${n}]`, to))
    const work = Promise.all(
      jobs.map((j, i) =>
        i >= room
          ? Promise.resolve(null)
          : typeof j.src === 'string'
            ? readImageSrc(j.src)
            : readAsDataUrl(j.src).then((dataUrl) => ({ dataUrl, type: (j.src as Blob).type }), () => null),
      ),
    )
    // Added together, in marker order — reads finish in any order. No read
    // rejects (a failure is null), so the hold always releases.
    void reads.read(work, (results) => {
      if (gen.current !== pastedInto) return // that draft is gone — never touch the next one
      const add: (AgentAttachment & { n: number })[] = []
      results.forEach((r, i) => {
        const { n, src } = jobs[i]
        if (i >= room) mark(n, overCapMarker(n, MAX_ATTACHMENTS))
        else if (!r) mark(n, unreadableMarker(n, typeof src === 'string' ? src : ''))
        else add.push({ n, name: pastedFileName(n, r.type), dataUrl: r.dataUrl })
      })
      if (!add.length) return
      setFiles((prev) => {
        const fit = Math.max(0, MAX_ATTACHMENTS - prev.length)
        // Another paste raced this one to the cap — still say so in the text.
        if (add.length > fit) queueMicrotask(() => add.slice(fit).forEach((x) => mark(x.n, overCapMarker(x.n, MAX_ATTACHMENTS))))
        return [...prev, ...add.slice(0, fit).map(({ name, dataUrl }) => ({ name, dataUrl }))]
      })
    })
  }

  return (
    <textarea
      ref={(t) => {
        own.current = t
        if (typeof inputRef === 'function') inputRef(t)
        else if (inputRef) inputRef.current = t
      }}
      className={`${className} prompt-field`}
      rows={1}
      placeholder={placeholder}
      value={value}
      onInput={(e) => setValue(e.currentTarget.value)}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      onFocus={onFocus}
      disabled={disabled}
    />
  )
}
