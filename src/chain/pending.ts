import bs58 from 'bs58'
import { Buffer } from 'buffer'
import { PublicKey } from '@solana/web3.js'
import type { CreateInput } from '../simulation'
import type { ChainConfig } from './config'
import type { PendingTransaction } from './client'

const OPERATIONS = new Set([
  'CREATE', 'JOIN', 'SETTLE', 'CANCEL', 'MARK_FAILED', 'FINALIZE_EMPTY',
  'REFUND', 'UPDATE_PAYOUT', 'CLOSE_PAYOUT',
])

function key(value: unknown) {
  if (typeof value !== 'string') return false
  try { return new PublicKey(value).toBase58() === value } catch { return false }
}

export function parsePending(raw: string | null): PendingTransaction | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as PendingTransaction
    if (p.schema !== 1 || !['localnet', 'devnet'].includes(p.cluster) ||
      !key(p.genesisHash) || !key(p.programId) || !key(p.mint) || !key(p.event) || !key(p.actor) || !key(p.blockhash) ||
      typeof p.signature !== 'string' || bs58.decode(p.signature).length !== 64 ||
      !OPERATIONS.has(p.operation) || !Number.isSafeInteger(p.lastValidBlockHeight) || p.lastValidBlockHeight < 0 ||
      (p.blockhashSlot !== undefined && (!Number.isSafeInteger(p.blockhashSlot) || p.blockhashSlot < 0)) ||
      Number.isNaN(Date.parse(p.createdAt)) ||
      (p.eventId !== undefined && !validEventId(p.eventId)) ||
      (p.participant !== undefined && !key(p.participant)) ||
      (p.newPayout !== undefined && !key(p.newPayout))) return null
    if (p.operation === 'CREATE') {
      if (!validEventId(p.eventId)) return null
      const id = Buffer.alloc(8)
      id.writeBigUInt64LE(BigInt(p.eventId))
      const derived = PublicKey.findProgramAddressSync(
        [Buffer.from('event'), new PublicKey(p.actor).toBuffer(), id], new PublicKey(p.programId),
      )[0]
      if (derived.toBase58() !== p.event) return null
    }
    if ((p.operation === 'JOIN' || p.operation === 'REFUND') && p.participant !== p.actor) return null
    if (p.operation === 'UPDATE_PAYOUT' && !p.newPayout) return null
    return p
  } catch { return null }
}

export function samePending(a: PendingTransaction | null, b: PendingTransaction | null) {
  return Boolean(a && b && a.signature === b.signature && a.event === b.event &&
    a.cluster === b.cluster && a.genesisHash === b.genesisHash && a.programId === b.programId &&
    a.mint === b.mint && a.operation === b.operation && a.actor === b.actor &&
    a.participant === b.participant && a.newPayout === b.newPayout && a.eventId === b.eventId &&
    a.blockhash === b.blockhash && a.blockhashSlot === b.blockhashSlot &&
    a.lastValidBlockHeight === b.lastValidBlockHeight && a.createdAt === b.createdAt)
}

export function readPending(storage: Pick<Storage, 'getItem'>, storageKey: string) {
  const raw = storage.getItem(storageKey)
  const record = parsePending(raw)
  return { record, invalid: raw !== null && record === null }
}

// Call writes while holding the browser Web Lock for this chain identity.
export function savePending(storage: Pick<Storage, 'getItem' | 'setItem'>, storageKey: string, record: PendingTransaction) {
  if (storage.getItem(storageKey) !== null) return false
  storage.setItem(storageKey, JSON.stringify(record))
  return true
}

export function clearPendingIfSame(storage: Pick<Storage, 'getItem' | 'removeItem'>, storageKey: string, record: PendingTransaction) {
  if (!samePending(parsePending(storage.getItem(storageKey)), record)) return false
  storage.removeItem(storageKey)
  return true
}

export async function withPendingLock<T>(name: string, run: () => Promise<T>, locks: Pick<LockManager, 'request'> | undefined = globalThis.navigator?.locks) {
  if (!locks) throw new Error('Web Locks unavailable; transaction blocked')
  return locks.request(name, { ifAvailable: true }, async (lock) => lock ? run() : undefined)
}

function validEventId(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value)) return false
  return BigInt(value) <= (1n << 64n) - 1n
}

export type CreateIntent = { schema: 1; fingerprint: string; eventId: string }

export function createIntent(storage: Pick<Storage, 'getItem' | 'setItem'>, storageKey: string,
  config: ChainConfig, actor: string, input: CreateInput, random = crypto.getRandomValues(new Uint8Array(8))): CreateIntent {
  const fingerprint = JSON.stringify([config.cluster, config.programId.toBase58(), config.mint.toBase58(), actor, input])
  try {
    const old = JSON.parse(storage.getItem(storageKey) ?? 'null') as CreateIntent | null
    if (old?.schema === 1 && old.fingerprint === fingerprint && validEventId(old.eventId)) return old
  } catch { /* Invalid browser storage is replaced only when no signed pending exists. */ }
  const eventId = Array.from(random).reduceRight((number, byte) => number * 256n + BigInt(byte), 0n).toString()
  const intent = { schema: 1 as const, fingerprint, eventId }
  storage.setItem(storageKey, JSON.stringify(intent))
  return intent
}

export function clearCreateIntentIfSame(storage: Pick<Storage, 'getItem' | 'removeItem'>, storageKey: string, eventId: string) {
  try {
    const old = JSON.parse(storage.getItem(storageKey) ?? 'null') as CreateIntent | null
    if (old?.schema !== 1 || old.eventId !== eventId) return false
    storage.removeItem(storageKey)
    return true
  } catch { return false }
}
