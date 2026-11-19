/* ------------------------------------------------------------------ *
 * Attached files are read to data URLs AFTER they were picked — a big file
 * takes a noticeable while — so a send pressed in that window used to go out
 * WITHOUT them, and the files then landed in the NEXT draft, riding along with
 * a message they were never meant for.
 *
 * FileReads tracks the reads in flight: `pending` > 0 means the caller holds
 * every send path (send, queue, interrupt, spawn), and a draft GENERATION: a
 * read that finishes after its draft was sent or cleared (`discard()`) is
 * dropped instead of touching the next draft. Pure, so it is testable under
 * plain node (fileReads.test.mjs); `useFileReads` is the Preact binding.
 * ------------------------------------------------------------------ */
import { useRef, useState } from 'preact/hooks'

export class FileReads {
  pending = 0
  private gen = 0
  private readonly onPending: (n: number) => void
  constructor(onPending: (n: number) => void = () => {}) {
    this.onPending = onPending
  }

  /** Await `work`; hand its result to `land` only if the draft it was started
   * for still exists. A failed read rejects (after `pending` is released). */
  async read<T>(work: Promise<T>, land: (v: T) => void): Promise<void> {
    const gen = this.gen
    this.onPending(++this.pending)
    try {
      const v = await work
      if (gen === this.gen) land(v)
    } finally {
      this.onPending(--this.pending)
    }
  }

  /** The draft is gone (sent, or cleared): reads still in flight never land. */
  discard(): void {
    this.gen++
  }
}

/** `reading` re-renders the caller while files are read; `reads` is stable. */
export function useFileReads(): { reading: number; reads: FileReads } {
  const [reading, setReading] = useState(0)
  const ref = useRef<FileReads | null>(null)
  if (!ref.current) ref.current = new FileReads(setReading)
  return { reading, reads: ref.current }
}
