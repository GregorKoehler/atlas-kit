import { useState } from 'preact/hooks'

/* ------------------------------------------------------------------ *
 * Draft inputs — a half-typed prompt, a spawn task, an unsent message —
 * live in component state, so they vanish the moment the component
 * unmounts. Switching dashboard tabs unmounts the inactive tab's entire
 * card tree (AppShell renders one tab at a time), so a prompt typed but
 * not yet sent is lost when you navigate away and back.
 *
 * `useDraft` is a drop-in for `useState<string>` that survives that by
 * mirroring the value to sessionStorage under a stable `key`. Navigating
 * away and back re-reads the draft, so nothing typed is dropped.
 *
 * sessionStorage (not localStorage): a draft is per-session scratch, not
 * something to remember across browser restarts. Clearing the field —
 * e.g. after a successful submit sets it back to '' — drops the stored
 * entry, so nothing stale lingers for the next mount.
 * ------------------------------------------------------------------ */

const PREFIX = 'atlas-kit-draft:'

function read<T extends string>(key: string, fallback: T): T {
  try {
    const v = sessionStorage.getItem(PREFIX + key)
    return (v as T | null) ?? fallback
  } catch {
    return fallback // storage blocked (private mode etc.) — fall back to the default
  }
}

/** Like `useState<string>`, but the value persists across unmount (tab
 *  switches) via sessionStorage. `key` must be stable and unique per input —
 *  include the card's instance discriminator (repo, vault, session id) when a
 *  card renders more than once. Accepts a plain value or an updater fn, like
 *  the native setter. */
export function useDraft<T extends string = string>(
  key: string,
  initial: T = '' as T,
): [T, (v: T | ((prev: T) => T)) => void] {
  const [val, setVal] = useState<T>(() => read(key, initial))
  const set = (v: T | ((prev: T) => T)) => {
    setVal((prev) => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v
      try {
        if (next) sessionStorage.setItem(PREFIX + key, next)
        else sessionStorage.removeItem(PREFIX + key)
      } catch {
        /* storage blocked — the value still lives in component state */
      }
      return next
    })
  }
  return [val, set]
}
