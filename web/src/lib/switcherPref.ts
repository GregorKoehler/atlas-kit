/* ------------------------------------------------------------------ *
 * Full-screen agent switcher — the sticky "graph or slim strip?" preference.
 *
 * Split out of AgentList so the default rule is unit-testable off preact
 * (switcherPref.test.mjs). The rendering stays in AgentList.
 *
 * EXPANDED by default: the switcher's whole job is navigation — on the phone the
 * operator uses that graph to hop between Atlas chats and dev agents, so costing
 * a tap before it can switch defeats it. Collapsing is therefore the OPT-IN:
 * only an explicitly stored 'collapsed' hides the graph. Read only by the phone
 * breakpoint — above it the toggle is `display: none` and the graph always shows.
 * ------------------------------------------------------------------ */

export const SWITCHER_PREF_KEY = 'atlas-kit-switcher'

/** Open unless the operator explicitly collapsed it (missing preference = open). */
export function defaultSwitcherOpen(): boolean {
  try {
    return localStorage.getItem(SWITCHER_PREF_KEY) !== 'collapsed'
  } catch {
    return true
  }
}

export function persistSwitcherOpen(open: boolean) {
  try {
    localStorage.setItem(SWITCHER_PREF_KEY, open ? 'open' : 'collapsed')
  } catch {
    /* private mode etc. — the toggle still works for this session */
  }
}
