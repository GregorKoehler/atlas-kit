// A reference-counted lock on page (body) scroll, shared by every full-screen
// overlay — an agent's full-screen split view, its app-only full screen, and the
// note reader. Several can be up at once, or hand off to each other (the
// full-screen switcher hops straight from one agent's full screen to another's),
// so the body must stay locked until the LAST overlay releases.
//
// The old per-overlay pattern captured `document.body.style.overflow` on open and
// restored that value on close. When two overlays overlapped, the incoming one
// could capture `'hidden'` (the outgoing one hadn't cleaned up yet) and then
// restore `'hidden'` on exit — leaving the page unscrollable. Preact flushes
// effects per-component (cleanups then setups, one component at a time), so that
// unlucky ordering happens intermittently — the "page won't scroll after leaving
// full screen, but the chat still scrolls" bug. Counting sidesteps the ordering:
// the body only unlocks at count 0.
let count = 0

/** Lock body scroll; returns an idempotent release. */
export function lockBodyScroll(): () => void {
  if (count++ === 0) document.body.style.overflow = 'hidden'
  let released = false
  return () => {
    if (released) return
    released = true
    if (--count === 0) document.body.style.overflow = ''
  }
}
