/* A stand-in for `api/embed-worker.mjs` with no ONNX runtime in it, so the
 * CLIENT's lifecycle — a worker that burns CPU, crashes, exits, or never
 * answers — is testable on a machine that has no encoder, which is every CI
 * runner. It speaks the same envelope: `{id, op, payload, sentAt}` in,
 * `{id, ok, value|error, queueMs, state?}` out.
 *
 * `threadId` rides every reply because "one worker for both legs" and "a crash
 * respawns exactly one" are otherwise unobservable from the outside. */
import { parentPort, threadId } from 'node:worker_threads'

let calls = 0

parentPort.on('message', ({ id, op, payload, sentAt }) => {
  calls++
  const reply = (m) => parentPort.postMessage({ id, queueMs: Math.max(0, Date.now() - sentAt), ...m })
  switch (op) {
    case 'burn': {
      // A REAL block, not a sleep: the encoder holds the thread it runs on, and
      // a sleeping worker would prove nothing about the loop it is not on.
      const until = Date.now() + payload.ms
      while (Date.now() < until) {}
      return reply({ ok: true, value: { threadId, calls } })
    }
    case 'crash':
      throw new Error('stub worker crashed')
    case 'exit':
      return process.exit(7)
    case 'hang':
      return // never answers — what a wedged encoder looks like from outside
    case 'announce':
      parentPort.postMessage({ state: payload }) // unsolicited, as a load/eviction is
      return reply({ ok: true, value: { threadId } })
    default:
      return reply({ ok: true, value: { threadId, calls, echo: payload } })
  }
})
