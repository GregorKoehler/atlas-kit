/* ------------------------------------------------------------------ *
 * Tests for the attached-file read hold (fileReads.ts).
 *
 * A picked file is read to a data URL after the pick. Sent in that window, the
 * message went out WITHOUT the file and the file then landed in the NEXT draft.
 * Pinned: `pending` counts the reads in flight (the composer holds every send
 * path on it), a read lands only in the draft it was started for, and a failed
 * read releases the hold.
 * Run: node --test web/src/lib/fileReads.test.mjs
 * ------------------------------------------------------------------ */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FileReads } from './fileReads.ts'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

test('pending counts every read in flight and reports each change', async () => {
  const seen = []
  const reads = new FileReads((n) => seen.push(n))
  const a = deferred(), b = deferred()
  const landed = []
  const ra = reads.read(a.promise, (v) => landed.push(v))
  const rb = reads.read(b.promise, (v) => landed.push(v))
  assert.equal(reads.pending, 2, 'held while either read is out')
  b.resolve('b')
  await rb
  assert.equal(reads.pending, 1, 'still held: one read is left')
  a.resolve('a')
  await ra
  assert.equal(reads.pending, 0)
  assert.deepEqual(landed, ['b', 'a'])
  assert.deepEqual(seen, [1, 2, 1, 0])
})

test('a read that finishes after its draft was sent or cleared never lands in the next one', async () => {
  const reads = new FileReads()
  const late = deferred()
  const landed = []
  const r = reads.read(late.promise, (v) => landed.push(v))
  reads.discard()
  late.resolve('file for the old draft')
  await r
  assert.deepEqual(landed, [], 'dropped, not attached to the next message')
  assert.equal(reads.pending, 0)
  await reads.read(Promise.resolve('fresh'), (v) => landed.push(v))
  assert.deepEqual(landed, ['fresh'], 'a read started after the discard lands as usual')
})

test('a failed read rejects and still releases the hold', async () => {
  const reads = new FileReads()
  await assert.rejects(reads.read(Promise.reject(new Error('unreadable')), () => assert.fail('must not land')))
  assert.equal(reads.pending, 0, 'a broken file must not hold every send forever')
})
