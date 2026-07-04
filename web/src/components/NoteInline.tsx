import { fetchNote, fetchWikiHtml } from '../lib/api'
import { useAsync } from '../lib/useData'
import { Markdown, type MdOptions } from '../lib/markdown'
import { TaskView } from './TaskView'
import { parseTaskMeta } from '../lib/task'

/** Render a vault entry read-only: HTML pages in a sandboxed iframe, everything
 * else as markdown. (Split so each branch calls hooks consistently.) */
export function NoteInline({
  path,
  vault,
  options,
}: {
  path: string
  vault?: string
  options?: MdOptions
}) {
  if (/\.html$/i.test(path)) return <HtmlInline path={path} vault={vault} />
  return <MarkdownInline path={path} vault={vault} options={options} />
}

function HtmlInline({ path, vault }: { path: string; vault?: string }) {
  // Inline the markup via srcdoc rather than src: the app sends X-Frame-Options
  // DENY, which would blank a framed response. srcdoc isn't subject to it, and
  // sandbox="" keeps the page script-isolated.
  const { data, loading } = useAsync(() => fetchWikiHtml(path, vault), [path, vault])
  if (loading) return <div className="note-status tnum">LOADING…</div>
  if (data == null) return <div className="empty-state">Could not load page.</div>
  return <iframe className="reader__html" srcdoc={data} sandbox="" title="HTML page" />
}

function MarkdownInline({
  path,
  vault,
  options,
}: {
  path: string
  vault?: string
  options?: MdOptions
}) {
  const { data, loading } = useAsync(() => fetchNote(path, vault), [path, vault])
  if (loading) return <div className="note-status tnum">LOADING…</div>
  if (data == null) return <div className="empty-state">Could not load note.</div>
  const basePath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
  // A type:task note (Atlas Tasks/) gets the typed-frontmatter header view.
  if (parseTaskMeta(data).type === 'task') {
    return <TaskView source={data} path={path} options={{ ...options, basePath, vault }} />
  }
  return <Markdown source={data} options={{ ...options, basePath, vault }} />
}
