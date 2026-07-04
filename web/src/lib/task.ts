/* ------------------------------------------------------------------ *
 * Task parsing for the Atlas TaskView.
 *
 * A tiny frontmatter reader (no YAML dependency — mirrors parseRecipeMeta)
 * pulls the typed fields a `type: task` note carries, so the reader can show
 * status / priority / due / typed edges in full instead of just the short body.
 * ------------------------------------------------------------------ */
import { stripFrontmatter } from './markdown'

export interface TaskMeta {
  type?: string
  status?: string
  priority?: string
  due?: string
  done?: string
  created?: string
  updated?: string
  for_project?: string | string[]
  for_project_idea?: string | string[]
  area?: string | string[]
  depends_on?: string | string[]
  owes?: string | string[]
  owed_by?: string | string[]
  tags?: string[]
}

const unquote = (s: string) => s.trim().replace(/^["']|["']$/g, '')

// Minimal frontmatter reader: top-level `key: value`, inline `[a, b]` lists, and
// `- item` block lists. Values keep their raw text (incl. "[[Link]]"), so the
// view can render typed edges as clickable wikilinks.
export function parseTaskMeta(md: string): TaskMeta {
  if (!md.startsWith('---')) return {}
  const end = md.indexOf('\n---', 3)
  if (end === -1) return {}
  const meta: Record<string, unknown> = {}
  let listKey: string | null = null
  for (const raw of md.slice(3, end).split('\n')) {
    const li = raw.match(/^\s*-\s+(.*)$/)
    if (listKey && li) {
      ;(meta[listKey] as string[]).push(unquote(li[1]))
      continue
    }
    listKey = null
    const m = raw.match(/^(\w+):\s*(.*)$/)
    if (!m) continue
    const key = m[1]
    const v = m[2].trim()
    if (v === '') {
      meta[key] = [] // possibly the head of a `- item` block list
      listKey = key
    } else if (v.startsWith('[') && v.endsWith(']')) {
      meta[key] = v
        .slice(1, -1)
        .split(',')
        .map((s) => unquote(s))
        .filter(Boolean)
    } else {
      meta[key] = unquote(v)
    }
  }
  return meta as TaskMeta
}

/** The note body (frontmatter removed), trimmed. */
export function taskBody(md: string): string {
  return stripFrontmatter(md).trim()
}

/** A frontmatter value that may be a string, a list, or absent → a string[]. */
export function asList(v?: string | string[]): string[] {
  return Array.isArray(v) ? v : v ? [v] : []
}
