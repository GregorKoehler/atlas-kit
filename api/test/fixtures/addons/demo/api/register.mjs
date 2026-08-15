/* A fixture addon: exercises every hook the framework offers, in one place, so
 * "the hook API works" is asserted against a real addon rather than a mock of
 * the loader. Deliberately trivial — it must add no dependency of its own.
 *
 * The two failure switches (`__throw__` as a query, DEMO_ADDON_STATS_THROW) are
 * here rather than monkey-patched from the test on purpose: the accessors hand
 * out copies of the manifest, so a test that patched one would be asserting on
 * an object core never sees. */
import express from 'express'

export default function register({ name, dir }) {
  const routes = express.Router()
  routes.get('/api/demo-addon/ping', (_req, res) => res.json({ ok: true, name, dir: !!dir }))
  return {
    description: 'fixture addon — every hook, nothing real',
    routes,
    mcpTools: [{ name: 'demo_ping', description: 'fixture read tool', inputSchema: {}, handler: async () => ({ pong: true }) }],
    searchLeg: {
      key: 'demo',
      label: 'Demo leg',
      search: async ({ q, limit }) => {
        if (q === '__throw__') throw new Error('encoder exploded')
        return {
          available: true,
          ms: 1,
          index: { ageMinutes: 3 },
          items: Array.from({ length: Math.min(2, limit) }, (_, i) => ({
            type: 'note',
            title: `demo:${q}:${i}`,
            subtitle: 'demo',
            path: `Demo${i}.md`,
            section: 'A › B',
            snippet: 'demo snippet',
            similarity: 0.5 - i / 100,
          })),
        }
      },
    },
    evidenceLeg: {
      subAsks: () => ['ask-one', 'ask-two'],
      semanticCandidates: async () => ({
        available: true,
        rows: [{ path: 'Demo0.md', title: 'demo', section: '', text: 'demo passage', similarity: 0.5, pageScore: 0.5 }],
        pages: 1,
        asks: 2,
        ms: 1,
      }),
    },
    scorecardStats: () => {
      if (process.env.DEMO_ADDON_STATS_THROW) throw new Error('stats exploded')
      return [{ label: 'Demo tile', value: '1', trend: 'neutral', group: 'Demo addon' }]
    },
    cron: [{ schedule: '*/7 * * * *', command: 'echo demo', comment: 'fixture entry' }],
    status: () => ({ fixture: true }),
  }
}
