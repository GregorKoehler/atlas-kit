/* A fixture addon that takes express ONLY from its register() context and
 * imports NOTHING. That is the whole assertion: this is the one form available
 * to a REAL addon, which sits outside api/'s node_modules resolution — the
 * `demo` fixture's plain `import express` works only because fixtures live under
 * api/test/ and resolve into api/node_modules, so it can never catch a
 * regression in the injection. */
export default function register({ name, express, Router }) {
  const routes = Router()
  routes.get('/api/injected/ping', (_req, res) => res.json({ ok: true, name, json: typeof express.json === 'function' }))
  return { description: 'fixture addon — express from the register context, no imports', routes }
}
