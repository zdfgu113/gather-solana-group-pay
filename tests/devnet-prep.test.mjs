import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import bs58 from 'bs58'
import { Buffer } from 'buffer'
import { PublicKey } from '@solana/web3.js'
import {
  clearCreateIntentIfSame, clearPendingIfSame, createIntent, parsePending,
  readPending, savePending, samePending, withPendingLock,
} from '../src/chain/pending.ts'

const key = (byte) => new PublicKey(Uint8Array.from({ length: 32 }, () => byte)).toBase58()
const root = resolve(import.meta.dirname, '..')
const signature = bs58.encode(Uint8Array.from({ length: 64 }, () => 7))
const config = { cluster: 'devnet', programId: new PublicKey(key(1)), mint: new PublicKey(key(2)) }
const eventIdBytes = Buffer.alloc(8)
eventIdBytes.writeBigUInt64LE(513n)
const createEvent = PublicKey.findProgramAddressSync(
  [Buffer.from('event'), new PublicKey(key(5)).toBuffer(), eventIdBytes], config.programId,
)[0].toBase58()
const input = {
  title: 'Test', description: 'Test event', price: 3, minWallets: 2, capacity: 3,
  registrationDeadline: '2026-10-01T00:00:00.000Z', eventStart: '2026-10-02T00:00:00.000Z',
  timeZone: 'Etc/UTC', venue: 'Online', fulfillmentMode: 'online',
}
const record = {
  schema: 1, cluster: 'devnet', genesisHash: key(3), programId: key(1), mint: key(2),
  signature, event: createEvent, operation: 'CREATE', actor: key(5), eventId: '513',
  blockhash: key(6), lastValidBlockHeight: 200, createdAt: '2026-09-25T00:00:00.000Z',
}
function storage() {
  const values = new Map()
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

test('create intent fixes an Event ID across refresh and clears only matching completed intent', () => {
  const store = storage()
  const first = createIntent(store, 'intent', config, key(5), input, Uint8Array.of(1, 2, 0, 0, 0, 0, 0, 0))
  assert.equal(first.eventId, '513')
  assert.deepEqual(createIntent(store, 'intent', config, key(5), input, Uint8Array.of(9, 9, 9, 9, 9, 9, 9, 9)), first)
  assert.equal(clearCreateIntentIfSame(store, 'intent', '999'), false)
  assert.equal(clearCreateIntentIfSame(store, 'intent', first.eventId), true)
  assert.equal(store.getItem('intent'), null)
})

test('pending survives refresh, expiry and unknown outcome; new payments are blocked by persisted identity', () => {
  const store = storage()
  assert.equal(savePending(store, 'pending', record), true)
  assert.deepEqual(readPending(store, 'pending').record, record)
  assert.equal(savePending(store, 'pending', { ...record, signature: bs58.encode(new Uint8Array(64).fill(8)) }), false)
  assert.equal(clearPendingIfSame(store, 'pending', { ...record, event: key(7) }), false)
  assert.deepEqual(readPending(store, 'pending').record, record)
  assert.equal(clearPendingIfSame(store, 'pending', record), true)
  assert.equal(readPending(store, 'pending').record, null)
})

test('invalid pending is not erased and identity includes network, mint and operation', () => {
  const store = storage()
  store.setItem('pending', '{broken')
  assert.deepEqual(readPending(store, 'pending'), { record: null, invalid: true })
  assert.equal(store.getItem('pending'), '{broken')
  assert.equal(parsePending(JSON.stringify({ ...record, signature: 'bad' })), null)
  assert.equal(parsePending(JSON.stringify({ ...record, eventId: '18446744073709551616' })), null)
  assert.equal(parsePending(JSON.stringify({ ...record, eventId: undefined })), null)
  assert.equal(parsePending(JSON.stringify({ ...record, event: key(4) })), null)
  assert.equal(samePending(record, { ...record, cluster: 'localnet' }), false)
  assert.equal(samePending(record, { ...record, mint: key(8) }), false)
  assert.equal(samePending(record, { ...record, operation: 'JOIN' }), false)
  assert.equal(samePending(record, record), true)
})

test('two tabs serialize signing, and a late response cannot clear a newer pending', async () => {
  const store = storage()
  let release
  let held = false
  const locks = { request: async (_name, _options, run) => {
    if (held) return run(null)
    held = true
    try { return await run({ name: 'action' }) } finally { held = false }
  } }
  const first = withPendingLock('action', async () => {
    assert.equal(savePending(store, 'pending', record), true)
    await new Promise((resolve) => { release = resolve })
    return 'signed-once'
  }, locks)
  const otherTab = await withPendingLock('action', async () => 'incorrect-second-sign', locks)
  assert.equal(otherTab, undefined)
  release()
  assert.equal(await first, 'signed-once')
  const { eventId: _unused, ...withoutCreateId } = record
  const next = { ...withoutCreateId, signature: bs58.encode(new Uint8Array(64).fill(8)), operation: 'JOIN', participant: record.actor }
  store.setItem('pending', JSON.stringify(next))
  assert.equal(clearPendingIfSame(store, 'pending', record), false)
  assert.deepEqual(readPending(store, 'pending').record, next)
})

test('Devnet candidate keeps separate fixed identities and localhost IDL intact', () => {
  const localIdl = JSON.parse(readFileSync(resolve(root, 'src/idl/group_pay.json'), 'utf8'))
  const devnetIdl = JSON.parse(readFileSync(resolve(root, 'src/idl/group_pay.devnet.json'), 'utf8'))
  const localProgram = '6JrQobtnXBeNv4khZhBGCLEEfXk7pJ8Dw1UozaEhXK8R'
  const localMint = '9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj'
  const devnetProgram = '96piBXGNG9Ga8ycf6cpEJCFugjqpCvhuGjQHJc4KvzVe'
  const devnetMint = 'BAKZoZLZakRYowjaee7aXTSvTe4hVEwCybBNMAygp8nV'
  assert.equal(localIdl.address, localProgram)
  assert.equal(devnetIdl.address, devnetProgram)
  assert.ok(JSON.stringify(localIdl).includes(localMint))
  assert.ok(JSON.stringify(devnetIdl).includes(devnetMint))
  assert.deepEqual(JSON.parse(JSON.stringify(devnetIdl).replaceAll(devnetProgram, localProgram).replaceAll(devnetMint, localMint)), localIdl)
  const example = readFileSync(resolve(root, '.env.devnet.example'), 'utf8')
  assert.match(example, new RegExp(`VITE_DEVNET_PROGRAM_ID=${devnetProgram}`))
  assert.match(example, new RegExp(`VITE_DEVNET_TEST_MINT=${devnetMint}`))
  const source = readFileSync(resolve(root, 'contract/programs/group-pay/src/lib.rs'), 'utf8')
  assert.match(source, /#\[cfg\(feature = "devnet"\)\]\s*declare_id!\("96piBX/)
  assert.match(source, /#\[cfg\(not\(feature = "devnet"\)\)\]\s*declare_id!\("6JrQob/)
})
