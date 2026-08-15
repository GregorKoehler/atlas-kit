/* ------------------------------------------------------------------ *
 * Tests for scanShipMarker (subagent-scan.mjs) — the CONSUMER half of the
 * ship-marker pair. Its producer is RECONCILE_PREAMBLE in agent-routes.mjs
 * (pinned separately in ship-prompt.test.mjs). Change the prefix or format in
 * one without the other and ship detection breaks silently, which is exactly
 * what this file exists to make loud.
 *
 * Shared by BOTH the box-local executor and the bridge, so a workstation dev
 * agent carries the same shipState/shipInfo as a box-local one.
 *
 * Run: node --test api/test/ship-marker.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanShipMarker } from '../src/subagent-scan.mjs'

// One assistant transcript event carrying a single text block.
const asst = (text) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const user = (text) => JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text }] } })

test('READY-TO-SHIP marker → ready, empty info', () => {
  const lines = [asst('Work is done and mergeable.\nATLAS:READY-TO-SHIP')]
  assert.deepEqual(scanShipMarker(lines), { state: 'ready', info: '' })
})

test('SHIPPED marker → shipped, with trimmed info', () => {
  const lines = [asst('Merged it.\nATLAS:SHIPPED PR #12 e0f95cb')]
  assert.deepEqual(scanShipMarker(lines), { state: 'shipped', info: 'PR #12 e0f95cb' })
})

test('no marker → null', () => {
  assert.equal(scanShipMarker([asst('just a normal reply, nothing to ship')]), null)
})

test('newest marker wins — shipped then a new task back to ready', () => {
  const lines = [asst('ATLAS:SHIPPED PR #1 aaa'), asst('starting a follow-up\nATLAS:READY-TO-SHIP')]
  assert.deepEqual(scanShipMarker(lines), { state: 'ready', info: '' })
})

test('only ASSISTANT text counts — a user event echoing the marker is ignored', () => {
  // The preamble/instructions live in user-side events; they must never match.
  assert.equal(scanShipMarker([user('remember to print ATLAS:SHIPPED when done')]), null)
})

test('marker must be on its own line — mid-sentence does not match', () => {
  assert.equal(scanShipMarker([asst('we are ATLAS:READY-TO-SHIP basically')]), null)
})

test('non-JSON / partial first line is skipped harmlessly', () => {
  const lines = ['…truncated mid-json{"broke', asst('ATLAS:READY-TO-SHIP')]
  assert.deepEqual(scanShipMarker(lines), { state: 'ready', info: '' })
})

test('the pre-rebrand prefix is NOT accepted — the regex moved, on purpose', () => {
  assert.equal(scanShipMarker([asst('GRAVIS:READY-TO-SHIP')]), null)
})
