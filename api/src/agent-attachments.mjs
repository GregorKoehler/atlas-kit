/* ── Folding attached files into a prompt ──────────────────────────────────
 * Both executors run this — box-local (agent-local.mjs) and every bridge
 * (agent-bridge/server.mjs imports it from here) — so a paste lands the same
 * way wherever the agent runs. It had been copied into both; a second copy
 * drifts, and a bridge restarts separately from the box.
 *
 * Newlines are fine in the payload: both executors deliver through
 * tui-input.mjs's typeAndSubmit, where `tmux send-keys -l` types an LF that
 * Claude Code inserts as a line break, and only the explicit Enter afterwards
 * submits.
 *
 * Inline images. A message pasted with screenshots in it (a chat app, a notes
 * app, a web page) arrives as text holding `[Image N]` markers where the images
 * sat, plus one file per image that the dashboard names `image-N.<ext>`
 * (web/src/lib/pasteImages.ts). Each executor saves a file as
 * `<ts>-<i>-<slug>.<ext>`, so the N survives in the SAVED path's basename —
 * which is why this works off the path alone and a queued entry (which stores
 * only paths) needs no new field. A marker whose N has a file becomes
 * `[Image N: <absolute path>]`, in place; a marker without one (an unreadable
 * image, a removed chip) is left as typed; a file without a marker (📎-picked)
 * goes in the appended tail, as always.
 */

const MARKER = /\[Image (\d+)\]/g
// `…/<ts>-<i>-image-3.png` → 3. The slug is the client's `image-N` stem, which
// the executors' slugify leaves untouched.
const SAVED_IMAGE = /-image-(\d+)(?:\.[a-z0-9]+)?$/i

/** The marker number a saved upload path carries, or 0. */
export function imageNumberOf(file) {
  const m = SAVED_IMAGE.exec(String(file || ''))
  return m ? Number(m[1]) : 0
}

/** The prompt text with each attached file's path folded in — see above. With
 * no `[Image N]` marker matched, the output is byte-identical to the old
 * single-tail form. */
export function withImages(text, paths) {
  if (!paths.length) return text
  // Per N, its files in order. A batched queue delivery joins several messages
  // that each count from Image 1 — their texts and paths are joined in the same
  // order, so each marker takes the next unused file with its N.
  const byN = new Map()
  for (const p of paths) {
    const n = imageNumberOf(p)
    if (n) byN.set(n, [...(byN.get(n) || []), p])
  }
  const placed = new Set()
  const body = String(text || '').replace(MARKER, (m, n) => {
    const p = byN.get(Number(n))?.shift()
    if (!p) return m
    placed.add(p)
    return `[Image ${n}: ${p}]`
  })
  const rest = paths.filter((p) => !placed.has(p))
  let tail
  if (!placed.size) {
    const noun = rest.length > 1 ? 'files' : 'a file'
    const them = rest.length > 1 ? 'them' : 'it'
    tail = `[I attached ${noun} at: ${rest.join(', ')} — use the Read tool to view ${them} before responding.]`
  } else {
    const inline = 'Each [Image N: <path>] image belongs where its marker sits in the text.'
    tail = rest.length
      ? `[I attached ${rest.length > 1 ? 'files' : 'a file'} at: ${rest.join(', ')} — use the Read tool to view every referenced file, these and the inline ones, before responding. ${inline}]`
      : `[Use the Read tool to view every referenced image before responding. ${inline}]`
  }
  return body ? `${body} ${tail}` : tail
}
