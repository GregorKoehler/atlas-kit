import { useState } from 'preact/hooks'
import { motion, type Transition, type Variants } from 'framer-motion'
import { WikiGraph } from './cards/WikiGraph'
import { SearchBar } from './SearchBar'
import { Kanban } from './cards/Kanban'
import { NoteReader } from './NoteReader'
import { useData } from '../lib/useData'
import { useNoteReader } from '../lib/useNoteReader'
import { kickAgents } from '../lib/useAgents'
import { focusAgent } from '../lib/agentFocus'
import { fetchWikiPages, moveTask, createTask, setTaskDue, setTaskPriority, spawnAgent } from '../lib/api'

// The Atlas tab: a typed, queryable LLM-wiki vault surfaced as a task Kanban,
// a link graph, full-text search, and a reader. The one operator-invited write
// surface here is the Kanban (every change commits through the serial queue);
// the reader's "Chat about this" spawns an Atlas Agent (on the Home tab).
const VAULT = 'atlas'

const grid: Variants = { hidden: { opacity: 0 }, show: { opacity: 1 } }
const gridStagger: Transition = { staggerChildren: 0.07, delayChildren: 0.05 }

export function AtlasCenter() {
  const { data: pages } = useData(() => fetchWikiPages(VAULT))
  const { path, missing, canGoBack, openPath, navigate, back, close } = useNoteReader(pages)
  const [highlight] = useState<string | null>(null)
  // Bumped when a task's project/area is edited in the reader, so the Kanban
  // re-polls and re-colours the card immediately instead of on its next tick.
  const [taskRev, setTaskRev] = useState(0)

  // "Chat about this": spawn a knowledge agent grounded in the open page, close
  // the reader, then jump to the Home tab and full-screen the new Atlas Agent chat.
  const startChat = async (p: string): Promise<{ ok: boolean; error?: string }> => {
    const title = (p.split('/').pop() ?? p).replace(/\.(md|html)$/i, '')
    const task =
      `Let's talk about [[${title}]] — I just opened it in the Atlas (\`${p}\`).\n\n` +
      `Ground yourself first: read that page, then do a quick traversal of its ` +
      `neighbourhood in the graph — the pages it links to and is linked from, and ` +
      `its typed edges — so you have the local context. Then give me a short ` +
      `orientation and I'll take it from there.`
    const r = await spawnAgent({ task, kind: 'knowledge', vault: VAULT, model: 'opus', effort: 'high' })
    if (r.ok) {
      close()
      kickAgents()
      if (r.id) focusAgent(r.id, 'command')
    }
    return { ok: r.ok, error: r.error }
  }

  return (
    <>
      <motion.div
        variants={grid}
        initial="hidden"
        animate="show"
        transition={gridStagger}
        className="cc-grid grid grid-cols-12 gap-4 px-4 pb-12 sm:px-6"
      >
        <SearchBar onOpenWiki={openPath} vault={VAULT} placeholder="Search ATLAS…" />
        {/* The Kanban — the live Atlas task board (from Tasks/), grouped by status.
            Every change (incl. a status drag) commits through the serial queue. */}
        <Kanban
          className="col-span-12"
          vault={VAULT}
          onOpen={openPath}
          onMove={(t, status) => moveTask(t.path, status, VAULT)}
          onCreate={(title, due, category, body) => createTask(title, due, category, body, VAULT)}
          onSetDue={(t, due) => setTaskDue(t.path, due, VAULT)}
          onSetPriority={(t, priority) => setTaskPriority(t.path, priority, VAULT)}
          refreshSignal={taskRev}
        />
        <WikiGraph className="col-span-12" onOpenPath={openPath} highlight={highlight} vault={VAULT} />
      </motion.div>

      <NoteReader
        path={path}
        missing={missing}
        vault={VAULT}
        canGoBack={canGoBack}
        onBack={back}
        onClose={close}
        onWikiLink={navigate}
        onTaskChanged={() => setTaskRev((n) => n + 1)}
        onChat={startChat}
      />
    </>
  )
}
