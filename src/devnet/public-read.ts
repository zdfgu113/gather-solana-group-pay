import type { Activity } from '../simulation.ts'
import {
  CLASSIC_TOKEN_PROGRAM, DEVNET_MINT, devnetPublicEvent, type DevnetPublicEvent,
} from './public-events.ts'

const ENDPOINT = '/.netlify/functions/read-event'
const MAX_RESPONSE_BYTES = 64_000

async function limitedText(response: Response) {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    throw new Error('PUBLIC_READ_INVALID_RESPONSE')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('PUBLIC_READ_INVALID_RESPONSE')
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

function validTime(value: unknown) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function validAmount(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value * 1_000_000) && value >= 0
}

export function validatePublicActivity(value: unknown, target: DevnetPublicEvent): Activity {
  const activity = value as Partial<Activity> | null
  const participations = activity?.participations
  const unavailable = activity?.unavailablePayoutAccounts
  if (!activity || activity.id !== target.event || activity.status !== target.status ||
    activity.mint !== DEVNET_MINT || activity.tokenProgram !== CLASSIC_TOKEN_PROGRAM ||
    activity.organizerTokenAccount !== target.payout || typeof activity.organizer !== 'string' ||
    typeof activity.title !== 'string' || typeof activity.description !== 'string' ||
    typeof activity.venue !== 'string' || typeof activity.timeZone !== 'string' ||
    !validTime(activity.registrationDeadline) || !validTime(activity.eventStart) || !validTime(activity.simulatedNow) ||
    !validAmount(activity.price) || !validAmount(activity.vaultBalance) ||
    !Number.isInteger(activity.minWallets) || !Number.isInteger(activity.capacity) ||
    Number(activity.minWallets) < 2 || Number(activity.capacity) < Number(activity.minWallets) || Number(activity.capacity) > 100 ||
    (activity.fulfillmentMode !== 'online' && activity.fulfillmentMode !== 'offline') ||
    !Array.isArray(participations) || participations.length > Number(activity.capacity) ||
    !Array.isArray(unavailable) || unavailable.some((address) => address !== target.payout) ||
    !Array.isArray(activity.transactions) || activity.transactions.length !== 0) {
    throw new Error('PUBLIC_READ_INVALID_RESPONSE')
  }
  const wallets = new Set<string>()
  for (const item of participations) {
    if (!item || typeof item.wallet !== 'string' || wallets.has(item.wallet) || !validAmount(item.paidAmount) ||
      !validTime(item.joinedAt) || typeof item.refunded !== 'boolean' ||
      (item.refundedAt !== undefined && !validTime(item.refundedAt))) throw new Error('PUBLIC_READ_INVALID_RESPONSE')
    wallets.add(item.wallet)
  }
  if (target.status === 'REFUNDED' && participations.some((item) => !item.refunded)) {
    throw new Error('PUBLIC_READ_INVALID_RESPONSE')
  }
  return activity as Activity
}

export async function readPublicEvent(address: string, signal: AbortSignal) {
  const target = devnetPublicEvent(address)
  if (!target) throw new Error('PUBLIC_READ_UNSUPPORTED')
  const response = await fetch(`${ENDPOINT}?event=${encodeURIComponent(target.event)}`, {
    method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store', signal,
  })
  const text = await limitedText(response)
  let body: { schema?: unknown; ok?: unknown; activity?: unknown; error?: unknown }
  try { body = JSON.parse(text) } catch { throw new Error('PUBLIC_READ_INVALID_RESPONSE') }
  if (response.status === 404 && body.error === 'unsupported_event') throw new Error('PUBLIC_READ_UNSUPPORTED')
  if (response.status === 504 || body.error === 'timeout') throw new Error('Public read timed out')
  if (!response.ok || body.schema !== 1 || body.ok !== true) throw new Error('PUBLIC_READ_UNAVAILABLE')
  return validatePublicActivity(body.activity, target)
}
