import { Buffer } from 'buffer'
import BN from 'bn.js'
import bs58 from 'bs58'
import { Program } from '@anchor-lang/core'
import { ACCOUNT_SIZE, AccountLayout, AccountState, getAccount, getMint, TOKEN_PROGRAM_ID, createCloseAccountInstruction } from '@solana/spl-token'
import { Connection, PublicKey, SendTransactionError, SystemProgram, Transaction, type SignatureStatus, type TransactionInstruction } from '@solana/web3.js'
import localIdl from '../idl/group_pay.json' with { type: 'json' }
import devnetIdl from '../idl/group_pay.devnet.json' with { type: 'json' }
import type { GroupPay } from '../idl/group_pay.ts'
import { isSupportedTimeZone } from '../time-zones.ts'
import {
  MAX_SAFE_TOKEN_BASE_UNITS, TOKEN_SCALE,
  type Action, type Activity, type CreateInput, type Operation, type Participation, type Status,
} from '../simulation.ts'
import { tokenAccountFor, type ChainConfig } from './config.ts'

const STATUS: Record<string, Status> = {
  open: 'OPEN', ready: 'READY', paid: 'PAID', refundingFailed: 'REFUNDING_FAILED',
  refundingCancelled: 'REFUNDING_CANCELLED', refunded: 'REFUNDED', closedEmpty: 'CLOSED_EMPTY',
}

export function rpcFailureKind(error: unknown, aborted = false) {
  const message = String(error)
  if (aborted || /timed?\s*out|timeout|AbortError|aborted/i.test(message)) return 'timeout' as const
  if (/\b(?:403|429|500|502|503|504)\b|too many requests|forbidden|http (?:error|status)/i.test(message)) return 'http' as const
  if (/fetch failed|failed to fetch|ECONNREFUSED|network|internal server error|connection refused/i.test(message)) return 'network' as const
  return null
}

export function readErrorNotice(error: unknown, aborted = false) {
  const message = String(error)
  if (/EVENT_ADDRESS_INVALID/.test(message)) return 'localBadAddress'
  if (/EVENT_ACCOUNT_NOT_FOUND/.test(message)) return 'localEventMissing'
  if (/EVENT_ACCOUNT_INVALID/.test(message)) return 'localEventInvalid'
  const rpc = rpcFailureKind(error, aborted)
  if (rpc === 'timeout') return 'localRpcTimeout'
  if (rpc === 'http') return 'localRpcHttp'
  if (rpc === 'network') return 'localRpcOffline'
  return 'localReadFailed'
}

export const program = (connection: Connection, config: ChainConfig) => {
  const idl = config.cluster === 'devnet' ? devnetIdl : localIdl
  if (idl.address !== config.programId.toBase58()) throw new Error('Program ID does not match the selected IDL')
  return new Program<GroupPay>(idl as GroupPay, { connection })
}

function variant(value: object) { return Object.keys(value)[0] }
function decodeEventData<T>(label: string, decode: () => T) {
  try { return decode() }
  catch { throw new Error(`EVENT_ACCOUNT_INVALID: cannot decode ${label}`) }
}
export function safeAmount(raw: bigint) {
  if (raw > MAX_SAFE_TOKEN_BASE_UNITS) throw new Error('EVENT_ACCOUNT_INVALID: token amount exceeds the supported UI range')
  return Number(raw) / Number(TOKEN_SCALE)
}
function bnAmount(value: BN) { return BigInt(value.toString()) }

export function eventAddress(config: ChainConfig, organizer: PublicKey, eventId: BN) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('event'), organizer.toBuffer(), eventId.toArrayLike(Buffer, 'le', 8)], config.programId,
  )[0]
}
export function vaultAddress(config: ChainConfig, event: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('vault'), event.toBuffer()], config.programId)[0]
}
export function participationAddress(config: ChainConfig, event: PublicKey, participant: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('participation'), event.toBuffer(), participant.toBuffer()], config.programId)[0]
}

export async function ensureTestMint(connection: Connection, config: ChainConfig) {
  const mint = await getMint(connection, config.mint, 'confirmed', TOKEN_PROGRAM_ID)
  if (mint.decimals !== 6 || !mint.mintAuthority?.equals(config.mintAuthority) || mint.freezeAuthority) {
    throw new Error('The fixed TEST mint is missing, has the wrong authority, or can be frozen')
  }
}

export async function readEvent(connection: Connection, config: ChainConfig, address: PublicKey): Promise<Activity> {
  const info = await connection.getAccountInfo(address, 'confirmed')
  if (!info) throw new Error('EVENT_ACCOUNT_NOT_FOUND')
  if (!info.owner.equals(config.programId)) throw new Error('EVENT_ACCOUNT_INVALID: wrong program owner')
  const coder = program(connection, config).coder.accounts
  const event = decodeEventData('Event', () => coder.decode('event', Buffer.from(info.data)))
  if (!isSupportedTimeZone(event.timeZone)) throw new Error('EVENT_ACCOUNT_INVALID: unsupported time zone')
  if (!event.mint.equals(config.mint) || !event.vault.equals(vaultAddress(config, address))) throw new Error('EVENT_ACCOUNT_INVALID: unexpected mint or vault')
  const status = STATUS[variant(event.status)]
  if (!status) throw new Error('EVENT_ACCOUNT_INVALID: unknown status')

  const [vault, participationInfos, payoutInfo, slot] = await Promise.all([
    getAccount(connection, event.vault, 'confirmed', TOKEN_PROGRAM_ID),
    connection.getProgramAccounts(config.programId, {
      commitment: 'confirmed', filters: [{ dataSize: 90 }, { memcmp: { offset: 8, bytes: address.toBase58() } }],
    }),
    connection.getAccountInfo(event.organizerTokenAccount, 'confirmed'),
    connection.getSlot('confirmed'),
  ])
  if (!vault.mint.equals(config.mint) || !vault.owner.equals(address)) throw new Error('EVENT_ACCOUNT_INVALID: vault mint or authority mismatch')

  let legalFromRecords = 0n
  const participations: Participation[] = participationInfos.map(({ account }) => {
    const item = decodeEventData('Participation', () => coder.decode('participation', Buffer.from(account.data)))
    if (!item.event.equals(address)) throw new Error('EVENT_ACCOUNT_INVALID: participation belongs to another Event')
    if (!item.refunded) legalFromRecords += bnAmount(item.paidAmount)
    return {
      wallet: item.participant.toBase58(),
      paidAmount: safeAmount(bnAmount(item.paidAmount)),
      joinedAt: new Date(Number(item.joinedAt.toString()) * 1000).toISOString(),
      refunded: item.refunded,
    }
  })
  participations.sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))
  if (participations.length !== event.participantCount) throw new Error('EVENT_ACCOUNT_INVALID: participation count mismatch')
  if (bnAmount(event.expectedEscrow) !== (status === 'PAID' || status === 'CLOSED_EMPTY' ? 0n : legalFromRecords)) {
    throw new Error('EVENT_ACCOUNT_INVALID: escrow mismatch')
  }
  const payoutValid = payoutInfo?.owner.equals(TOKEN_PROGRAM_ID) && payoutInfo.data.length === ACCOUNT_SIZE && (() => {
    const decoded = AccountLayout.decode(payoutInfo.data)
    return new PublicKey(decoded.mint).equals(config.mint) && new PublicKey(decoded.owner).equals(event.organizer)
  })()
  const blockTime = await connection.getBlockTime(slot)
  const unitPrice = bnAmount(event.unitPrice)
  safeAmount(unitPrice * BigInt(event.capacity))
  return {
    id: address.toBase58(), title: event.title, description: event.description,
    price: safeAmount(unitPrice), minWallets: event.minWallets, capacity: event.capacity,
    registrationDeadline: new Date(Number(event.registrationDeadline.toString()) * 1000).toISOString(),
    eventStart: new Date(Number(event.eventStart.toString()) * 1000).toISOString(),
    fulfillmentMode: variant(event.fulfillmentMode) === 'online' ? 'online' : 'offline',
    venue: event.venue, timeZone: event.timeZone, organizer: event.organizer.toBase58(),
    organizerTokenAccount: event.organizerTokenAccount.toBase58(),
    unavailablePayoutAccounts: payoutValid ? [] : [event.organizerTokenAccount.toBase58()],
    mint: config.mint.toBase58(), tokenProgram: TOKEN_PROGRAM_ID.toBase58(), status,
    simulatedNow: new Date((blockTime ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    vaultBalance: safeAmount(vault.amount), participations, transactions: [],
    closureReason: status === 'CLOSED_EMPTY'
      ? variant(event.emptyCloseReason) === 'cancelled' ? 'organizer_cancelled_empty' : 'deadline_empty'
      : undefined,
  }
}

export type LocalOperation = Operation | 'CLOSE_PAYOUT'
export type Prepared = { instruction: TransactionInstruction; event: PublicKey; operation: LocalOperation; participant?: PublicKey; newPayout?: string; eventId?: string }

export function actionPrecondition(activity: Activity, action: Action, actor: string) {
  const afterDeadline = Date.parse(activity.simulatedNow) >= Date.parse(activity.registrationDeadline)
  const participation = activity.participations.find((item) => item.wallet === actor)
  if (action.type === 'JOIN') {
    if (participation) return 'joinDuplicate'
    if (activity.status !== 'OPEN' || afterDeadline || activity.participations.length >= activity.capacity) return 'joinClosed'
  }
  if (action.type === 'CANCEL') {
    if (actor !== activity.organizer) return 'organizerOnly'
    if (activity.status === 'READY') return 'readyCannotCancel'
    if (activity.status !== 'OPEN') return 'cancelState'
    if (afterDeadline) return 'cancelDeadline'
  }
  if (action.type === 'UPDATE_PAYOUT') {
    if (actor !== activity.organizer) return 'organizerOnly'
    if (activity.status !== 'OPEN' && activity.status !== 'READY') return 'payoutUpdateState'
    if (action.account === activity.organizerTokenAccount) return 'payoutAccountSame'
  }
  if (action.type === 'SETTLE') {
    if (activity.status !== 'READY' && !(activity.status === 'OPEN' && afterDeadline && activity.participations.length >= activity.minWallets)) return 'settleNotEligible'
  }
  if (action.type === 'FINALIZE') {
    if (activity.status === 'READY') return null
    if (activity.status !== 'OPEN') return 'finalizeState'
    if (!afterDeadline) return 'finalizeTooEarly'
  }
  if (action.type === 'REFUND') {
    if (activity.status !== 'REFUNDING_FAILED' && activity.status !== 'REFUNDING_CANCELLED') return 'refundState'
    if (!participation) return 'refundNotParticipant'
    if (participation.refundedAt || participation.refunded) return 'refundDuplicate'
  }
  return null
}

export async function validatePayoutAccount(connection: Connection, config: ChainConfig, raw: string, organizer: string, current: string) {
  let address: PublicKey
  try { address = new PublicKey(raw) } catch { throw new Error('PAYOUT_ACCOUNT_INVALID') }
  if (address.toBase58() === current) throw new Error('PAYOUT_ACCOUNT_SAME')
  const info = await connection.getAccountInfo(address, 'confirmed')
  if (!info || !info.owner.equals(TOKEN_PROGRAM_ID) || info.data.length !== ACCOUNT_SIZE) throw new Error('PAYOUT_ACCOUNT_INVALID')
  const decoded = AccountLayout.decode(info.data)
  if (decoded.state !== AccountState.Initialized || !new PublicKey(decoded.mint).equals(config.mint) || new PublicKey(decoded.owner).toBase58() !== organizer) {
    throw new Error('PAYOUT_ACCOUNT_INVALID')
  }
  return address
}

export async function prepareAction(connection: Connection, config: ChainConfig, action: Action, current: Activity | undefined, wallet: PublicKey, fixedEventId?: BN): Promise<Prepared> {
  const p = program(connection, config)
  if (action.type === 'CREATE') {
    await ensureTestMint(connection, config)
    const input: CreateInput = action.input
    const eventId = fixedEventId ?? new BN(crypto.getRandomValues(new Uint8Array(8)), 'le')
    const event = eventAddress(config, wallet, eventId)
    const instruction = await p.methods.createEvent({
      eventId, title: input.title.trim(), description: input.description.trim(),
      fulfillmentMode: input.fulfillmentMode === 'online' ? { online: {} } : { offline: {} },
      venue: input.venue.trim(), timeZone: input.timeZone,
      unitPrice: new BN((BigInt(input.price) * TOKEN_SCALE).toString()),
      minWallets: input.minWallets, capacity: input.capacity,
      registrationDeadline: new BN(Math.floor(Date.parse(input.registrationDeadline) / 1000)),
      eventStart: new BN(Math.floor(Date.parse(input.eventStart) / 1000)),
    }).accountsStrict({
      organizer: wallet, mint: config.mint, organizerTokenAccount: tokenAccountFor(config, wallet),
      event, vault: vaultAddress(config, event), tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction()
    return { instruction, event, operation: 'CREATE', eventId: eventId.toString(10) }
  }
  if (!current) throw new Error('Load an Event account before acting')
  const event = new PublicKey(current.id)
  const vault = vaultAddress(config, event)
  if (action.type === 'JOIN') {
    const participantTokenAccount = tokenAccountFor(config, wallet)
    const balance = await getAccount(connection, participantTokenAccount, 'confirmed', TOKEN_PROGRAM_ID)
    const eventInfo = await p.account.event.fetch(event)
    if (balance.amount < bnAmount(eventInfo.unitPrice)) throw new Error('LOCAL_BALANCE_INSUFFICIENT')
    return {
      instruction: await p.methods.joinEvent().accountsStrict({
        participant: wallet, mint: config.mint, participantTokenAccount, event, vault,
        participation: participationAddress(config, event, wallet), tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).instruction(), event, operation: 'JOIN', participant: wallet,
    }
  }
  if (action.type === 'CANCEL') return {
    instruction: await p.methods.cancelEvent().accountsStrict({ organizer: wallet, event, vault }).instruction(),
    event, operation: 'CANCEL',
  }
  if (action.type === 'FINALIZE' && current.status === 'OPEN' && current.participations.length < current.minWallets) return {
    instruction: await p.methods.finalizeFailedOrEmpty().accountsStrict({ caller: wallet, event, vault }).instruction(),
    event, operation: current.participations.length === 0 ? 'FINALIZE_EMPTY' : 'MARK_FAILED',
  }
  if (action.type === 'SETTLE' || action.type === 'FINALIZE') return {
    instruction: await p.methods.settleEvent().accountsStrict({
      caller: wallet, mint: config.mint, event, vault,
      organizerTokenAccount: new PublicKey(current.organizerTokenAccount), tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction(), event, operation: 'SETTLE',
  }
  if (action.type === 'REFUND') return {
    instruction: await p.methods.claimRefund().accountsStrict({
      participant: wallet, mint: config.mint, event, vault,
      participation: participationAddress(config, event, wallet), participantTokenAccount: tokenAccountFor(config, wallet),
      tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction(), event, operation: 'REFUND', participant: wallet,
  }
  if (action.type === 'UPDATE_PAYOUT') return {
    instruction: await p.methods.updatePayoutAccount().accountsStrict({
      organizer: wallet, event,
      newOrganizerTokenAccount: await validatePayoutAccount(connection, config, action.account, current.organizer, current.organizerTokenAccount),
    }).instruction(), event, operation: 'UPDATE_PAYOUT', newPayout: action.account,
  }
  if (action.type === 'CLOSE_PAYOUT') return {
    instruction: createCloseAccountInstruction(new PublicKey(current.organizerTokenAccount), wallet, wallet),
    event, operation: 'CLOSE_PAYOUT',
  }
  throw new Error(`Unsupported local action: ${action.type}`)
}

export type PendingTransaction = {
  schema: 1; cluster: ChainConfig['cluster']; genesisHash: string; programId: string; mint: string
  signature: string; event: string; operation: LocalOperation; actor: string
  participant?: string; newPayout?: string; eventId?: string
  blockhash: string; blockhashSlot?: number; lastValidBlockHeight: number; createdAt: string
}

export async function signAndBroadcast(
  connection: Connection, config: ChainConfig, prepared: Prepared, wallet: { publicKey: PublicKey; signTransaction: (tx: Transaction) => Promise<Transaction> },
  onSigned: (pending: PendingTransaction) => void,
): Promise<PendingTransaction> {
  const genesisHash = await connection.getGenesisHash()
  if (config.expectedGenesisHash && genesisHash !== config.expectedGenesisHash) throw new Error('Wrong network genesis hash')
  if (config.cluster === 'devnet' && !config.expectedGenesisHash) throw new Error('Devnet genesis hash is not configured')
  const programInfo = await connection.getAccountInfo(config.programId, 'confirmed')
  if (!programInfo?.executable) throw new Error('Configured program is not deployed or executable')
  await ensureTestMint(connection, config)
  const latestBlockhash = await connection.getLatestBlockhashAndContext('confirmed')
  const { blockhash, lastValidBlockHeight } = latestBlockhash.value
  const transaction = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: blockhash }).add(prepared.instruction)
  const signed = await wallet.signTransaction(transaction)
  if (!signed.signature) throw new Error('LOCAL_SIGNATURE_REJECTED')
  const pending = {
    schema: 1 as const, cluster: config.cluster, genesisHash,
    programId: config.programId.toBase58(), mint: config.mint.toBase58(),
    signature: bs58.encode(signed.signature), event: prepared.event.toBase58(), actor: wallet.publicKey.toBase58(),
    operation: prepared.operation, participant: prepared.participant?.toBase58(),
    newPayout: prepared.newPayout, eventId: prepared.eventId,
    blockhash, blockhashSlot: latestBlockhash.context.slot, lastValidBlockHeight, createdAt: new Date().toISOString(),
  }
  onSigned(pending) // Persist before broadcast: a lost RPC response must not invite a blind resend.
  await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed' })
  return pending
}

function observedStatus(status: SignatureStatus | null) {
  if (!status) return null
  if (status.confirmationStatus !== 'confirmed' && status.confirmationStatus !== 'finalized') return { kind: 'processed' as const }
  return status.err ? { kind: 'failed' as const } : { kind: 'confirmed' as const }
}

async function checkExpiredResult(connection: Connection, pending: PendingTransaction, timedOut: () => boolean) {
  if (pending.blockhashSlot === undefined) return { kind: 'expired-check' as const }
  if (timedOut()) return { kind: 'unknown' as const }
  const finalizedHeight = await connection.getBlockHeight('finalized')
  if (timedOut()) return { kind: 'unknown' as const }
  if (finalizedHeight <= pending.lastValidBlockHeight) return { kind: 'expired-check' as const }
  const validity = await connection.isBlockhashValid(pending.blockhash, {
    commitment: 'finalized', minContextSlot: pending.blockhashSlot,
  })
  if (timedOut()) return { kind: 'unknown' as const }
  if (validity.context.slot < pending.blockhashSlot || validity.value) return { kind: 'expired-check' as const }
  const transaction = await connection.getTransaction(pending.signature, { commitment: 'finalized' })
  if (timedOut()) return { kind: 'unknown' as const }
  if (!transaction?.meta || transaction.slot < pending.blockhashSlot) return { kind: 'expired-check' as const }
  return transaction.meta.err ? { kind: 'failed' as const } : { kind: 'confirmed' as const }
}

export async function awaitConfirmation(
  connection: Connection, pending: PendingTransaction,
  options: { attempts?: number; delayMs?: number; deadlineAtMs?: number } = {},
) {
  const attempts = options.attempts ?? 30
  const delayMs = options.delayMs ?? 750
  const timedOut = () => options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (timedOut()) return { kind: 'unknown' as const }
    const statuses = await connection.getSignatureStatuses([pending.signature], { searchTransactionHistory: true })
    if (timedOut()) return { kind: 'unknown' as const }
    const observed = observedStatus(statuses.value[0])
    if (observed?.kind === 'failed' || observed?.kind === 'confirmed') return observed
    const statusIsCurrent = pending.blockhashSlot !== undefined && (statuses.context?.slot ?? -1) >= pending.blockhashSlot
    if (!observed && statusIsCurrent) {
      const height = await connection.getBlockHeight('confirmed')
      if (timedOut()) return { kind: 'unknown' as const }
      if (height > pending.lastValidBlockHeight) return checkExpiredResult(connection, pending, timedOut)
    }
    const waitMs = options.deadlineAtMs === undefined ? delayMs : Math.min(delayMs, Math.max(0, options.deadlineAtMs - Date.now()))
    if (waitMs) await new Promise((done) => setTimeout(done, waitMs))
  }
  return { kind: 'unknown' as const }
}

// A structured instruction-simulation rejection is returned before that RPC submits the transaction.
// Network failures and blockhash errors are never classified as definite here.
export function isDefinitePreflightRejection(error: unknown) {
  if (!(error instanceof SendTransactionError)) return false
  const result = error.transactionError
  return error.message.startsWith('Simulation failed.') &&
    /^Transaction simulation failed: Error processing Instruction/.test(result.message) &&
    Array.isArray(result.logs) && result.logs.length > 0 && !/blockhash/i.test(result.message)
}

export async function definitePreflightOutcome(connection: Connection, pending: PendingTransaction, error: unknown) {
  if (!isDefinitePreflightRejection(error)) return 'unknown' as const
  const status = (await connection.getSignatureStatuses(
    [pending.signature], { searchTransactionHistory: true },
  )).value[0]
  return status ? 'status-found' as const : 'rejected' as const
}

export async function postcondition(connection: Connection, pending: PendingTransaction, activity: Activity) {
  if (pending.operation === 'CREATE') return activity.organizer === pending.actor
  if (pending.operation === 'JOIN') return activity.participations.some((item) => item.wallet === pending.participant)
  if (pending.operation === 'SETTLE') return activity.status === 'PAID'
  if (pending.operation === 'CANCEL') return activity.status === 'REFUNDING_CANCELLED' || activity.status === 'REFUNDED' ||
    (activity.status === 'CLOSED_EMPTY' && activity.closureReason === 'organizer_cancelled_empty')
  if (pending.operation === 'MARK_FAILED') return activity.status === 'REFUNDING_FAILED' || activity.status === 'REFUNDED'
  if (pending.operation === 'FINALIZE_EMPTY') return activity.status === 'CLOSED_EMPTY' && activity.closureReason === 'deadline_empty'
  if (pending.operation === 'REFUND') return activity.participations.some((item) => item.wallet === pending.participant && item.refunded)
  // A later valid payout update may replace the saved account; the original organizer is immutable.
  if (pending.operation === 'UPDATE_PAYOUT') return activity.organizer === pending.actor
  if (pending.operation === 'CLOSE_PAYOUT') return !(await connection.getAccountInfo(new PublicKey(activity.organizerTokenAccount), 'confirmed'))
  return false
}

export type PendingResolution =
  | { kind: 'unknown' }
  | { kind: 'expired-check' }
  | { kind: 'failed'; activity?: Activity }
  | { kind: 'confirmed'; activity: Activity }
  | { kind: 'confirmed-mismatch'; activity: Activity }
  | { kind: 'confirmed-unread' }

export async function resolvePendingTransaction(
  connection: Connection, config: ChainConfig, pending: PendingTransaction,
  read: typeof readEvent = readEvent,
  options: { attempts?: number; delayMs?: number; confirmationTimeoutMs?: number; readTimeoutMs?: number } = {},
): Promise<PendingResolution> {
  if (pending.cluster !== config.cluster || pending.programId !== config.programId.toBase58() || pending.mint !== config.mint.toBase58()) {
    throw new Error('Pending transaction belongs to another chain configuration')
  }
  const { confirmationTimeoutMs = 15_000, readTimeoutMs = 15_000, ...confirmationOptions } = options
  const confirmationDeadline = Date.now() + confirmationTimeoutMs
  let confirmation: Awaited<ReturnType<typeof awaitConfirmation>>
  try {
    confirmation = await within((async () => {
      if (await connection.getGenesisHash() !== pending.genesisHash) throw new Error('Pending transaction belongs to another ledger')
      return awaitConfirmation(connection, pending, { ...confirmationOptions, deadlineAtMs: confirmationDeadline })
    })(), confirmationTimeoutMs)
  }
  catch (error) {
    if (String(error).includes('RECOVERY_TIMEOUT')) return { kind: 'unknown' }
    throw error
  }
  if (confirmation.kind === 'unknown' || confirmation.kind === 'expired-check') return confirmation
  if (confirmation.kind === 'failed') {
    if (pending.operation === 'CREATE') return { kind: 'failed' }
    try { return { kind: 'failed', activity: await within(read(connection, config, new PublicKey(pending.event)), readTimeoutMs) } }
    catch { return { kind: 'failed' } }
  }
  let activity: Activity
  try { activity = await within(read(connection, config, new PublicKey(pending.event)), readTimeoutMs) }
  catch { return { kind: 'confirmed-unread' } }
  try {
    return await postcondition(connection, pending, activity)
      ? { kind: 'confirmed', activity }
      : { kind: 'confirmed-mismatch', activity }
  } catch { return { kind: 'confirmed-unread' } }
}

async function within<T>(promise: Promise<T>, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error('RECOVERY_TIMEOUT')), timeoutMs)
    })])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}
