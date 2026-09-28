import { DEFAULT_TIME_ZONE, isSupportedTimeZone } from './time-zones.ts'

export type Status = 'OPEN' | 'READY' | 'PAID' | 'REFUNDING_FAILED' | 'REFUNDING_CANCELLED' | 'REFUNDED' | 'CLOSED_EMPTY'
export type Operation = 'CREATE' | 'JOIN' | 'SETTLE' | 'MARK_FAILED' | 'FINALIZE_EMPTY' | 'CANCEL' | 'REFUND' | 'UPDATE_PAYOUT' | 'UNEXPECTED_TRANSFER' | 'CLOSE_PAYOUT'
export type Tone = 'success' | 'info' | 'error'
export type Notice = { tone: Tone; key: string; values?: Record<string, string | number> }

export interface Transaction {
  id: string
  activityId: string
  operation: Operation
  actor: string
  amount: number
  createdAt: string
}

export interface Participation {
  wallet: string
  paidAmount: number
  joinedAt: string
  refundedAt?: string
  refunded?: boolean // The contract records a flag, not a refund timestamp.
}

export interface Activity {
  id: string
  title: string
  description: string
  price: number
  minWallets: number
  capacity: number
  registrationDeadline: string
  eventStart: string
  fulfillmentMode: 'offline' | 'online'
  venue: string
  timeZone: string
  organizer: string
  organizerTokenAccount: string
  unavailablePayoutAccounts: string[]
  mint: string
  tokenProgram: string
  status: Status
  simulatedNow: string
  vaultBalance: number
  participations: Participation[]
  closureReason?: 'deadline_empty' | 'organizer_cancelled_empty'
  transactions: Transaction[]
}

export interface CreateInput {
  title: string
  description: string
  price: number
  minWallets: number
  capacity: number
  registrationDeadline: string
  eventStart: string
  fulfillmentMode: 'offline' | 'online'
  venue: string
  timeZone: string
}

export interface DemoState {
  activity: Activity
  wallet: string
  connected: boolean
  wallets: string[]
  notice: Notice
}

export type Action =
  | { type: 'CONNECT' }
  | { type: 'SELECT_WALLET'; wallet: string }
  | { type: 'ADD_WALLET' }
  | { type: 'CREATE'; input: CreateInput; now: string }
  | { type: 'JOIN' | 'SETTLE' | 'FINALIZE' | 'CANCEL' | 'REFUND' | 'INJECT_SURPLUS' }
  | { type: 'UPDATE_PAYOUT'; account: string }
  | { type: 'ADVANCE_DEADLINE' | 'CLOSE_PAYOUT' | 'RESET' }

export const FIXED_TEST_MINT = '9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj'
export const CLASSIC_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_SCALE = 1_000_000n
export const MAX_SAFE_TOKEN_BASE_UNITS = BigInt(Number.MAX_SAFE_INTEGER)
export const ORIGINAL_ORGANIZER = 'DemoOrg…8kLm'
export const DEMO_WALLETS = [ORIGINAL_ORGANIZER, 'DemoP01…11x', 'DemoP02…22y', 'DemoP03…33z', 'DemoP04…44a', 'DemoP05…55b', 'DemoP06…66c']

export function payoutAccountFor(organizer: string, number: number) {
  return `SIM-ATA-${organizer}-${String(number).padStart(2, '0')}`
}

const sampleWallets = DEMO_WALLETS.slice(1, 5)
const sampleJoinedAt = ['2026-09-23T02:05:00.000Z', '2026-09-23T02:08:00.000Z', '2026-09-23T02:11:00.000Z', '2026-09-23T02:14:00.000Z']

export function initialActivity(): Activity {
  const id = 'ACT-2401'
  return {
    id,
    title: 'A Slow Clay Afternoon',
    description: 'An unhurried afternoon at the pottery wheel. Shape a small vessel, meet new people, and leave the week behind.',
    price: 25,
    minWallets: 4,
    capacity: 6,
    registrationDeadline: '2026-10-15T12:00:00.000Z',
    eventStart: '2026-10-18T06:00:00.000Z',
    fulfillmentMode: 'offline',
    venue: 'Example Studio, Jing’an District, Shanghai',
    timeZone: DEFAULT_TIME_ZONE,
    organizer: ORIGINAL_ORGANIZER,
    organizerTokenAccount: payoutAccountFor(ORIGINAL_ORGANIZER, 1),
    unavailablePayoutAccounts: [],
    mint: FIXED_TEST_MINT,
    tokenProgram: CLASSIC_TOKEN_PROGRAM,
    status: 'OPEN',
    simulatedNow: '2026-09-24T04:00:00.000Z',
    vaultBalance: 100,
    participations: sampleWallets.map((wallet, index) => ({ wallet, paidAmount: 25, joinedAt: sampleJoinedAt[index] })),
    transactions: [
      { id: `SIM-${id}-CREATE-001`, activityId: id, operation: 'CREATE', actor: ORIGINAL_ORGANIZER, amount: 0, createdAt: '2026-09-23T02:00:00.000Z' },
      ...sampleWallets.map((wallet, index): Transaction => ({ id: `SIM-${id}-JOIN-${String(index + 1).padStart(3, '0')}`, activityId: id, operation: 'JOIN', actor: wallet, amount: 25, createdAt: sampleJoinedAt[index] })),
    ],
  }
}

export function initialDemoState(): DemoState {
  return { activity: initialActivity(), wallet: DEMO_WALLETS[5], connected: false, wallets: [...DEMO_WALLETS], notice: { tone: 'info', key: 'intro' } }
}

export function obligation(activity: Activity) {
  if (activity.status === 'PAID' || activity.status === 'CLOSED_EMPTY') return 0
  return activity.participations.reduce((sum, participant) => sum + (participant.refundedAt || participant.refunded ? 0 : participant.paidAmount), 0)
}

export function refundPending(activity: Activity) {
  return activity.participations.filter((participant) => !participant.refundedAt && !participant.refunded).length
}

export function isAfterDeadline(activity: Activity) {
  return Date.parse(activity.simulatedNow) >= Date.parse(activity.registrationDeadline)
}

function tx(activity: Activity, operation: Operation, actor: string, amount = 0): Transaction {
  const sequence = activity.transactions.filter((item) => item.operation === operation).length + 1
  return { id: `SIM-${activity.id}-${operation}-${String(sequence).padStart(3, '0')}`, activityId: activity.id, operation, actor, amount, createdAt: activity.simulatedNow }
}

function update(state: DemoState, activity: Activity, key: string, tone: Tone = 'success', values?: Notice['values']): DemoState {
  return { ...state, activity, notice: { tone, key, values } }
}

function reject(state: DemoState, key: string, values?: Notice['values']): DemoState {
  return { ...state, notice: { tone: 'error', key, values } }
}

function needsWallet(state: DemoState, action: string) {
  return state.connected ? null : reject(state, 'walletRequired', { action })
}

export function validateCreate(input: CreateInput, now: number): string | null {
  const length = (value: string) => new TextEncoder().encode(value).length
  if (!input.title.trim() || !input.description.trim() || !input.venue.trim()) return 'createRequired'
  if (length(input.title) > 64 || length(input.description) > 280 || length(input.venue) > 160) return 'createLength'
  if (length(input.timeZone) > 64 || !isSupportedTimeZone(input.timeZone)) return 'createTimeZoneInvalid'
  if (!Number.isSafeInteger(input.price) || input.price <= 0) return 'createPrice'
  if (!Number.isInteger(input.minWallets) || !Number.isInteger(input.capacity) || input.minWallets < 2 || input.capacity < input.minWallets || input.capacity > 100) return 'createCapacity'
  const unitPrice = BigInt(input.price) * TOKEN_SCALE
  if (unitPrice > MAX_SAFE_TOKEN_BASE_UNITS) return 'createPrice'
  if (unitPrice * BigInt(input.capacity) > MAX_SAFE_TOKEN_BASE_UNITS) return 'createTotalTooLarge'
  const deadline = Date.parse(input.registrationDeadline)
  const start = Date.parse(input.eventStart)
  const explicitUtc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
  if (!explicitUtc.test(input.registrationDeadline) || !explicitUtc.test(input.eventStart) ||
    Number.isNaN(now) || Number.isNaN(deadline) || Number.isNaN(start)) return 'createTimeInvalid'
  if (deadline < now + 30 * 60 * 1000 || deadline > now + 90 * 24 * 60 * 60 * 1000) return 'createDeadlineRange'
  if (start <= deadline) return 'createEventAfterDeadline'
  if (input.fulfillmentMode !== 'offline' && input.fulfillmentMode !== 'online') return 'createMode'
  return null
}

// ponytail: one pure transition function serializes mock actions; it is not an on-chain validator.
export function transition(state: DemoState, action: Action): DemoState {
  const activity = state.activity
  const count = activity.participations.length
  const due = obligation(activity)
  const afterDeadline = isAfterDeadline(activity)
  const wallet = state.wallet

  if (action.type === 'RESET') return initialDemoState()
  if (action.type === 'CONNECT') return { ...state, connected: !state.connected, notice: { tone: 'info', key: state.connected ? 'walletDisconnected' : 'walletConnected', values: { wallet } } }
  if (action.type === 'SELECT_WALLET') {
    if (!state.wallets.includes(action.wallet)) return reject(state, 'unknownWallet')
    return { ...state, wallet: action.wallet, connected: false, notice: { tone: 'info', key: 'walletSelected', values: { wallet: action.wallet } } }
  }
  if (action.type === 'ADD_WALLET') {
    const next = `DemoP${String(state.wallets.length).padStart(2, '0')}…sim`
    return { ...state, wallets: [...state.wallets, next], wallet: next, connected: false, notice: { tone: 'info', key: 'walletAdded', values: { wallet: next } } }
  }
  if (action.type === 'ADVANCE_DEADLINE') return update(state, { ...activity, simulatedNow: activity.registrationDeadline }, 'clockAdvanced', 'info')
  if (action.type === 'CLOSE_PAYOUT') {
    return update(state, { ...activity, unavailablePayoutAccounts: [...new Set([...activity.unavailablePayoutAccounts, activity.organizerTokenAccount])] }, 'payoutUnavailable', 'info')
  }

  const walletError = needsWallet(state, action.type)
  if (walletError) return walletError

  if (action.type === 'CREATE') {
    const now = Date.parse(action.now)
    const error = validateCreate(action.input, now)
    if (error) return reject(state, error)
    const id = `ACT-${String(now).slice(-6)}`
    const input = action.input
    const next: Activity = {
      ...activity,
      id,
      title: input.title.trim(),
      description: input.description.trim(),
      price: input.price,
      minWallets: input.minWallets,
      capacity: input.capacity,
      registrationDeadline: input.registrationDeadline,
      eventStart: input.eventStart,
      fulfillmentMode: input.fulfillmentMode,
      venue: input.venue.trim(),
      timeZone: input.timeZone,
      organizer: wallet,
      organizerTokenAccount: payoutAccountFor(wallet, 1),
      unavailablePayoutAccounts: [],
      mint: FIXED_TEST_MINT,
      tokenProgram: CLASSIC_TOKEN_PROGRAM,
      status: 'OPEN',
      simulatedNow: action.now,
      vaultBalance: 0,
      participations: [],
      closureReason: undefined,
      transactions: [],
    }
    next.transactions = [tx(next, 'CREATE', wallet)]
    return update(state, next, 'created', 'success', { id })
  }

  if (action.type === 'JOIN') {
    if (activity.participations.some((item) => item.wallet === wallet)) return reject(state, 'joinDuplicate')
    if (activity.status !== 'OPEN' || afterDeadline || count >= activity.capacity) return reject(state, 'joinClosed')
    if (activity.vaultBalance < due) return reject(state, 'vaultDeficit')
    const nextCount = count + 1
    return update(state, {
      ...activity,
      vaultBalance: activity.vaultBalance + activity.price,
      participations: [...activity.participations, { wallet, paidAmount: activity.price, joinedAt: activity.simulatedNow }],
      status: nextCount === activity.capacity ? 'READY' : 'OPEN',
      transactions: [...activity.transactions, tx(activity, 'JOIN', wallet, activity.price)],
    }, 'joined', 'success', { amount: activity.price })
  }

  if (action.type === 'CANCEL') {
    if (wallet !== activity.organizer) return reject(state, 'organizerOnly')
    if (activity.status === 'READY') return reject(state, 'readyCannotCancel')
    if (activity.status !== 'OPEN') return reject(state, 'cancelState')
    if (afterDeadline) return reject(state, 'cancelDeadline')
    if (activity.vaultBalance < due) return reject(state, 'vaultDeficit')
    const empty = count === 0
    return update(state, {
      ...activity,
      status: empty ? 'CLOSED_EMPTY' : 'REFUNDING_CANCELLED',
      closureReason: empty ? 'organizer_cancelled_empty' : undefined,
      transactions: [...activity.transactions, tx(activity, 'CANCEL', wallet)],
    }, empty ? 'cancelledEmpty' : 'cancelled', 'info', { count })
  }

  if (action.type === 'UPDATE_PAYOUT') {
    if (wallet !== activity.organizer) return reject(state, 'organizerOnly')
    if (activity.status !== 'OPEN' && activity.status !== 'READY') return reject(state, 'payoutUpdateState')
    const valid = [1, 2, 3].map((number) => payoutAccountFor(activity.organizer, number))
    if (!valid.includes(action.account) || activity.unavailablePayoutAccounts.includes(action.account)) return reject(state, 'payoutAccountInvalid')
    if (action.account === activity.organizerTokenAccount) return reject(state, 'payoutAccountSame')
    return update(state, {
      ...activity,
      organizerTokenAccount: action.account,
      transactions: [...activity.transactions, tx(activity, 'UPDATE_PAYOUT', wallet)],
    }, 'payoutUpdated')
  }

  if (action.type === 'SETTLE' || action.type === 'FINALIZE') {
    const eligible = activity.status === 'READY' || (activity.status === 'OPEN' && afterDeadline && count >= activity.minWallets)
    if (eligible) {
      if (activity.unavailablePayoutAccounts.includes(activity.organizerTokenAccount)) return reject(state, 'payoutUnavailableSettle')
      if (activity.vaultBalance < due) return reject(state, 'vaultDeficit')
      return update(state, {
        ...activity,
        status: 'PAID',
        vaultBalance: activity.vaultBalance - due,
        transactions: [...activity.transactions, tx(activity, 'SETTLE', wallet, due)],
      }, 'settled', 'success', { amount: due })
    }
    if (action.type === 'SETTLE') return reject(state, 'settleNotEligible')
    if (!afterDeadline) return reject(state, 'finalizeTooEarly')
    if (activity.status !== 'OPEN') return reject(state, 'finalizeState')
    if (activity.vaultBalance < due) return reject(state, 'vaultDeficit')
    if (count === 0) return update(state, {
      ...activity,
      status: 'CLOSED_EMPTY', closureReason: 'deadline_empty',
      transactions: [...activity.transactions, tx(activity, 'FINALIZE_EMPTY', wallet)],
    }, 'closedEmpty', 'info')
    return update(state, {
      ...activity,
      status: 'REFUNDING_FAILED',
      transactions: [...activity.transactions, tx(activity, 'MARK_FAILED', wallet)],
    }, 'minimumMissed', 'info', { min: activity.minWallets, count })
  }

  if (action.type === 'REFUND') {
    if (activity.status !== 'REFUNDING_FAILED' && activity.status !== 'REFUNDING_CANCELLED') return reject(state, 'refundState')
    const participation = activity.participations.find((item) => item.wallet === wallet)
    if (!participation) return reject(state, 'refundNotParticipant')
    if (participation.refundedAt) return reject(state, 'refundDuplicate')
    if (activity.vaultBalance < due) return reject(state, 'vaultDeficit')
    const participations = activity.participations.map((item) => item.wallet === wallet ? { ...item, refundedAt: activity.simulatedNow } : item)
    const allRefunded = participations.every((item) => item.refundedAt)
    return update(state, {
      ...activity,
      participations,
      status: allRefunded ? 'REFUNDED' : activity.status,
      vaultBalance: activity.vaultBalance - participation.paidAmount,
      transactions: [...activity.transactions, tx(activity, 'REFUND', wallet, participation.paidAmount)],
    }, 'refunded', 'success', { amount: participation.paidAmount, remaining: participations.filter((item) => !item.refundedAt).length })
  }

  if (action.type === 'INJECT_SURPLUS') {
    return update(state, {
      ...activity,
      vaultBalance: activity.vaultBalance + 7,
      transactions: [...activity.transactions, tx(activity, 'UNEXPECTED_TRANSFER', wallet, 7)],
    }, 'surplusInjected', 'info')
  }

  return state
}
