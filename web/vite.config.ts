import { defineConfig } from 'vite'
import preact from '@preact/preset-vite'

// Single-origin in prod: Caddy serves web/dist and reverse-proxies /api/* and
// /agent-app/* to the Express API (api/src/server.mjs). In dev, Vite listens on
// 5173 and proxies those same paths to the local Express API so the one /api
// contract works in both places.
//
// The dashboard bearer token is injected server-side here (from the env that
// `scripts/dev.sh` sources from .env) so the browser never holds it — mirroring
// what Caddy does in production. It is harmless on read (GET) routes.
declare const process: { env: Record<string, string | undefined> }
const BEARER = process.env.DASHBOARD_BEARER_TOKEN || ''
const API_TARGET = `http://127.0.0.1:${process.env.API_PORT || '3001'}`

const withBearer = (target: string) => ({
  target,
  changeOrigin: false,
  headers: BEARER ? { Authorization: `Bearer ${BEARER}` } : undefined,
})

export default defineConfig({
  plugins: [preact()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': withBearer(API_TARGET),
      // Dev-agent live-app preview (HTTP + WebSocket).
      '/agent-app': { target: API_TARGET, changeOrigin: false, ws: true },
    },
  },
  preview: {
    host: true,
    port: 5173,
    strictPort: true,
  },
})
