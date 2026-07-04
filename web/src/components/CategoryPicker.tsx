import { useState } from 'preact/hooks'
import type { TaskCategories } from '../lib/api'

// A combined project/project-idea/area picker: one combobox whose suggestions are
// every existing project, project-idea and area in the `project:Name` /
// `project-idea:Name` / `area:Name` form (so typing `project:`, `project-idea:` or
// `area:` filters to that kind), while still accepting free text — a bare new name
// is a new area, `project:New`/`project-idea:New`/`area:New` adds any kind (see
// resolveCategory). `onInput` reports every keystroke (the composer reads it at
// submit); `onCommit` fires on a datalist pick and on Enter — deliberately NOT
// per keystroke or on blur, so the reader's persist waits until the operator is
// actually done (it also flushes when the reader closes).
let nextId = 0

export function CategoryPicker({
  value,
  categories,
  placeholder,
  disabled,
  onInput,
  onCommit,
}: {
  value: string
  categories: TaskCategories | null
  placeholder?: string
  disabled?: boolean
  onInput?: (value: string) => void
  onCommit?: (value: string) => void
}) {
  const [listId] = useState(() => `catpick-${nextId++}`)
  return (
    <span className="catpick">
      <input
        className="catpick__input"
        type="text"
        list={listId}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        autoComplete="off"
        onInput={(e) => {
          const el = e.target as HTMLInputElement
          onInput?.(el.value)
          // Picking a datalist option replaces the whole value at once (browsers
          // report inputType "insertReplacementText") — commit that immediately.
          // Plain typing ("insertText") does NOT commit; it waits for Enter or
          // the reader-close flush, so the field doesn't churn on every keystroke.
          if ((e as unknown as InputEvent).inputType === 'insertReplacementText') onCommit?.(el.value)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onCommit?.((e.currentTarget as HTMLInputElement).value)
            ;(e.currentTarget as HTMLInputElement).blur()
          }
        }}
      />
      <datalist id={listId}>
        {(categories?.projects ?? []).map((p) => (
          <option key={`p:${p}`} value={`project:${p}`} />
        ))}
        {(categories?.projectIdeas ?? []).map((p) => (
          <option key={`i:${p}`} value={`project-idea:${p}`} />
        ))}
        {(categories?.areas ?? []).map((a) => (
          <option key={`a:${a}`} value={`area:${a}`} />
        ))}
      </datalist>
    </span>
  )
}
