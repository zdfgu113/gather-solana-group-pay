import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'buffer'
import { ACCOUNT_SIZE, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PublicKey, SendTransactionError } from '@solana/web3.js'
import {
  actionPrecondition, awaitConfirmation, definitePreflightOutcome, postcondition,
  readErrorNotice, resolvePendingTransaction, rpcFailureKind, safeAmount, validatePayoutAccount,
} from '../src/chain/client.ts'
import { MAX_SAFE_TOKEN_BASE_UNITS, validateCreate } from '../src/simulation.ts'

const key = (byte) => new PublicKey(Uint8Array.from({ length: 32 }, () => byte))
const signature = '2'.repeat(64)
const config = {
  cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com/', programId: key(1), mint: key(2),
  mintAuthority: key(3), expectedGenesisHash: key(4).toBase58(),
}
const pending = {
  schema: 1, cluster: 'devnet', genesisHash: config.expectedGenesisHash,
  programId: config.programId.toBase58(), mint: config.mint.toBase58(), signature,
  event: key(5).toBase58(), operation: 'CANCEL', actor: key(6).toBase58(),
  blockhash: key(7).toBase58(), blockhashSlot: 80, lastValidBlockHeight: 100,
  createdAt: '2026-09-26T00:00:00.000Z',
}
const activity = (overrides = {}) => ({
  id: pending.event, title: 'Review', description: 'Review', price: 25, minWallets: 2, capacity: 3,
  registrationDeadline: '2026-10-01T00:00:00.000Z', eventStart: '2026-10-02T00:00:00.000Z',
  fulfillmentMode: 'online', venue: 'Online', timeZone: 'UTC', organizer: pending.actor,
  organizerTokenAccount: key(8).toBase58(), unavailablePayoutAccounts: [], mint: config.mint.toBase58(),
  tokenProgram: TOKEN_PROGRAM_ID.toBase58(), status: 'OPEN', simulatedNow: '2026-09-26T00:00:00.000Z',
  vaultBalance: 25, participations: [{ wallet: key(9).toBase58(), paidAmount: 25, joinedAt: '2026-09-25T00:00:00.000Z' }],
  transactions: [], ...overrides,
})
const confirmed = { slot: 1, confirmations: 1, err: null, confirmationStatus: 'confirmed' }

test('definite preflight rejection is distinguished from every unknown signed error', async () => {
  const rejected = new SendTransactionError({
    action: 'simulate', signature: '',
    transactionMessage: 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1',
    logs: ['Program log: rejected'],
  })
  const connection = { getSignatureStatuses: async () => ({ value: [null] }) }
  assert.equal(await definitePreflightOutcome(connection, pending, rejected), 'rejected')
  assert.equal(await definitePreflightOutcome(connection, pending, new Error('fetch failed')), 'unknown')
  const blockhash = new SendTransactionError({
    action: 'simulate', signature: '', transactionMessage: 'Transaction simulation failed: blockhash not found', logs: [],
  })
  assert.equal(await definitePreflightOutcome(connection, pending, blockhash), 'unknown')
  assert.equal(await definitePreflightOutcome({ getSignatureStatuses: async () => ({ value: [confirmed] }) }, pending, rejected), 'status-found')
})

test('unknown, processed and incompletely evidenced expiry remain unresolved', async () => {
  assert.equal((await awaitConfirmation({
    getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 99,
  }, pending, { attempts: 2, delayMs: 0 })).kind, 'unknown')
  assert.equal((await awaitConfirmation({
    getSignatureStatuses: async () => ({ value: [{ ...confirmed, confirmationStatus: 'processed' }] }),
    getBlockHeight: async () => 101,
  }, pending, { attempts: 1, delayMs: 0 })).kind, 'unknown')
  assert.equal((await awaitConfirmation({
    getSignatureStatuses: async () => ({ value: [{
      ...confirmed, confirmationStatus: 'processed', err: { InstructionError: [0, 'Custom'] },
    }] }),
    getBlockHeight: async () => 101,
  }, pending, { attempts: 1, delayMs: 0 })).kind, 'unknown')
  assert.equal((await awaitConfirmation({
    getSignatureStatuses: async () => ({ value: [null] }), getBlockHeight: async () => 101,
  }, { ...pending, blockhashSlot: undefined }, { attempts: 1, delayMs: 0 })).kind, 'unknown')
})

test('empty expiry checks from mixed-progress RPC backends never prove a transaction unlanded', async () => {
  let statusReads = 0
  let downstreamReads = 0
  const connection = {
    getSignatureStatuses: async () => { statusReads++; return { context: { slot: 10 }, value: [null] } },
    getBlockHeight: async () => { downstreamReads++; return 101 },
    isBlockhashValid: async () => { downstreamReads++; return { context: { slot: 500 }, value: false } },
    getFirstAvailableBlock: async () => { throw new Error('must not be used as completeness evidence') },
    getTransaction: async () => { downstreamReads++; return null },
  }
  assert.equal((await awaitConfirmation(connection, pending, { attempts: 1, delayMs: 0 })).kind, 'unknown')
  assert.ok(statusReads >= 1)
  assert.equal(downstreamReads, 0)

  const currentStatus = { ...connection, getSignatureStatuses: async () => ({ context: { slot: 500 }, value: [null] }) }
  assert.equal((await awaitConfirmation({
    ...currentStatus,
    isBlockhashValid: async () => ({ context: { slot: 10 }, value: false }),
    getTransaction: async () => { throw new Error('a stale validity context must stop the check') },
  }, pending, { attempts: 1, delayMs: 0 })).kind, 'expired-check')
  assert.equal((await awaitConfirmation(currentStatus, pending, { attempts: 1, delayMs: 0 })).kind, 'expired-check')
})

test('a finalized transaction without execution metadata is not treated as success', async () => {
  const base = {
    getSignatureStatuses: async () => ({ context: { slot: 500 }, value: [null] }),
    getBlockHeight: async () => 101,
    isBlockhashValid: async () => ({ context: { slot: 500 }, value: false }),
    getFirstAvailableBlock: async () => 1,
  }
  assert.equal((await awaitConfirmation({
    ...base, getTransaction: async () => ({ slot: 500, meta: null }),
  }, pending, { attempts: 1, delayMs: 0 })).kind, 'expired-check')
})

test('exact signature result clears independently of best-effort current-state reading', async () => {
  const connection = {
    getGenesisHash: async () => pending.genesisHash,
    getSignatureStatuses: async () => ({ value: [confirmed] }),
  }
  assert.equal((await resolvePendingTransaction(connection, config, pending, async () => activity({ status: 'REFUNDED' }), { delayMs: 0 })).kind, 'confirmed')
  assert.equal((await resolvePendingTransaction(connection, config, { ...pending, operation: 'MARK_FAILED' }, async () => activity({ status: 'REFUNDED' }), { delayMs: 0 })).kind, 'confirmed')
  assert.equal((await resolvePendingTransaction(connection, config, {
    ...pending, operation: 'UPDATE_PAYOUT', newPayout: key(10).toBase58(),
  }, async () => activity({ organizerTokenAccount: key(11).toBase58(), status: 'READY' }), { delayMs: 0 })).kind, 'confirmed')
  assert.equal((await resolvePendingTransaction(connection, config, pending, async () => { throw new Error('temporary read failure') }, { delayMs: 0 })).kind, 'confirmed-unread')
  const failedConnection = {
    ...connection,
    getSignatureStatuses: async () => ({ value: [{ ...confirmed, err: { InstructionError: [0, 'Custom'] } }] }),
  }
  assert.deepEqual(await resolvePendingTransaction(failedConnection, config, pending, async () => { throw new Error('read failed') }, { delayMs: 0 }), { kind: 'failed' })
})

test('recovery timeouts finish the check without inventing a transaction result', async () => {
  const never = () => new Promise(() => {})
  const readTimeout = resolvePendingTransaction({
    getGenesisHash: async () => pending.genesisHash,
    getSignatureStatuses: async () => ({ value: [confirmed] }),
  }, config, pending, never, { delayMs: 0, readTimeoutMs: 5 })
  assert.equal((await Promise.race([
    readTimeout,
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'test-timeout' }), 50)),
  ])).kind, 'confirmed-unread')

  const confirmationTimeout = resolvePendingTransaction({
    getGenesisHash: async () => pending.genesisHash,
    getSignatureStatuses: never,
  }, config, pending, async () => activity(), { delayMs: 0, confirmationTimeoutMs: 5 })
  assert.equal((await Promise.race([
    confirmationTimeout,
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'test-timeout' }), 50)),
  ])).kind, 'unknown')

  const genesisTimeout = resolvePendingTransaction({
    getGenesisHash: never,
  }, config, pending, async () => activity(), { confirmationTimeoutMs: 5 })
  assert.equal((await Promise.race([
    genesisTimeout,
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'test-timeout' }), 50)),
  ])).kind, 'unknown')
})

test('a timed-out confirmation poll stops before issuing any later RPC read', async () => {
  let statusReads = 0
  let downstreamReads = 0
  const result = await resolvePendingTransaction({
    getGenesisHash: async () => pending.genesisHash,
    getSignatureStatuses: async () => {
      statusReads++
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { context: { slot: 500 }, value: [null] }
    },
    getBlockHeight: async () => { downstreamReads++; return 99 },
  }, config, pending, async () => activity(), { attempts: 10, delayMs: 0, confirmationTimeoutMs: 5 })
  assert.equal(result.kind, 'unknown')
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(statusReads, 1)
  assert.equal(downstreamReads, 0)
})

test('success diagnostics accept legal successors but reject wrong empty-close provenance', async () => {
  assert.equal(await postcondition({}, pending, activity({ status: 'REFUNDED' })), true)
  assert.equal(await postcondition({}, pending, activity({ status: 'CLOSED_EMPTY', closureReason: 'deadline_empty', participations: [] })), false)
  assert.equal(await postcondition({}, pending, activity({ status: 'CLOSED_EMPTY', closureReason: 'organizer_cancelled_empty', participations: [] })), true)
})

test('action preconditions reject stale role, state and deadline before signing', () => {
  assert.equal(actionPrecondition(activity(), { type: 'CANCEL' }, key(12).toBase58()), 'organizerOnly')
  assert.equal(actionPrecondition(activity({ simulatedNow: '2026-10-01T00:00:00.000Z' }), { type: 'JOIN' }, key(12).toBase58()), 'joinClosed')
  assert.equal(actionPrecondition(activity({ status: 'PAID' }), { type: 'UPDATE_PAYOUT', account: key(10).toBase58() }, pending.actor), 'payoutUpdateState')
  assert.equal(actionPrecondition(activity({ status: 'REFUNDING_FAILED' }), { type: 'REFUND' }, key(12).toBase58()), 'refundNotParticipant')
  assert.equal(actionPrecondition(activity({ status: 'READY' }), { type: 'FINALIZE' }, key(12).toBase58()), null)
})

test('create and read ranges share the same safe base-unit ceiling', () => {
  const now = Date.parse('2026-01-01T00:00:00.000Z')
  const input = {
    title: 'T', description: 'D', venue: 'V', timeZone: 'UTC', fulfillmentMode: 'online',
    minWallets: 2, capacity: 2, price: 4_503_599_627,
    registrationDeadline: '2026-01-02T00:00:00.000Z', eventStart: '2026-01-03T00:00:00.000Z',
  }
  assert.equal(validateCreate(input, now), null)
  assert.equal(validateCreate({ ...input, price: input.price + 1 }, now), 'createTotalTooLarge')
  assert.doesNotThrow(() => safeAmount(MAX_SAFE_TOKEN_BASE_UNITS))
  assert.throws(() => safeAmount(MAX_SAFE_TOKEN_BASE_UNITS + 1n), /supported UI range/)
})

test('replacement payout must be an existing initialized classic account for mint and organizer', async () => {
  const address = key(20)
  const organizer = key(21)
  const data = Buffer.alloc(ACCOUNT_SIZE)
  config.mint.toBuffer().copy(data, 0)
  organizer.toBuffer().copy(data, 32)
  data[108] = 1
  const valid = { owner: TOKEN_PROGRAM_ID, data }
  assert.equal((await validatePayoutAccount({ getAccountInfo: async () => valid }, config, address.toBase58(), organizer.toBase58(), key(22).toBase58())).toBase58(), address.toBase58())
  await assert.rejects(validatePayoutAccount({ getAccountInfo: async () => null }, config, address.toBase58(), organizer.toBase58(), key(22).toBase58()), /PAYOUT_ACCOUNT_INVALID/)
  const frozen = Buffer.from(data); frozen[108] = 2
  await assert.rejects(validatePayoutAccount({ getAccountInfo: async () => ({ ...valid, data: frozen }) }, config, address.toBase58(), organizer.toBase58(), key(22).toBase58()), /PAYOUT_ACCOUNT_INVALID/)
  await assert.rejects(validatePayoutAccount({ getAccountInfo: async () => valid }, config, address.toBase58(), organizer.toBase58(), address.toBase58()), /PAYOUT_ACCOUNT_SAME/)
})

test('read errors distinguish address, absence, invalid data, HTTP throttling, network and timeout', () => {
  assert.equal(readErrorNotice(new Error('EVENT_ADDRESS_INVALID')), 'localBadAddress')
  assert.equal(readErrorNotice(new Error('EVENT_ACCOUNT_NOT_FOUND')), 'localEventMissing')
  assert.equal(readErrorNotice(new Error('EVENT_ACCOUNT_INVALID: wrong owner')), 'localEventInvalid')
  assert.equal(readErrorNotice(new Error('403 Forbidden')), 'localRpcHttp')
  assert.equal(readErrorNotice(new Error('429 Too Many Requests')), 'localRpcHttp')
  assert.equal(readErrorNotice(new Error('fetch failed')), 'localRpcOffline')
  assert.equal(readErrorNotice(new Error('Public read timed out')), 'localRpcTimeout')
  assert.equal(rpcFailureKind(new Error('unrelated')), null)
})
