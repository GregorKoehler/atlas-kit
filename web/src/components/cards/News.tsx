import { Card, EmptyState } from '../Card'
import { useData } from '../../lib/useData'
import { useAddons } from '../../lib/addons'
import { fetchNews, type NewsItem } from '../../lib/api'

/* News — the headlines the optional `news-ingest` addon has filed into the vault.
 *
 * 🔴 GATED AT RUNTIME, NOT AT BUILD TIME. One build of web/dist serves every
 * install, so this card renders because GET /api/addons says the addon is enabled
 * ON THIS BOX. It returns null (and never calls /api/news) otherwise — that is
 * what keeps a kit with no addons byte-identical to one without the framework.
 *
 * Every row opens the item's own Wiki/Sources page rather than the article: the
 * page is what this box actually has, and the outside link is offered beside it.
 *
 * The sweep's errors are shown, not swallowed. A card listing yesterday's
 * headlines while every feed is failing would be lying by omission. */
export function News({ className = '', onOpenWiki }: { className?: string; onOpenWiki: (path: string) => void }) {
  const addons = useAddons()
  const enabled = addons.ready && addons.enabled('news-ingest')
  // Polled on the sweep's own scale — the cron runs hourly; five minutes is
  // already far more often than the data can change.
  const { data, loading } = useData(() => (enabled ? fetchNews() : Promise.resolve(null)), 5 * 60 * 1000)

  if (!enabled) return null

  const items = data?.items ?? []
  const errors = data?.errors ?? []
  const last = data?.lastRun

  return (
    <Card
      title="News"
      className={className}
      actions={last ? <span className="atlas-lens__count tnum">{last.at.slice(0, 10)}</span> : null}
    >
      <div className="dpass">
        <p className="dpass__sub">
          Your feeds, filed into the vault by <code>addons/news-ingest</code>. Each item has its own Source page;
          the rolling digest is <code>{data?.digest ?? 'Wiki/News-Digest.md'}</code>.
        </p>

        {errors.length ? (
          <ul className="dpass__list">
            {errors.slice(0, 3).map((e) => (
              <li key={e} className="search__warn">
                <span aria-hidden="true">⚠</span>
                <span>{e}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {items.length ? (
          <ul className="dpass__list">
            {items.map((it) => (
              <NewsRow key={it.key} it={it} onOpenWiki={onOpenWiki} />
            ))}
          </ul>
        ) : (
          <EmptyState>
            {loading && !data
              ? 'Loading…'
              : last
                ? `Nothing filed yet — the last sweep checked ${last.checked} item(s) across ${last.feeds} feed(s).`
                : 'No sweep has run yet. Configure addons/news-ingest/feeds.json and let the hourly sweep run (or POST /api/news/sweep).'}
          </EmptyState>
        )}
      </div>
    </Card>
  )
}

function NewsRow({ it, onOpenWiki }: { it: NewsItem; onOpenWiki: (path: string) => void }) {
  return (
    <li className="dpass-item">
      <div className="dpass-item__head">
        <span className="dpass-item__chip">{it.feed}</span>
        <button type="button" className="dpass-item__task dpass-item__task--link" onClick={() => onOpenWiki(it.page)}>
          {it.title || it.page}
        </button>
        <span className="dpass-item__conf tnum">{it.at.slice(0, 10)}</span>
      </div>
      {it.url ? (
        <div className="dpass-item__detail">
          <a href={it.url} target="_blank" rel="noopener noreferrer">
            {it.url}
          </a>
        </div>
      ) : null}
    </li>
  )
}
