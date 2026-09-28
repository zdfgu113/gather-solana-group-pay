import { readFileSync } from 'node:fs'
import { AnchorProvider, Program, setProvider } from '@anchor-lang/core'
import BN from 'bn.js'
import {
  AuthorityType,
  closeAccount,
  createAccount,
  createAssociatedTokenAccount,
  createMint,
  getAccount,
  mintTo,
  setAuthority,
  TOKEN_PROGRAM_ID,
  transfer,
} from '@solana/spl-token'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { expect } from 'chai'
import type { GroupPay } from '../target/types/group_pay.js'

const PROJECT_ID = new PublicKey('6JrQobtnXBeNv4khZhBGCLEEfXk7pJ8Dw1UozaEhXK8R')
const FIXED_MINT = new PublicKey('9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj')
const DECIMALS = 6
const UNIT_PRICE = 25_000_000n

type EventArgs = {
  eventId: BN
  title: string
  description: string
  fulfillmentMode: { offline: Record<string, never> } | { online: Record<string, never> }
  venue: string
  timeZone: string
  unitPrice: BN
  minWallets: number
  capacity: number
  registrationDeadline: BN
  eventStart: BN
}

function seedKeypair(offset: number) {
  return Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => ((index + offset) % 255) + 1))
}

function eventAddress(organizer: PublicKey, eventId: BN) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('event'), organizer.toBuffer(), eventId.toArrayLike(Buffer, 'le', 8)],
    PROJECT_ID,
  )[0]
}

function vaultAddress(event: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from('vault'), event.toBuffer()], PROJECT_ID)[0]
}

function participationAddress(event: PublicKey, participant: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('participation'), event.toBuffer(), participant.toBuffer()],
    PROJECT_ID,
  )[0]
}

async function rejectedError(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('Expected the program request to be rejected')
}

function failureText(error: unknown) {
  const logs = (error as { logs?: string[]; transactionLogs?: string[] }).logs ??
    (error as { transactionLogs?: string[] }).transactionLogs ?? []
  return `${String(error)}\n${logs.join('\n')}`
}

async function expectRejected(promise: Promise<unknown>, fragments: string[]) {
  const error = await rejectedError(promise)
  const text = failureText(error)
  expect(fragments.some((fragment) => text.includes(fragment)), text).to.equal(true)
  return error
}

describe('group-pay local validator', () => {
  const provider = AnchorProvider.env()
  setProvider(provider)
  const rawIdl = JSON.parse(readFileSync('target/local/group_pay.json', 'utf8'))
  const program = new Program<GroupPay>(rawIdl, provider)

  function expectAnchorError(error: unknown, expectedCode: string) {
    const namedCode = (error as { error?: { errorCode?: { code?: string } } }).error?.errorCode?.code ??
      failureText(error).match(/Error Code: ([A-Za-z]+)/)?.[1]
    if (namedCode !== undefined) {
      expect(namedCode, failureText(error)).to.equal(expectedCode)
      return
    }
    const idlError = rawIdl.errors.find((item: { name: string }) => item.name === expectedCode)
    expect(idlError, `Missing ${expectedCode} in the generated IDL`).to.exist
    expect((error as { code?: number }).code, failureText(error)).to.equal(idlError.code)
  }

  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(process.env.ANCHOR_WALLET!, 'utf8')) as number[]),
  )
  const mintKeypair = seedKeypair(0)
  const participants = [seedKeypair(40), seedKeypair(80), seedKeypair(120), seedKeypair(160)]
  let organizerTokenAccount: PublicKey
  const participantTokenAccounts = new Map<string, PublicKey>()

  async function fund(keypair: Keypair) {
    const signature = await provider.connection.requestAirdrop(keypair.publicKey, 5_000_000_000)
    const latest = await provider.connection.getLatestBlockhash()
    await provider.connection.confirmTransaction({ signature, ...latest }, 'confirmed')
  }

  async function tokenAccountFor(owner: Keypair) {
    const key = owner.publicKey.toBase58()
    const existing = participantTokenAccounts.get(key)
    if (existing) return existing
    await fund(owner)
    const account = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      FIXED_MINT,
      owner.publicKey,
    )
    await mintTo(provider.connection, payer, FIXED_MINT, account, payer, 500_000_000n)
    participantTokenAccounts.set(key, account)
    return account
  }

  async function freshArgs(id: number, capacity = 4, minimum = 3): Promise<EventArgs> {
    const slot = await provider.connection.getSlot('confirmed')
    const chainTime = (await provider.connection.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000)
    return {
      eventId: new BN(id),
      title: `本地测试活动 ${id}`,
      description: '仅使用 local validator 与无价值 TEST Mint。',
      fulfillmentMode: { offline: {} },
      venue: '上海测试地点',
      timeZone: 'Asia/Shanghai',
      unitPrice: new BN(UNIT_PRICE.toString()),
      minWallets: minimum,
      capacity,
      registrationDeadline: new BN(chainTime + 3_600),
      eventStart: new BN(chainTime + 7_200),
    }
  }

  async function createEvent(args: EventArgs, tokenAccount = organizerTokenAccount, mint = FIXED_MINT) {
    const event = eventAddress(payer.publicKey, args.eventId)
    const vault = vaultAddress(event)
    await program.methods
      .createEvent(args)
      .accountsStrict({
        organizer: payer.publicKey,
        mint,
        organizerTokenAccount: tokenAccount,
        event,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
    return { event, vault }
  }

  async function join(event: PublicKey, vault: PublicKey, participant: Keypair, tokenAccount: PublicKey) {
    return program.methods
      .joinEvent()
      .accountsStrict({
        participant: participant.publicKey,
        mint: FIXED_MINT,
        participantTokenAccount: tokenAccount,
        event,
        vault,
        participation: participationAddress(event, participant.publicKey),
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([participant])
      .rpc()
  }

  async function cancel(event: PublicKey, vault: PublicKey, organizer = payer) {
    return program.methods.cancelEvent().accountsStrict({
      organizer: organizer.publicKey,
      event,
      vault,
    }).signers(organizer === payer ? [] : [organizer]).rpc()
  }

  async function finalize(event: PublicKey, vault: PublicKey, caller = participants[0]) {
    return program.methods.finalizeFailedOrEmpty().accountsStrict({
      caller: caller.publicKey,
      event,
      vault,
    }).signers([caller]).rpc()
  }

  async function settle(event: PublicKey, vault: PublicKey, payout = organizerTokenAccount, caller = participants[0]) {
    return program.methods.settleEvent().accountsStrict({
      caller: caller.publicKey,
      mint: FIXED_MINT,
      event,
      vault,
      organizerTokenAccount: payout,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([caller]).rpc()
  }

  async function refund(event: PublicKey, vault: PublicKey, participant: Keypair, tokenAccount: PublicKey) {
    return program.methods.claimRefund().accountsStrict({
      participant: participant.publicKey,
      mint: FIXED_MINT,
      event,
      vault,
      participation: participationAddress(event, participant.publicKey),
      participantTokenAccount: tokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([participant]).rpc()
  }

  async function updatePayout(event: PublicKey, tokenAccount: PublicKey, organizer = payer) {
    return program.methods.updatePayoutAccount().accountsStrict({
      organizer: organizer.publicKey,
      event,
      newOrganizerTokenAccount: tokenAccount,
    }).signers(organizer === payer ? [] : [organizer]).rpc()
  }

  function ownTokenAccount(owner: Keypair) {
    return participantTokenAccounts.get(owner.publicKey.toBase58())!
  }

  before(async () => {
    expect(program.programId.equals(PROJECT_ID)).to.equal(true)
    await createMint(provider.connection, payer, payer.publicKey, null, DECIMALS, mintKeypair)
    organizerTokenAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      FIXED_MINT,
      payer.publicKey,
    )
    await mintTo(provider.connection, payer, FIXED_MINT, organizerTokenAccount, payer, 500_000_000n)
    for (const participant of participants) await tokenAccountFor(participant)
  })

  it('uses Anchor 1.2 IDL with classic SPL Token and the fixed worthless mint', () => {
    const createInstruction = rawIdl.instructions.find((item: { name: string }) => item.name === 'create_event')
    expect(rawIdl.address).to.equal(PROJECT_ID.toBase58())
    expect(createInstruction?.accounts.find((item: { name: string }) => item.name === 'mint')).to.include({
      address: FIXED_MINT.toBase58(),
    })
    expect(createInstruction?.accounts.find((item: { name: string }) => item.name === 'token_program')).to.include({
      address: TOKEN_PROGRAM_ID.toBase58(),
    })
  })

  it('rejects a wrong mint and a token account owned by the wrong wallet', async () => {
    const wrongMint = await createMint(provider.connection, payer, payer.publicKey, null, DECIMALS)
    const wrongMintAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      wrongMint,
      payer.publicKey,
    )
    await expectRejected(
      createEvent(await freshArgs(101), wrongMintAccount, wrongMint),
      ['WrongMint', 'wrongMint', '6000'],
    )

    const foreignAccount = participantTokenAccounts.get(participants[0].publicKey.toBase58())!
    await expectRejected(
      createEvent(await freshArgs(102), foreignAccount),
      ['WrongTokenAccountOwner', 'wrongTokenAccountOwner', '6002'],
    )
  })

  it('persists the immutable IANA zone in Event bytes and rejects unknown or oversized zones', async () => {
    const args = await freshArgs(103)
    args.timeZone = 'America/New_York'
    const { event } = await createEvent(args)
    const info = await provider.connection.getAccountInfo(event)
    expect(info).not.to.equal(null)
    const freshlyDecoded = new Program<GroupPay>(rawIdl, provider).coder.accounts.decode('event', info!.data)
    expect(freshlyDecoded.timeZone).to.equal(args.timeZone)
    expect(freshlyDecoded.registrationDeadline.toString()).to.equal(args.registrationDeadline.toString())
    expect(freshlyDecoded.eventStart.toString()).to.equal(args.eventStart.toString())

    for (const [id, zone, expected] of [
      [104, 'Mars/Olympus_Mons', 'UnsupportedTimeZone'],
      [105, 'x'.repeat(65), 'TimeZoneTooLong'],
    ] as const) {
      const invalid = await freshArgs(id)
      invalid.timeZone = zone
      const error = await rejectedError(createEvent(invalid))
      expectAnchorError(error, expected)
      expect(await provider.connection.getAccountInfo(eventAddress(payer.publicKey, invalid.eventId))).to.equal(null)
    }
  })

  it('creates one event and joins with an independent Participation PDA', async () => {
    const args = await freshArgs(201)
    const { event, vault } = await createEvent(args)
    const participant = participants[0]
    const tokenAccount = participantTokenAccounts.get(participant.publicKey.toBase58())!
    const before = (await getAccount(provider.connection, tokenAccount)).amount

    await join(event, vault, participant, tokenAccount)

    const eventAccount = await program.account.event.fetch(event)
    const participation = await program.account.participation.fetch(
      participationAddress(event, participant.publicKey),
    )
    const after = (await getAccount(provider.connection, tokenAccount)).amount
    const actualVault = (await getAccount(provider.connection, vault)).amount
    expect(eventAccount.participantCount).to.equal(1)
    expect(eventAccount.timeZone).to.equal(args.timeZone)
    expect(eventAccount.expectedEscrow.toString()).to.equal(UNIT_PRICE.toString())
    expect(participation.paidAmount.toString()).to.equal(UNIT_PRICE.toString())
    expect(participation.refunded).to.equal(false)
    expect(before - after).to.equal(UNIT_PRICE)
    expect(actualVault).to.equal(UNIT_PRICE)
  })

  it('rejects wrong participant accounts and duplicate participation without changing funds', async () => {
    const args = await freshArgs(202)
    const { event, vault } = await createEvent(args)
    const participant = participants[1]
    const tokenAccount = participantTokenAccounts.get(participant.publicKey.toBase58())!
    const foreignAccount = participantTokenAccounts.get(participants[2].publicKey.toBase58())!

    await expectRejected(
      join(event, vault, participant, foreignAccount),
      ['WrongTokenAccountOwner', 'wrongTokenAccountOwner', '6002'],
    )
    await join(event, vault, participant, tokenAccount)
    const vaultAfterFirst = (await getAccount(provider.connection, vault)).amount
    await expectRejected(join(event, vault, participant, tokenAccount), [
      'already in use',
      'AccountAlreadyInitialized',
    ])
    const eventAfterDuplicate = await program.account.event.fetch(event)
    expect(eventAfterDuplicate.participantCount).to.equal(1)
    expect((await getAccount(provider.connection, vault)).amount).to.equal(vaultAfterFirst)
  })

  it('rolls back Participation and obligations when the participant has too few tokens', async () => {
    const { event, vault } = await createEvent(await freshArgs(207))
    const participant = seedKeypair(200)
    await fund(participant)
    const emptyAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      FIXED_MINT,
      participant.publicKey,
    )

    const error = await rejectedError(join(event, vault, participant, emptyAccount))
    expect(failureText(error)).to.include('insufficient funds')
    expect(failureText(error)).to.include(TOKEN_PROGRAM_ID.toBase58())
    const eventAccount = await program.account.event.fetch(event)
    expect(eventAccount.participantCount).to.equal(0)
    expect(eventAccount.expectedEscrow.toString()).to.equal('0')
    expect((await getAccount(provider.connection, vault)).amount).to.equal(0n)
    expect((await getAccount(provider.connection, emptyAccount)).amount).to.equal(0n)
    expect(await provider.connection.getAccountInfo(participationAddress(event, participant.publicKey))).to.equal(null)
  })

  it('rejects another event vault and a participant account with a different mint', async () => {
    const { event, vault } = await createEvent(await freshArgs(205))
    const { vault: foreignVault } = await createEvent(await freshArgs(206))
    const participant = participants[1]
    const tokenAccount = participantTokenAccounts.get(participant.publicKey.toBase58())!
    const balanceBefore = (await getAccount(provider.connection, tokenAccount)).amount

    const wrongVaultError = await rejectedError(join(event, foreignVault, participant, tokenAccount))
    expectAnchorError(wrongVaultError, 'ConstraintHasOne')

    const wrongMint = await createMint(provider.connection, payer, payer.publicKey, null, DECIMALS)
    const wrongMintAccount = await createAssociatedTokenAccount(
      provider.connection,
      payer,
      wrongMint,
      participant.publicKey,
    )
    await mintTo(provider.connection, payer, wrongMint, wrongMintAccount, payer, 500_000_000n)
    const wrongMintError = await rejectedError(join(event, vault, participant, wrongMintAccount))
    expectAnchorError(wrongMintError, 'WrongTokenAccountMint')

    const eventAccount = await program.account.event.fetch(event)
    expect(eventAccount.participantCount).to.equal(0)
    expect(eventAccount.expectedEscrow.toString()).to.equal('0')
    expect((await getAccount(provider.connection, vault)).amount).to.equal(0n)
    expect((await getAccount(provider.connection, foreignVault)).amount).to.equal(0n)
    expect((await getAccount(provider.connection, tokenAccount)).amount).to.equal(balanceBefore)
    expect((await getAccount(provider.connection, wrongMintAccount)).amount).to.equal(500_000_000n)
    expect(await provider.connection.getAccountInfo(participationAddress(event, participant.publicKey))).to.equal(null)
  })

  it('derives surplus from actual vault balance while preserving legal obligations', async () => {
    const args = await freshArgs(203)
    const { event, vault } = await createEvent(args)
    const participant = participants[2]
    const tokenAccount = participantTokenAccounts.get(participant.publicKey.toBase58())!
    await join(event, vault, participant, tokenAccount)

    const unsolicited = 7_000_000n
    await transfer(
      provider.connection,
      payer,
      organizerTokenAccount,
      vault,
      payer,
      unsolicited,
    )
    const beforeSecondJoin = await program.account.event.fetch(event)
    const actualBeforeSecondJoin = (await getAccount(provider.connection, vault)).amount
    expect(actualBeforeSecondJoin - BigInt(beforeSecondJoin.expectedEscrow.toString())).to.equal(unsolicited)

    const second = participants[3]
    const secondTokenAccount = participantTokenAccounts.get(second.publicKey.toBase58())!
    const secondBefore = (await getAccount(provider.connection, secondTokenAccount)).amount
    await join(event, vault, second, secondTokenAccount)

    const eventAccount = await program.account.event.fetch(event)
    const actual = (await getAccount(provider.connection, vault)).amount
    const obligation = BigInt(eventAccount.expectedEscrow.toString())
    expect(eventAccount.participantCount).to.equal(2)
    expect(obligation).to.equal(UNIT_PRICE * 2n)
    expect(actual).to.equal(actualBeforeSecondJoin + UNIT_PRICE)
    expect(secondBefore - (await getAccount(provider.connection, secondTokenAccount)).amount).to.equal(UNIT_PRICE)
    expect(actual - obligation).to.equal(unsolicited)
    expect(Object.hasOwn(eventAccount, 'unexpectedSurplus')).to.equal(false)
  })

  it('serializes two contenders for the last seat: exactly one joins', async () => {
    const args = await freshArgs(204, 2, 2)
    const { event, vault } = await createEvent(args)
    const first = participants[0]
    await join(event, vault, first, participantTokenAccounts.get(first.publicKey.toBase58())!)

    const contenders = participants.slice(2, 4)
    const contenderAccounts = contenders.map((participant) => participantTokenAccounts.get(participant.publicKey.toBase58())!)
    const tokenBalancesBefore = await Promise.all(
      contenderAccounts.map(async (account) => (await getAccount(provider.connection, account)).amount),
    )
    const solBalancesBefore = await Promise.all(
      contenders.map((participant) => provider.connection.getBalance(participant.publicKey)),
    )
    const results = await Promise.allSettled(
      contenders.map((participant, index) =>
        join(event, vault, participant, contenderAccounts[index]),
      ),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).to.have.length(1)
    expect(results.filter((result) => result.status === 'rejected')).to.have.length(1)

    const winner = results.findIndex((result) => result.status === 'fulfilled')
    const loser = results.findIndex((result) => result.status === 'rejected')
    expectAnchorError((results[loser] as PromiseRejectedResult).reason, 'EventNotOpen')
    for (const [index, participant] of contenders.entries()) {
      const tokenAfter = (await getAccount(provider.connection, contenderAccounts[index])).amount
      expect(tokenBalancesBefore[index] - tokenAfter).to.equal(index === winner ? UNIT_PRICE : 0n)
      const participation = await provider.connection.getAccountInfo(participationAddress(event, participant.publicKey))
      expect(participation === null).to.equal(index === loser)
      const solAfter = await provider.connection.getBalance(participant.publicKey)
      // SOL fees and the winner's PDA rent are separate from the tested SPL-token payment.
      expect(solAfter).to.be.at.most(solBalancesBefore[index])
      console.log(`${index === winner ? 'Winner' : 'Loser'}: token debit=${tokenBalancesBefore[index] - tokenAfter}, SOL debit=${solBalancesBefore[index] - solAfter} lamports (fees/rent)`)
    }

    const eventAccount = await program.account.event.fetch(event)
    const actualVault = (await getAccount(provider.connection, vault)).amount
    expect(eventAccount.participantCount).to.equal(2)
    expect(eventAccount.status).to.deep.equal({ ready: {} })
    expect(eventAccount.expectedEscrow.toString()).to.equal((UNIT_PRICE * 2n).toString())
    expect(actualVault).to.equal(UNIT_PRICE * 2n)
  })

  it('only the organizer can cancel OPEN before the deadline; two independent claims preserve surplus', async () => {
    const { event, vault } = await createEvent(await freshArgs(301))
    const members = participants.slice(0, 2)
    const startingBalances = await Promise.all(members.map(async (member) =>
      (await getAccount(provider.connection, ownTokenAccount(member))).amount))
    for (const member of members) await join(event, vault, member, ownTokenAccount(member))
    const surplus = 3_000_000n
    await transfer(provider.connection, payer, organizerTokenAccount, vault, payer, surplus)

    expectAnchorError(await rejectedError(cancel(event, vault, participants[2])), 'ConstraintHasOne')
    expectAnchorError(await rejectedError(finalize(event, vault)), 'DeadlineNotReached')
    expectAnchorError(await rejectedError(refund(event, vault, members[0], ownTokenAccount(members[0]))), 'RefundNotAvailable')
    await cancel(event, vault)
    const cancelled = await program.account.event.fetch(event)
    expect(cancelled.status).to.deep.equal({ refundingCancelled: {} })
    expect(cancelled.expectedEscrow.toString()).to.equal((UNIT_PRICE * 2n).toString())
    expectAnchorError(await rejectedError(cancel(event, vault)), 'EventNotOpen')
    expectAnchorError(await rejectedError(settle(event, vault)), 'EventNotSettleable')
    expectAnchorError(await rejectedError(join(event, vault, participants[2], ownTokenAccount(participants[2]))), 'EventNotOpen')

    expectAnchorError(
      await rejectedError(refund(event, vault, members[0], ownTokenAccount(participants[2]))),
      'WrongTokenAccountOwner',
    )
    for (const [index, member] of members.entries()) {
      await refund(event, vault, member, ownTokenAccount(member))
      const record = await program.account.participation.fetch(participationAddress(event, member.publicKey))
      expect(record.refunded).to.equal(true)
      expect((await getAccount(provider.connection, ownTokenAccount(member))).amount).to.equal(startingBalances[index])
      if (index === 0) {
        expectAnchorError(await rejectedError(refund(event, vault, member, ownTokenAccount(member))), 'AlreadyRefunded')
      }
    }
    const final = await program.account.event.fetch(event)
    expect(final.status).to.deep.equal({ refunded: {} })
    expect(final.refundedCount).to.equal(2)
    expect(final.expectedEscrow.toString()).to.equal('0')
    expect((await getAccount(provider.connection, vault)).amount).to.equal(surplus)
    expectAnchorError(await rejectedError(refund(event, vault, members[1], ownTokenAccount(members[1]))), 'RefundNotAvailable')
  })

  it('closes an empty cancelled event without creating a refund obligation', async () => {
    const { event, vault } = await createEvent(await freshArgs(302))
    await cancel(event, vault)
    const state = await program.account.event.fetch(event)
    expect(state.status).to.deep.equal({ closedEmpty: {} })
    expect(state.emptyCloseReason).to.deep.equal({ cancelled: {} })
    expect(state.participantCount).to.equal(0)
    expect(state.expectedEscrow.toString()).to.equal('0')
    expect((await getAccount(provider.connection, vault)).amount).to.equal(0n)
    expectAnchorError(await rejectedError(updatePayout(event, organizerTokenAccount)), 'PayoutUpdateClosed')
    expectAnchorError(await rejectedError(cancel(event, vault)), 'EventNotOpen')
  })

  it('settles READY once to the recorded organizer account and leaves unsolicited surplus in the vault', async () => {
    const { event, vault } = await createEvent(await freshArgs(303, 2, 2))
    for (const member of participants.slice(0, 2)) await join(event, vault, member, ownTokenAccount(member))
    const surplus = 5_000_000n
    await transfer(provider.connection, payer, organizerTokenAccount, vault, payer, surplus)
    const payoutBefore = (await getAccount(provider.connection, organizerTokenAccount)).amount
    expectAnchorError(await rejectedError(cancel(event, vault)), 'EventNotOpen')
    expectAnchorError(await rejectedError(finalize(event, vault)), 'EventNotOpen')
    await settle(event, vault)
    const state = await program.account.event.fetch(event)
    expect(state.status).to.deep.equal({ paid: {} })
    expect(state.expectedEscrow.toString()).to.equal('0')
    expect((await getAccount(provider.connection, organizerTokenAccount)).amount - payoutBefore).to.equal(UNIT_PRICE * 2n)
    expect((await getAccount(provider.connection, vault)).amount).to.equal(surplus)
    expectAnchorError(await rejectedError(settle(event, vault)), 'EventNotSettleable')
    expectAnchorError(await rejectedError(refund(event, vault, participants[0], ownTokenAccount(participants[0]))), 'RefundNotAvailable')
  })

  it('recovers a disabled payout account in OPEN/READY without changing organizer identity', async () => {
    const originalPayout = await createAccount(provider.connection, payer, FIXED_MINT, payer.publicKey, Keypair.generate())
    const args = await freshArgs(304, 2, 2)
    const { event, vault } = await createEvent(args, originalPayout)
    const foreign = ownTokenAccount(participants[0])
    expectAnchorError(await rejectedError(updatePayout(event, originalPayout)), 'PayoutAccountUnchanged')
    expectAnchorError(await rejectedError(updatePayout(event, foreign)), 'WrongTokenAccountOwner')
    expectAnchorError(await rejectedError(updatePayout(event, originalPayout, participants[0])), 'ConstraintHasOne')
    const wrongMint = await createMint(provider.connection, payer, payer.publicKey, null, DECIMALS)
    const wrongMintPayout = await createAccount(provider.connection, payer, wrongMint, payer.publicKey, Keypair.generate())
    expectAnchorError(await rejectedError(updatePayout(event, wrongMintPayout)), 'WrongTokenAccountMint')

    const newPayout = await createAccount(provider.connection, payer, FIXED_MINT, payer.publicKey, Keypair.generate())
    await updatePayout(event, newPayout)
    for (const member of participants.slice(0, 2)) await join(event, vault, member, ownTokenAccount(member))
    expect((await program.account.event.fetch(event)).status).to.deep.equal({ ready: {} })
    await setAuthority(provider.connection, payer, newPayout, payer, AuthorityType.AccountOwner, participants[0].publicKey)
    expectAnchorError(await rejectedError(settle(event, vault, newPayout)), 'WrongTokenAccountOwner')
    const recoveredPayout = await createAccount(provider.connection, payer, FIXED_MINT, payer.publicKey, Keypair.generate())
    await updatePayout(event, recoveredPayout)
    const state = await program.account.event.fetch(event)
    expect(state.organizer.equals(payer.publicKey)).to.equal(true)
    expect(state.organizerTokenAccount.equals(recoveredPayout)).to.equal(true)
    expectAnchorError(await rejectedError(settle(event, vault, originalPayout)), 'ConstraintHasOne')
    await settle(event, vault, recoveredPayout, participants[1])
    expect((await getAccount(provider.connection, recoveredPayout)).amount).to.equal(UNIT_PRICE * 2n)
    expect((await getAccount(provider.connection, originalPayout)).amount).to.equal(0n)
    expect((await getAccount(provider.connection, newPayout)).amount).to.equal(0n)
    expect((await getAccount(provider.connection, vault)).amount).to.equal(0n)
    expectAnchorError(await rejectedError(updatePayout(event, originalPayout)), 'PayoutUpdateClosed')
  })

  it('recovers a closed payout account without losing escrow or paying the closed address', async () => {
    const oldPayout = await createAccount(provider.connection, payer, FIXED_MINT, payer.publicKey, Keypair.generate())
    const { event, vault } = await createEvent(await freshArgs(308, 2, 2), oldPayout)
    for (const member of participants.slice(0, 2)) await join(event, vault, member, ownTokenAccount(member))
    const obligation = UNIT_PRICE * 2n
    await closeAccount(provider.connection, payer, oldPayout, payer.publicKey, payer)
    expect(await provider.connection.getAccountInfo(oldPayout)).to.equal(null)
    expectAnchorError(await rejectedError(settle(event, vault, oldPayout)), 'AccountNotInitialized')
    const beforeRecovery = await program.account.event.fetch(event)
    expect(beforeRecovery.status).to.deep.equal({ ready: {} })
    expect(beforeRecovery.expectedEscrow.toString()).to.equal(obligation.toString())
    expect((await getAccount(provider.connection, vault)).amount).to.equal(obligation)

    const recoveredPayout = await createAccount(provider.connection, payer, FIXED_MINT, payer.publicKey, Keypair.generate())
    await updatePayout(event, recoveredPayout)
    await settle(event, vault, recoveredPayout)
    const final = await program.account.event.fetch(event)
    expect(final.status).to.deep.equal({ paid: {} })
    expect(final.expectedEscrow.toString()).to.equal('0')
    expect((await getAccount(provider.connection, recoveredPayout)).amount).to.equal(obligation)
    expect((await getAccount(provider.connection, vault)).amount).to.equal(0n)
    expect(await provider.connection.getAccountInfo(oldPayout)).to.equal(null)
  })

  it('rejects payout updates after settlement and never pays twice', async () => {
    const originalPayout = await createAccount(provider.connection, payer, FIXED_MINT, payer.publicKey, Keypair.generate())
    const replacement = await createAccount(provider.connection, payer, FIXED_MINT, payer.publicKey, Keypair.generate())
    const { event, vault } = await createEvent(await freshArgs(309, 2, 2), originalPayout)
    for (const member of participants.slice(0, 2)) await join(event, vault, member, ownTokenAccount(member))
    await settle(event, vault, originalPayout)
    expectAnchorError(await rejectedError(updatePayout(event, replacement)), 'PayoutUpdateClosed')
    expectAnchorError(await rejectedError(settle(event, vault, originalPayout)), 'EventNotSettleable')
    expect((await getAccount(provider.connection, originalPayout)).amount).to.equal(UNIT_PRICE * 2n)
    expect((await getAccount(provider.connection, replacement)).amount).to.equal(0n)
    expect((await getAccount(provider.connection, vault)).amount).to.equal(0n)
    const final = await program.account.event.fetch(event)
    expect(final.organizerTokenAccount.equals(originalPayout)).to.equal(true)
    expect(final.expectedEscrow.toString()).to.equal('0')
  })

  it('serializes cancel against the last seat and forbids the losing branch', async () => {
    const { event, vault } = await createEvent(await freshArgs(305, 2, 2))
    await join(event, vault, participants[0], ownTokenAccount(participants[0]))
    const contender = participants[2]
    const contenderBalance = (await getAccount(provider.connection, ownTokenAccount(contender))).amount
    const results = await Promise.allSettled([
      cancel(event, vault),
      join(event, vault, contender, ownTokenAccount(contender)),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).to.have.length(1)
    expect(results.filter((result) => result.status === 'rejected')).to.have.length(1)
    const rejectedIndex = results.findIndex((result) => result.status === 'rejected')
    expectAnchorError((results[rejectedIndex] as PromiseRejectedResult).reason, 'EventNotOpen')
    const state = await program.account.event.fetch(event)
    if (results[0].status === 'fulfilled') {
      expect(state.status).to.deep.equal({ refundingCancelled: {} })
      expect((await getAccount(provider.connection, ownTokenAccount(contender))).amount).to.equal(contenderBalance)
      expect(await provider.connection.getAccountInfo(participationAddress(event, contender.publicKey))).to.equal(null)
    } else {
      expect(state.status).to.deep.equal({ ready: {} })
      expect((await getAccount(provider.connection, ownTokenAccount(contender))).amount).to.equal(contenderBalance - UNIT_PRICE)
      expect(await provider.connection.getAccountInfo(participationAddress(event, contender.publicKey))).to.not.equal(null)
    }
    expect((await getAccount(provider.connection, vault)).amount).to.equal(BigInt(state.expectedEscrow.toString()))
  })

  it('covers both deterministic orders of cancel versus the last seat', async () => {
    const first = participants[0]
    const contender = participants[2]
    const tokenAccount = ownTokenAccount(contender)

    const cancelled = await createEvent(await freshArgs(306, 2, 2))
    await join(cancelled.event, cancelled.vault, first, ownTokenAccount(first))
    const beforeCancelFirst = (await getAccount(provider.connection, tokenAccount)).amount
    await cancel(cancelled.event, cancelled.vault)
    expectAnchorError(await rejectedError(join(cancelled.event, cancelled.vault, contender, tokenAccount)), 'EventNotOpen')
    expect((await getAccount(provider.connection, tokenAccount)).amount).to.equal(beforeCancelFirst)
    expect(await provider.connection.getAccountInfo(participationAddress(cancelled.event, contender.publicKey))).to.equal(null)
    expect((await program.account.event.fetch(cancelled.event)).status).to.deep.equal({ refundingCancelled: {} })
    expect((await getAccount(provider.connection, cancelled.vault)).amount).to.equal(UNIT_PRICE)

    const filled = await createEvent(await freshArgs(307, 2, 2))
    await join(filled.event, filled.vault, first, ownTokenAccount(first))
    const beforeJoinFirst = (await getAccount(provider.connection, tokenAccount)).amount
    await join(filled.event, filled.vault, contender, tokenAccount)
    expectAnchorError(await rejectedError(cancel(filled.event, filled.vault)), 'EventNotOpen')
    expect((await getAccount(provider.connection, tokenAccount)).amount).to.equal(beforeJoinFirst - UNIT_PRICE)
    expect(await provider.connection.getAccountInfo(participationAddress(filled.event, contender.publicKey))).to.not.equal(null)
    expect((await program.account.event.fetch(filled.event)).status).to.deep.equal({ ready: {} })
    expect((await getAccount(provider.connection, filled.vault)).amount).to.equal(UNIT_PRICE * 2n)
  })
})
