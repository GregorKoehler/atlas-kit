/* ------------------------------------------------------------------ *
 * A file dragged into the dashboard and dropped.
 *
 * The agent composers take a file drop (components/AgentAttach.tsx
 * useDropZone), and it only fills the draft. A file dropped anywhere else
 * would get the browser's default: it OPENS the file — navigating the tab away
 * from the dashboard, which on the installed PWA (no URL bar, no back button)
 * strands the app, and an unsent draft with it. So `guardStrayFileDrops`
 * refuses those at the window, and only those: a drag without Files (text, a
 * Kanban card) is never touched, and a drop an element already handled
 * (preventDefault — a composer zone) is left to it.
 * ------------------------------------------------------------------ */

/** True when a drag carries files from the OS (not text, not an in-page card). */
export function hasFiles(dt: DataTransfer | null | undefined): boolean {
  return !!dt && Array.from(dt.types || []).includes('Files')
}

/** Install once, at startup. */
export function guardStrayFileDrops(win: Pick<Window, 'addEventListener'> = window): void {
  win.addEventListener('dragover', (e) => {
    if (e.defaultPrevented || !hasFiles(e.dataTransfer)) return
    // Not a drop target: say so (no copy cursor), and never navigate.
    e.preventDefault()
    e.dataTransfer!.dropEffect = 'none'
  })
  win.addEventListener('drop', (e) => {
    if (!e.defaultPrevented && hasFiles(e.dataTransfer)) e.preventDefault()
  })
}
