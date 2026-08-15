/* ------------------------------------------------------------------ *
 * `agent-msg` — the wrapper script every dev agent gets on its PATH.
 *
 * ONE source, two executors: the box-local one writes it into
 * ~/.atlas-kit/bin (agent-local.mjs), the remote bridge writes the SAME bytes
 * into each container (agent-bridge/server.mjs). The only thing that differs per
 * location is the env the agent is launched with — `ATLAS_API` points at the
 * dashboard API on the box, or at the bridge's own `/api/agents/message` (which
 * forwards the attempt to the box and returns its verdict). So the agent's
 * command, its usage error and its exit codes are identical wherever it runs.
 *
 * Plain CommonJS (no package.json in the dir it lands in) — hence `.then` rather
 * than top-level await; `fetch` is a node global.
 * ------------------------------------------------------------------ */
export const MSG_WRAPPER_SRC = `#!/usr/bin/env node
// atlas-kit agent↔agent mail — send an async message to another agent in your
// lineage (parent / child / sibling). Written by the executor; do not edit.
const [to, ...rest] = process.argv.slice(2)
const inline = rest.join(' ')
if (!to || !inline) {
  console.error('usage: agent-msg <agent-id> <message…>    (message "-" reads stdin)')
  process.exit(2)
}
const read = () =>
  inline === '-'
    ? new Promise((res) => {
        let b = ''
        process.stdin.setEncoding('utf-8')
        process.stdin.on('data', (c) => (b += c))
        process.stdin.on('end', () => res(b))
      })
    : Promise.resolve(inline)
read()
  .then((text) =>
    fetch((process.env.ATLAS_API || 'http://127.0.0.1:3001') + '/api/agents/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (process.env.ATLAS_AGENT_TOKEN || '') },
      body: JSON.stringify({ to, text }),
    }),
  )
  .then(async (r) => {
    const j = await r.json().catch(() => ({}))
    if (!r.ok || j.ok === false) {
      console.error('agent-msg: ' + (j.error || 'HTTP ' + r.status))
      process.exit(1)
    }
    console.log(j.note || 'queued for ' + to)
  })
  .catch((e) => {
    console.error('agent-msg: ' + e.message)
    process.exit(1)
  })
`
