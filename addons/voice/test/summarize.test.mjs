/* ------------------------------------------------------------------ *
 * The recap half of `addons/voice`: the prompt, the spoken-text bounds, and —
 * the reason this file exists — THE RUNAWAY-LOOP GUARD.
 *
 * A recap is fired by a fleet EVENT, not by a human. Upstream's equivalent
 * summarizer, unguarded, fired 2,753 `claude -p` calls in a day where 2–5 was
 * normal, because a flapping busy/idle status is an event source with no natural
 * rate limit. So the guards are tested as the load-bearing thing they are:
 *
 *   · an unchanged tail never buys a second call, whatever the event says;
 *   · a changed tail still cannot beat the per-agent minimum interval;
 *   · the daily budget is global across agents, and rolls over on the date;
 *   · a SKIPPED call reserves nothing and an ALLOWED call reserves everything,
 *     so two overlapping calls cannot both pass.
 *
 * Hermetic: `claude` is never spawned — recap() takes the runner as a seam and
 * everything else here is pure.
 * Run: node --test addons/voice/test/summarize.test.mjs
 * ------------------------------------------------------------------ */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

process.env.ATLAS_VOICE_MIN_INTERVAL_MS = '60000'
process.env.ATLAS_VOICE_DAILY_BUDGET = '3'

const { cleanTail, buildRecapPrompt, sanitizeSpoken, recapGuard, resetRecapGuards, budgetState, recap, EVENTS } = await import('../api/summarize.mjs')

beforeEach(() => resetRecapGuards())

const DAY = new Date('2026-08-15T10:00:00Z').getTime()

test('cleanTail strips terminal chrome and bounds what reaches the prompt', () => {
  const raw = `\x1b[32mgreen\x1b[0m line\n╭─ box ─╮\n❯ prompt (esc to interrupt)\ntrailing spaces   `
  const clean = cleanTail(raw)
  assert.ok(!clean.includes('\x1b'), 'ANSI escapes are gone')
  assert.ok(clean.includes('green line'))
  assert.ok(!clean.includes('esc to interrupt'))
  assert.ok(!/\s$/.test(clean))

  // Both bounds hold — the line cap alone would let one enormous line through.
  const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')
  assert.equal(cleanTail(long, { lines: 10, chars: 6000 }).split('\n').length, 10)
  assert.equal(cleanTail('x'.repeat(9000), { lines: 140, chars: 100 }).length, 100)
  assert.equal(cleanTail(''), '')
})

test('the prompt names the event, so the recap opens on what happened', () => {
  const p = buildRecapPrompt({ event: 'ready', agent: 'docs sweep', clean: 'all tests pass' })
  assert.ok(p.includes('READY-TO-SHIP'))
  assert.ok(p.includes('docs sweep'))
  assert.ok(p.includes('all tests pass'))
  // An unknown event degrades to the neutral framing rather than throwing.
  assert.ok(buildRecapPrompt({ event: 'nope', clean: 'x' }).includes('status update'))
  assert.ok(EVENTS.includes('turn-end') && EVENTS.includes('manual'))
})

test('spoken text is flattened, de-fenced and cut at a sentence end', () => {
  assert.equal(sanitizeSpoken('```\nHello  there\nfriend\n```'), 'Hello there friend')
  const long = `${'One sentence here. '.repeat(20)}And a trailing fragment without an end`
  const out = sanitizeSpoken(long, 200)
  assert.ok(out.length <= 200)
  assert.ok(out.endsWith('.'), 'stops on a full stop, not mid-word')
  // No sentence end inside the cap → a hard slice is still better than a monologue.
  assert.equal(sanitizeSpoken('x'.repeat(300), 50).length, 50)
})

test('guard 1: the same tail for the same agent never buys a second call', () => {
  assert.equal(recapGuard('a1', 'same tail', DAY), null)
  assert.equal(recapGuard('a1', 'same tail', DAY + 10 * 60_000), 'unchanged-tail')
  // …but a different agent with the same text is a different fact.
  assert.equal(recapGuard('a2', 'same tail', DAY), null)
})

test('guard 2: a changed tail still cannot beat the per-agent minimum interval', () => {
  assert.equal(recapGuard('a1', 'tail one', DAY), null)
  assert.equal(recapGuard('a1', 'tail two', DAY + 30_000), 'min-interval')
  assert.equal(recapGuard('a1', 'tail three', DAY + 61_000), null)
})

test('guard 3: the daily budget is global, and rolls over on the date', () => {
  assert.equal(recapGuard('a1', 't1', DAY), null)
  assert.equal(recapGuard('a2', 't2', DAY), null)
  assert.equal(recapGuard('a3', 't3', DAY), null)
  assert.equal(recapGuard('a4', 't4', DAY), 'daily-budget', 'the cap is across the fleet, not per agent')
  assert.deepEqual(budgetState(DAY), { day: '2026-08-15', spent: 3, budget: 3, tripped: true })

  const nextDay = DAY + 24 * 3600_000
  assert.equal(recapGuard('a4', 't4', nextDay), null)
  assert.equal(budgetState(nextDay).spent, 1)
})

test('a skipped call reserves nothing — the budget only pays for calls that ran', () => {
  assert.equal(recapGuard('a1', 'tail', DAY), null)
  assert.equal(recapGuard('a1', 'tail', DAY + 1000), 'unchanged-tail')
  assert.equal(budgetState(DAY).spent, 1)
})

test('recap(): guarded, bounded, and never throwing', async () => {
  const calls = []
  const runImpl = async (prompt) => {
    calls.push(prompt)
    return 'The agent finished the refactor and is waiting for a review.'
  }

  const first = await recap({ agentId: 'a1', agent: 'refactor', event: 'turn-end', tail: 'work work' }, { runImpl, now: DAY })
  assert.deepEqual(first, { ok: true, text: 'The agent finished the refactor and is waiting for a review.' })
  assert.equal(calls.length, 1)

  // The same event again is a SKIP, not a second call — that is the whole point.
  const again = await recap({ agentId: 'a1', agent: 'refactor', event: 'turn-end', tail: 'work work' }, { runImpl, now: DAY + 1000 })
  assert.deepEqual(again, { ok: false, skipped: 'unchanged-tail' })
  assert.equal(calls.length, 1)

  // Nothing to say, an empty answer and a failing CLI are all reported, not thrown.
  assert.match((await recap({ tail: '   ' }, { runImpl })).error, /no session output/)
  assert.match((await recap({ agentId: 'b', tail: 'fresh' }, { runImpl: async () => '', now: DAY })).error, /empty recap/)
  assert.match(
    (await recap({ agentId: 'c', tail: 'fresh' }, { runImpl: async () => { throw new Error('claude -p exited 1: nope') }, now: DAY })).error,
    /exited 1/,
  )
})

test('the recap is never fed back into another prompt (no recursion)', async () => {
  const prompts = []
  const runImpl = async (p) => {
    prompts.push(p)
    return 'A distinctive previous answer.'
  }
  await recap({ agentId: 'a1', event: 'turn-end', tail: 'one' }, { runImpl, now: DAY })
  await recap({ agentId: 'a1', event: 'turn-end', tail: 'two' }, { runImpl, now: DAY + 120_000 })
  assert.equal(prompts.length, 2)
  assert.ok(!prompts[1].includes('A distinctive previous answer.'), 'the second prompt carries no earlier answer')
})
