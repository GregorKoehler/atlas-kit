import { useEffect, useState } from 'preact/hooks'
import type { TabId } from '../components/TabBar'

/**
 * A tiny global "open this agent" signal. The Agent constellation (Atlas tab),
 * the hero agents overview, and the full-screen switcher strip fire
 * `focusAgent(id, tab)` when an agent node is clicked; AppShell switches to
 * `tab` — wherever that agent's card lives (Command for dev agents and the
 * Atlas chat card, Knowledge Base / Recipes for the other vault chats) — and
 * the matching row opens its own full-screen split view. Cards unmount when
 * you leave their tab, so a plain prop can't reach them — hence this
 * module-level signal.
 *
 * `consumed` is a high-water mark so a fired focus is acted on EXACTLY ONCE,
 * even though the target row remounts every time you leave and re-enter its
 * tab (which would otherwise re-trigger the full-screen).
 */
let target: { id: string; tab: TabId; n: number } | null = null
let consumed = 0
const subs = new Set<() => void>()

export function focusAgent(id: string, tab: TabId = 'command') {
  target = { id, tab, n: (target?.n ?? 0) + 1 }
  subs.forEach((f) => f())
}
export function agentFocusConsumed(): number {
  return consumed
}
export function consumeAgentFocus(n: number) {
  if (n > consumed) consumed = n
}
export function useAgentFocus(): { id: string; tab: TabId; n: number } | null {
  const [, force] = useState(0)
  useEffect(() => {
    const cb = () => force((x) => x + 1)
    subs.add(cb)
    return () => {
      subs.delete(cb)
    }
  }, [])
  return target
}
