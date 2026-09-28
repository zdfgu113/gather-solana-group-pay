import test from 'node:test'
import assert from 'node:assert/strict'
import { appendTransactionOnce, createPendingCheckGate } from '../src/local/pending-check.ts'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('automatic and rapid manual checks share one in-flight signature and one history row', async () => {
  const record = { signature: 'sig-A', event: 'event-A' }
  let pending = record
  let reads = 0
  let rows = []
  const slow = deferred()
  const check = createPendingCheckGate(() => pending)
  const commit = (result) => {
    assert.equal(result.ok, true)
    rows = appendTransactionOnce(rows, { id: record.signature })
    pending = null
  }
  const automatic = check(record, () => { reads++; return slow.promise }, commit)
  const manual = check(record, () => { reads++; return Promise.resolve('confirmed') }, commit)
  const repeatedManual = check(record, () => { reads++; return Promise.resolve('confirmed') }, commit)
  assert.equal(await manual, false)
  assert.equal(await repeatedManual, false)
  slow.resolve('confirmed')
  assert.equal(await automatic, true)
  assert.equal(reads, 1)
  assert.deepEqual(rows, [{ id: 'sig-A' }])
  assert.strictEqual(appendTransactionOnce(rows, { id: 'sig-A' }), rows)
})

test('an old delayed confirmation or error cannot commit over a newer pending record', async () => {
  const old = { signature: 'sig-old', event: 'event-old' }
  const next = { signature: 'sig-new', event: 'event-new' }
  let pending = old
  let activity = 'event-new'
  const notices = []
  const slow = deferred()
  const check = createPendingCheckGate(() => pending)
  const oldCheck = check(old, () => slow.promise, () => {
    pending = null
    activity = 'event-old'
    notices.push('old success')
  })
  pending = next
  await check(next, async () => 'unknown', (outcome) => notices.push(outcome.value))
  slow.resolve('confirmed')
  assert.equal(await oldCheck, false)
  assert.strictEqual(pending, next)
  assert.equal(activity, 'event-new')
  assert.deepEqual(notices, ['unknown'])

  const oldError = deferred()
  pending = old
  const staleError = check(old, () => oldError.promise, () => notices.push('old error'))
  pending = next
  oldError.resolve(Promise.reject(new Error('old RPC failure')))
  assert.equal(await staleError, false)
  assert.strictEqual(pending, next)
  assert.deepEqual(notices, ['unknown'])
})

test('unknown RPC result keeps the pending signature for a later sequential recheck', async () => {
  const record = { signature: 'sig-unknown', event: 'event-A' }
  let pending = record
  let payments = 1
  const check = createPendingCheckGate(() => pending)
  await check(record, async () => 'unknown', (outcome) => {
    assert.equal(outcome.value, 'unknown')
    assert.strictEqual(pending, record)
  })
  const payAgain = () => { if (pending) return false; payments++; return true }
  assert.equal(payAgain(), false)
  assert.equal(payments, 1)
  await check(record, async () => 'confirmed', () => { pending = null })
  assert.equal(pending, null)
})
