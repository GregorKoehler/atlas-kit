/* ------------------------------------------------------------------ *
 * ESM resolve hook so `node --test` can import this project's .ts files
 * directly (node's native type-stripping erases types but does NOT resolve
 * extensionless local specifiers — the Vite/bundler convention used
 * throughout web/src, e.g. chatNotes.ts's `from './api'`). Registered
 * via `node:module`'s `register()`; no new dependency, test-only.
 * ------------------------------------------------------------------ */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && !/\.[a-z0-9]+$/i.test(specifier)) {
    const base = fileURLToPath(new URL(specifier, context.parentURL))
    for (const ext of ['.ts', '.tsx', '.js']) {
      if (existsSync(base + ext)) return nextResolve(specifier + ext, context)
    }
  }
  return nextResolve(specifier, context)
}
