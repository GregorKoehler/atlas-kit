import { type ComponentChildren } from 'preact'

// Atlas Kit ships without voice/dictation, so this is a transparent passthrough:
// it just renders the wrapped <input>/<textarea>. (In the source project this floats a live-
// dictation mic over the field. Drop useDictation + an ElevenLabs/on-box STT
// engine back in to restore it — the props are kept identical for that.)
export function MicField({
  children,
}: {
  value: string
  onChange: (next: string) => void
  multiline?: boolean
  children: ComponentChildren
}) {
  return <>{children}</>
}
