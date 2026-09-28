import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEMO_WALLETS, initialDemoState, obligation, payoutAccountFor, transition,
} from '../src/simulation.ts'
import { localToZonedIso, SUPPORTED_TIME_ZONES, utcOffsetAt, zonedInputTime } from '../src/time-zones.ts'

const act = (state, action) => transition(state, action)
const connect = (state, wallet) => {
  if (state.wallet !== wallet) state = act(state, { type: 'SELECT_WALLET', wallet })
  return state.connected ? state : act(state, { type: 'CONNECT' })
}
const freshEvent = (minimum = 2, capacity = 3) => {
  let state = connect(initialDemoState(), DEMO_WALLETS[0])
  state = act(state, { type: 'CREATE', now: '2026-09-24T12:00:00.000Z', input: {
    title: 'A user-authored event', description: 'Keep this text as entered', venue: 'Studio or video link',
    fulfillmentMode: 'online', timeZone: 'America/New_York', price: 17, minWallets: minimum, capacity,
    registrationDeadline: '2026-10-01T12:00:00.000Z', eventStart: '2026-10-02T12:00:00.000Z',
  } })
  assert.equal(state.notice.key, 'created')
  return state
}

test('create saves all core fields in one record and rejects disconnected creation', () => {
  const input = { title: 'Test', description: 'Description', venue: 'Online room', fulfillmentMode: 'online', timeZone: 'America/New_York', price: 17, minWallets: 2, capacity: 3, registrationDeadline: '2026-10-01T12:00:00.000Z', eventStart: '2026-10-02T12:00:00.000Z' }
  const disconnected = act(initialDemoState(), { type: 'CREATE', input, now: '2026-09-24T12:00:00.000Z' })
  assert.equal(disconnected.notice.key, 'walletRequired')
  assert.equal(disconnected.activity.id, 'ACT-2401')
  const state = freshEvent()
  assert.equal(state.activity.title, 'A user-authored event')
  assert.equal(state.activity.description, 'Keep this text as entered')
  assert.equal(state.activity.venue, 'Studio or video link')
  assert.equal(state.activity.fulfillmentMode, 'online')
  assert.equal(state.activity.price, 17)
  assert.equal(state.activity.minWallets, 2)
  assert.equal(state.activity.capacity, 3)
  assert.equal(state.activity.registrationDeadline, input.registrationDeadline)
  assert.equal(state.activity.eventStart, input.eventStart)
  assert.equal(state.activity.timeZone, input.timeZone)
  assert.equal(state.activity.organizer, DEMO_WALLETS[0])
  assert.equal(state.activity.participations.length, 0)
  assert.equal(state.activity.transactions[0].operation, 'CREATE')
})

test('every transaction-like demo action checks identity connection in the model', () => {
  const state = initialDemoState()
  const attempts = [
    { type: 'JOIN' }, { type: 'SETTLE' }, { type: 'FINALIZE' }, { type: 'CANCEL' },
    { type: 'REFUND' }, { type: 'INJECT_SURPLUS' },
    { type: 'UPDATE_PAYOUT', account: payoutAccountFor(DEMO_WALLETS[0], 2) },
  ]
  for (const action of attempts) {
    const rejected = act(state, action)
    assert.equal(rejected.notice.key, 'walletRequired', action.type)
    assert.equal(rejected.activity, state.activity, action.type)
  }
})

test('create input bounds and exact IANA local-time conversion', () => {
  assert.equal(localToZonedIso('2026-10-01T20:00', 'Asia/Shanghai'), '2026-10-01T12:00:00.000Z')
  assert.equal(localToZonedIso('2026-02-30T20:00', 'Asia/Shanghai'), '')
  let state = freshEvent()
  const base = { title: 'Test', description: 'Description', venue: 'Room', fulfillmentMode: 'offline', timeZone: 'Asia/Shanghai', price: 1, minWallets: 2, capacity: 3, registrationDeadline: '2026-10-01T12:00:00.000Z', eventStart: '2026-10-02T12:00:00.000Z' }
  for (const [part, expected] of [
    [{ ...base, title: '陶'.repeat(22) }, 'createLength'],
    [{ ...base, price: 0 }, 'createPrice'],
    [{ ...base, capacity: 101 }, 'createCapacity'],
    [{ ...base, price: Number.MAX_SAFE_INTEGER }, 'createPrice'],
    [{ ...base, price: 4_503_599_628, capacity: 2, minWallets: 2 }, 'createTotalTooLarge'],
    [{ ...base, timeZone: 'Mars/Olympus_Mons' }, 'createTimeZoneInvalid'],
    [{ ...base, timeZone: 'x'.repeat(65) }, 'createTimeZoneInvalid'],
    [{ ...base, registrationDeadline: '2026-09-24T12:29:59.000Z' }, 'createDeadlineRange'],
    [{ ...base, eventStart: '2026-10-01T12:00:00.000Z' }, 'createEventAfterDeadline'],
  ]) {
    state = act(state, { type: 'CREATE', now: '2026-09-24T12:00:00.000Z', input: part })
    assert.equal(state.notice.key, expected)
    assert.equal(state.activity.title, 'A user-authored event')
  }
})

test('supported zones, DST gaps/overlaps, and per-instant UTC offsets', () => {
  assert.equal(SUPPORTED_TIME_ZONES.length, 12)
  assert.equal(localToZonedIso('2026-03-08T02:30', 'America/New_York'), '')
  assert.equal(localToZonedIso('2026-11-01T01:30', 'America/New_York'), '')
  assert.equal(localToZonedIso('2026-03-08T01:30', 'America/New_York'), '2026-03-08T06:30:00.000Z')
  assert.equal(localToZonedIso('2026-03-08T03:30', 'America/New_York'), '2026-03-08T07:30:00.000Z')
  assert.equal(utcOffsetAt('2026-03-08T06:30:00.000Z', 'America/New_York'), 'UTC-05:00')
  assert.equal(utcOffsetAt('2026-03-08T07:30:00.000Z', 'America/New_York'), 'UTC-04:00')
  assert.equal(zonedInputTime(new Date('2026-03-08T07:30:00.000Z'), 'America/New_York'), '2026-03-08T03:30')
})

test('one place per wallet, full/READY boundary, repeat and late join leave funds unchanged', () => {
  let state = freshEvent(2, 2)
  state = connect(state, DEMO_WALLETS[1])
  state = act(state, { type: 'JOIN' })
  assert.equal(state.activity.status, 'OPEN')
  assert.equal(obligation(state.activity), 17)
  const duplicate = act(state, { type: 'JOIN' })
  assert.equal(duplicate.notice.key, 'joinDuplicate')
  assert.equal(duplicate.activity, state.activity)
  state = connect(state, DEMO_WALLETS[2])
  state = act(state, { type: 'JOIN' })
  assert.equal(state.activity.status, 'READY')
  assert.equal(obligation(state.activity), 34)
  const full = act(connect(state, DEMO_WALLETS[3]), { type: 'JOIN' })
  assert.equal(full.notice.key, 'joinClosed')
  assert.equal(full.activity, state.activity)
  const cancelled = act(connect(state, DEMO_WALLETS[0]), { type: 'CANCEL' })
  assert.equal(cancelled.notice.key, 'readyCannotCancel')
  assert.equal(cancelled.activity, state.activity)
})

test('deadline failure and two separate refunds end at REFUNDED without duplicate payment', () => {
  let state = freshEvent(3, 4)
  for (const wallet of DEMO_WALLETS.slice(1, 3)) state = act(connect(state, wallet), { type: 'JOIN' })
  state = act(state, { type: 'ADVANCE_DEADLINE' })
  assert.equal(act(connect(state, DEMO_WALLETS[3]), { type: 'JOIN' }).notice.key, 'joinClosed')
  assert.equal(act(connect(state, DEMO_WALLETS[0]), { type: 'CANCEL' }).notice.key, 'cancelDeadline')
  state = act(state, { type: 'FINALIZE' })
  assert.equal(state.activity.status, 'REFUNDING_FAILED')
  assert.equal(state.activity.vaultBalance, 34)
  for (const [index, wallet] of DEMO_WALLETS.slice(1, 3).entries()) {
    state = act(connect(state, wallet), { type: 'REFUND' })
    assert.equal(state.activity.participations[index].refundedAt, state.activity.registrationDeadline)
    assert.equal(state.activity.vaultBalance, 17 * (1 - index))
  }
  assert.equal(state.activity.status, 'REFUNDED')
  assert.equal(obligation(state.activity), 0)
  const repeated = act(state, { type: 'REFUND' })
  assert.equal(repeated.notice.key, 'refundState')
  assert.equal(repeated.activity, state.activity)
  assert.equal(state.activity.transactions.filter((item) => item.operation === 'REFUND').length, 2)
})

test('organizer-only cancel creates claim state; a nonparticipant cannot take a refund', () => {
  let state = freshEvent()
  state = act(connect(state, DEMO_WALLETS[1]), { type: 'JOIN' })
  const wrongActor = act(state, { type: 'CANCEL' })
  assert.equal(wrongActor.notice.key, 'organizerOnly')
  assert.equal(wrongActor.activity, state.activity)
  state = act(connect(state, DEMO_WALLETS[0]), { type: 'CANCEL' })
  assert.equal(state.activity.status, 'REFUNDING_CANCELLED')
  const notParticipant = act(state, { type: 'REFUND' })
  assert.equal(notParticipant.notice.key, 'refundNotParticipant')
  assert.equal(notParticipant.activity, state.activity)
  state = act(connect(state, DEMO_WALLETS[1]), { type: 'REFUND' })
  assert.equal(state.activity.status, 'REFUNDED')
  assert.equal(state.activity.vaultBalance, 0)
})

test('empty event closes without refund record or payout', () => {
  let state = freshEvent()
  state = act(state, { type: 'ADVANCE_DEADLINE' })
  state = act(state, { type: 'FINALIZE' })
  assert.equal(state.activity.status, 'CLOSED_EMPTY')
  assert.equal(state.activity.closureReason, 'deadline_empty')
  assert.equal(state.activity.transactions.at(-1).operation, 'FINALIZE_EMPTY')
  assert.equal(state.activity.vaultBalance, 0)
})

test('organizer can cancel an empty event with a zero-balance vault', () => {
  const state = act(freshEvent(), { type: 'CANCEL' })
  assert.equal(state.activity.status, 'CLOSED_EMPTY')
  assert.equal(state.activity.closureReason, 'organizer_cancelled_empty')
  assert.equal(state.activity.vaultBalance, 0)
  assert.equal(state.activity.transactions.at(-1).operation, 'CANCEL')
})

for (const { name, action, joined, expired } of [
  { name: 'cancel with a participant', action: 'CANCEL', joined: true, expired: false },
  { name: 'cancel empty', action: 'CANCEL', joined: false, expired: false },
  { name: 'finalize failed', action: 'FINALIZE', joined: true, expired: true },
  { name: 'finalize empty', action: 'FINALIZE', joined: false, expired: true },
]) {
  test(`${name} rejects a vault shortfall without changing funds or records`, () => {
    let state = freshEvent()
    if (joined) state = act(connect(state, DEMO_WALLETS[1]), { type: 'JOIN' })
    if (expired) state = act(state, { type: 'ADVANCE_DEADLINE' })
    if (action === 'CANCEL') state = connect(state, DEMO_WALLETS[0])
    // Empty events owe 0; -1 is malformed mock data, not a possible SPL token balance.
    state = { ...state, activity: { ...state.activity, vaultBalance: obligation(state.activity) - 1 } }
    const before = structuredClone(state.activity)
    const rejected = act(state, { type: action })
    assert.equal(rejected.notice.key, 'vaultDeficit')
    assert.equal(rejected.activity.status, before.status)
    assert.equal(rejected.activity.vaultBalance, before.vaultBalance)
    assert.deepEqual(rejected.activity.participations, before.participations)
    assert.deepEqual(rejected.activity.transactions, before.transactions)
  })
}

test('unavailable payout blocks settlement, original organizer alone recovers in OPEN after deadline', () => {
  let state = freshEvent(2, 3)
  for (const wallet of DEMO_WALLETS.slice(1, 3)) state = act(connect(state, wallet), { type: 'JOIN' })
  state = act(state, { type: 'ADVANCE_DEADLINE' })
  state = act(state, { type: 'CLOSE_PAYOUT' })
  const blocked = act(state, { type: 'FINALIZE' })
  assert.equal(blocked.notice.key, 'payoutUnavailableSettle')
  assert.equal(blocked.activity, state.activity)
  assert.equal(obligation(blocked.activity), 34)
  const backup = payoutAccountFor(DEMO_WALLETS[0], 2)
  assert.equal(act(state, { type: 'UPDATE_PAYOUT', account: backup }).notice.key, 'organizerOnly')
  state = act(connect(state, DEMO_WALLETS[0]), { type: 'UPDATE_PAYOUT', account: backup })
  assert.equal(state.activity.organizerTokenAccount, backup)
  assert.equal(state.activity.organizer, DEMO_WALLETS[0])
  state = act(connect(state, DEMO_WALLETS[3]), { type: 'FINALIZE' })
  assert.equal(state.activity.status, 'PAID')
  assert.equal(state.activity.vaultBalance, 0)
  assert.equal(act(connect(state, DEMO_WALLETS[0]), { type: 'UPDATE_PAYOUT', account: payoutAccountFor(DEMO_WALLETS[0], 3) }).notice.key, 'payoutUpdateState')
})

test('unexpected surplus remains after a normal join and payout', () => {
  let state = freshEvent(2, 2)
  state = act(state, { type: 'INJECT_SURPLUS' })
  assert.equal(state.activity.vaultBalance, 7)
  for (const wallet of DEMO_WALLETS.slice(1, 3)) state = act(connect(state, wallet), { type: 'JOIN' })
  assert.equal(state.activity.vaultBalance - obligation(state.activity), 7)
  state = act(state, { type: 'SETTLE' })
  assert.equal(state.activity.status, 'PAID')
  assert.equal(state.activity.vaultBalance, 7)
  assert.equal(state.activity.transactions.at(-1).id.includes('-SETTLE-'), true)
  const duplicate = act(state, { type: 'SETTLE' })
  assert.equal(duplicate.notice.key, 'settleNotEligible')
  assert.equal(duplicate.activity, state.activity)
})
