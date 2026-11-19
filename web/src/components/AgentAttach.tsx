import { type Ref } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type StateUpdater } from 'preact/hooks'
import { type AgentAttachment } from '../lib/api'
import { hasFiles } from '../lib/fileDrop'
import { type FileReads } from '../lib/fileReads'
import {
  nextImageN,
  overCapMarker,
  overCapNote,
  pastedFileName,
  pasteWarnings,
  planTransfer,
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
 *
 * Every way in — paste, a drop on the field, a drop anywhere else on the
 * composer's zone, the 📎 picker — runs through PromptTextarea's ONE `take`
 * (useDropZone hands it to the zone and the button), so the file cap, the size
 * check, the read hold and the `[Image N]` contract hold the same for all. A
 * drop only ever fills the draft: it never sends or spawns by itself.
 */

/** Cap on attachments per prompt/spawn (mirrors the API's AGENT_MAX_IMAGES). */
export const MAX_ATTACHMENTS = 20
/** Per-file cap (mirrors the executors' AGENT_MAX_IMAGE_BYTES / BRIDGE_MAX_IMAGE_BYTES
 * defaults), checked here so a big file is refused with a chip, not a bare 400
 * at send. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

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

/** Where a transfer's files go: a range of the field's text, or null = beside it. */
type Take = (dt: DataTransfer, sel: [number, number] | null, paste?: boolean) => boolean

/**
 * A composer's drop zone. Spread `props` on the element that IS the composer —
 * the spawn/Ask form, or the whole chat (card row or full screen, which
 * therefore also covers its transcript) — and render `overlay` inside it. Only
 * a drag carrying Files reacts, so text drags and Kanban card drags pass
 * through; and the zone is inert while it has no field (a dormant chat). The
 * innermost zone takes the drop, so it lands in the chat under the cursor and
 * nowhere else. A drop outside every zone is lib/fileDrop.ts's: refused.
 */
export function useDropZone() {
  const [over, setOver] = useState(false)
  // Lines for files a transfer did not attach (too big, empty, over the cap).
  const [notes, setNotes] = useState<string[]>([])
  const take = useRef<Take | null>(null)
  // dragenter/leave fire per child crossed; the zone is "over" while any is.
  const depth = useRef(0)
  const ours = (e: DragEvent) => !!take.current && hasFiles(e.dataTransfer)
  const props = {
    onDragEnter: (e: DragEvent) => {
      if (!ours(e)) return
      e.preventDefault()
      depth.current++
      setOver(true)
    },
    onDragOver: (e: DragEvent) => {
      if (!ours(e)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
      // Also here: not every drag source fires dragenter first.
      setOver(true)
    },
    onDragLeave: (e: DragEvent) => {
      if (!ours(e)) return
      if (--depth.current <= 0) {
        depth.current = 0
        setOver(false)
      }
    },
    onDrop: (e: DragEvent) => {
      if (!ours(e)) return
      depth.current = 0
      setOver(false)
      // The field took it already (at the drop point) — never twice.
      if (e.defaultPrevented) return
      e.preventDefault()
      take.current!(e.dataTransfer!, null)
    },
  }
  // A drag that ends anywhere (dropped elsewhere, Escape) clears the overlay.
  useEffect(() => {
    if (!over) return
    const end = () => {
      depth.current = 0
      setOver(false)
    }
    window.addEventListener('drop', end)
    window.addEventListener('dragend', end)
    return () => {
      window.removeEventListener('drop', end)
      window.removeEventListener('dragend', end)
    }
  }, [over])
  const overlay = over ? (
    <div className="agent-drop" aria-hidden="true">
      <span className="agent-drop__label">Drop files here</span>
    </div>
  ) : null
  return { props, overlay, notes, setNotes, take }
}
export type DropZone = ReturnType<typeof useDropZone>

export function AttachButton({ files, drop, disabled = false }: { files: AgentAttachment[]; drop: DropZone; disabled?: boolean }) {
  const full = files.length >= MAX_ATTACHMENTS
  // Picked files go the way a drop beside the field goes. The input is cleared
  // so re-picking the same file fires again.
  const add = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement
    const dt = new DataTransfer()
    for (const f of Array.from(input.files || [])) dt.items.add(f)
    input.value = ''
    if (dt.files.length) drop.take.current?.(dt, null)
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
 * marker) and per kind of file a transfer refused (`drop.notes`, dismissable). */
export function AttachChips({
  files,
  setFiles,
  disabled = false,
  text = '',
  reading = 0,
  drop,
}: Props & { text?: string; reading?: number; drop: DropZone }) {
  const warnings = pasteWarnings(text)
  const { notes, setNotes } = drop
  if (!files.length && !warnings.length && !notes.length && !reading) return null
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
      {notes.map((w) => (
        <span className="agent__img agent__img--warn" role="status" key={`note-${w}`}>
          ⚠ {w}
          <button
            type="button"
            className="agent__img-rm"
            onClick={() => setNotes((prev) => prev.filter((x) => x !== w))}
            title="dismiss"
          >
            ×
          </button>
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
 * Files dropped ON the field are that same paste at the drop point; any other
 * file type becomes a chip. A drop never submits.
 *
 * The bytes arrive AFTER the text (an https source can take the whole fetch
 * timeout; a big drop takes a moment too), so each transfer is one read on the caller's `reads` and the caller
 * holds every send path while any is pending — sent in that window, the
 * markers would go out bare and the images would land in the NEXT draft. A
 * read that resolves after the draft was sent (the caller's `reads.discard()`)
 * never lands; nor does a marked image whose draft was emptied by hand: `gen`
 * moves on every empty draft, and it only lands in the draft it was pasted
 * into. A chip carries no marker, so it stays.
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
  drop,
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
  /** The composer's zone (useDropZone) — the field hands it `take`. */
  drop: DropZone
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
  // A refused-file line belongs to the draft too: an emptied draft clears it.
  useEffect(() => {
    if (!value) drop.setNotes((n) => (n.length ? [] : n))
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

  // The one way files reach this draft — see the header. `sel` is the range of
  // the field the text replaces; null = beside the field (chips only). Returns
  // false when the transfer is not ours (a plain-text paste stays native).
  // Everything is read off `dt` synchronously: a DataTransfer goes blank once
  // its event returns.
  const take: Take = (dt, sel, paste = false) => {
    const all = Array.from(dt.files || [])
    // A screenshot can come only as an item on some browsers.
    if (!all.length)
      for (const it of Array.from(dt.items || []))
        if (it.kind === 'file') {
          const f = it.getAsFile()
          if (f) all.push(f)
        }
    const text = own.current?.value ?? value
    const plan = planTransfer(
      { html: sel ? dt.getData('text/html') : '', plain: dt.getData('text/plain'), files: all },
      {
        drop: !paste,
        at: sel ? 'field' : 'beside',
        firstN: nextImageN(text, files.map((f) => f.name)),
        room: MAX_ATTACHMENTS - files.length,
        max: MAX_ATTACHMENTS,
        maxBytes: MAX_ATTACHMENT_BYTES,
      },
    )
    if (!plan) return false
    drop.setNotes(plan.refused)
    if (sel && plan.insert) {
      const [a, b] = sel
      caret.current = a + plan.insert.length
      setValue(text.slice(0, a) + plan.insert + text.slice(b))
    }
    // The text is in now; the bytes follow. A marker whose image cannot be read,
    // or would pass the file cap, is rewritten in place — never dropped.
    const mark = (n: number, to: string) => setValue((prev) => prev.replace(`[Image ${n}]`, to))
    for (const m of plan.marked) if (m.over) mark(m.n, overCapMarker(m.n, MAX_ATTACHMENTS))
    const marked = plan.marked.filter((m) => !m.over)
    if (!marked.length && !plan.chips.length) return true
    const pastedInto = gen.current
    const readFile = (f: File) => readAsDataUrl(f).then((dataUrl) => ({ dataUrl, type: f.type }), () => null)
    const work = Promise.all([
      Promise.all(marked.map((m) => (typeof m.src === 'string' ? readImageSrc(m.src) : readFile(all[m.src])))),
      Promise.all(plan.chips.map((i) => readFile(all[i]))),
    ])
    // Added together, markers first in marker order — reads finish in any
    // order. No read rejects (a failure is null), so the hold always releases.
    void reads.read(work, ([rs, cs]) => {
      const add: (AgentAttachment & { n?: number })[] = []
      // A marked image belongs to the draft it was put into: once that draft is
      // gone its marker is too — never touch the next one.
      if (gen.current === pastedInto)
        rs.forEach((r, i) => {
          const { n, src } = marked[i]
          if (!r) mark(n, unreadableMarker(n, typeof src === 'string' ? src : ''))
          else add.push({ n, name: pastedFileName(n, r.type), dataUrl: r.dataUrl })
        })
      const unread: string[] = []
      cs.forEach((r, i) => {
        const f = all[plan.chips[i]]
        if (r) add.push({ name: f.name, dataUrl: r.dataUrl })
        else unread.push(f.name)
      })
      if (unread.length) drop.setNotes((prev) => [...prev, `${unread.join(', ')} unreadable`])
      if (!add.length) return
      setFiles((prev) => {
        const fit = Math.max(0, MAX_ATTACHMENTS - prev.length)
        // Another transfer raced this one to the cap — still say so.
        const late = add.slice(fit)
        if (late.length)
          queueMicrotask(() => {
            late.forEach((x) => x.n && mark(x.n, overCapMarker(x.n, MAX_ATTACHMENTS)))
            const k = late.filter((x) => !x.n).length
            if (k) drop.setNotes((p) => [...p, overCapNote(k, MAX_ATTACHMENTS)])
          })
        return [...prev, ...add.slice(0, fit).map(({ name, dataUrl }) => ({ name, dataUrl }))]
      })
    })
    return true
  }
  // Hand the zone (and the 📎 button) this field's `take` — and take it back on
  // unmount, but only if no newer field (the same chat remounted full screen)
  // has claimed the zone since.
  const mine = useRef<Take | null>(null)
  mine.current = disabled ? null : take
  drop.take.current = mine.current
  useEffect(
    () => () => {
      if (drop.take.current === mine.current) drop.take.current = null
    },
    [],
  )

  const onPaste = (e: ClipboardEvent) => {
    const t = e.currentTarget as HTMLTextAreaElement
    if (e.clipboardData && take(e.clipboardData, [t.selectionStart ?? t.value.length, t.selectionEnd ?? t.value.length], true))
      e.preventDefault()
  }

  // A file drop ON the field lands where it was dropped, like a paste there.
  // caretPositionFromPoint names the field and an offset into its value
  // (where supported); where it cannot, the drop goes at the caret.
  const onDrop = (e: DragEvent) => {
    const dt = e.dataTransfer
    if (!dt || !hasFiles(dt) || disabled) return // a text drag stays the browser's
    e.preventDefault()
    const t = e.currentTarget as HTMLTextAreaElement
    const p = document.caretPositionFromPoint?.(e.clientX, e.clientY)
    const at = p && p.offsetNode === t ? p.offset : (t.selectionStart ?? t.value.length)
    take(dt, [at, at])
    t.focus()
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
      onDrop={onDrop}
      onFocus={onFocus}
      disabled={disabled}
    />
  )
}
