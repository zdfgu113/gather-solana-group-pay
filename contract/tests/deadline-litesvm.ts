import { readFileSync } from 'node:fs'
import { Program } from '@anchor-lang/core'
import BN from 'bn.js'
import {
  ACCOUNT_SIZE,
  AccountLayout,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
  createInitializeAccount3Instruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
} from '@solana/spl-token'
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, type TransactionInstruction } from '@solana/web3.js'
import { address, getTransactionDecoder, lamports } from '@solana/kit'
import { expect } from 'chai'
import { FailedTransactionMetadata, LiteSVM, TransactionMetadata } from 'litesvm'
import type { GroupPay } from '../target/types/group_pay.js'

const PROJECT_ID = new PublicKey('6JrQobtnXBeNv4khZhBGCLEEfXk7pJ8Dw1UozaEhXK8R')
const MINT = new PublicKey('9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj')
const T0 = 1_800_000_000
const DEADLINE = T0 + 3_600
const PRICE = 25_000_000n
const vmAddress = (key: PublicKey) => address(key.toBase58())
function seedKeypair(offset: number) {
  return Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => ((index + offset) % 255) + 1))
}

function eventAddress(organizer: PublicKey, id: number) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('event'), organizer.toBuffer(), new BN(id).toArrayLike(Buffer, 'le', 8)],
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

describe('group-pay instruction-level deadline seconds (LiteSVM)', () => {
  let svm: LiteSVM
  const idl = JSON.parse(readFileSync('target/local/group_pay.json', 'utf8'))
  const program = new Program<GroupPay>(idl, { connection: new Connection('http://127.0.0.1:65534') })
  const organizer = seedKeypair(230)
  const fixedMint = seedKeypair(0)
  const alice = seedKeypair(40)
  const bob = seedKeypair(80)
  const carol = seedKeypair(120)
  let payout: PublicKey
  let aliceToken: PublicKey
  let bobToken: PublicKey
  let carolToken: PublicKey

  function at(unixTimestamp: number) {
    const clock = svm.getClock()
    clock.unixTimestamp = BigInt(unixTimestamp)
    svm.setClock(clock)
    expect(Number(svm.getClock().unixTimestamp)).to.equal(unixTimestamp)
  }

  function send(ixs: TransactionInstruction[], signers: Keypair[]) {
    svm.expireBlockhash()
    const tx = new Transaction({ feePayer: signers[0].publicKey, recentBlockhash: svm.latestBlockhash() })
    tx.add(...ixs)
    tx.sign(...signers)
    return svm.sendTransaction(getTransactionDecoder().decode(tx.serialize()))
  }

  function success(result: TransactionMetadata | FailedTransactionMetadata) {
    expect(result instanceof TransactionMetadata, result.toString()).to.equal(true)
  }

  function rejected(result: TransactionMetadata | FailedTransactionMetadata, code: string) {
    expect(result instanceof FailedTransactionMetadata, result.toString()).to.equal(true)
    const logs = (result as FailedTransactionMetadata).meta().logs().join('\n')
    expect(logs, result.toString()).to.include(`Error Code: ${code}`)
  }

  function existingAccount(key: PublicKey) {
    const info = svm.getAccount(vmAddress(key))
    if (!info.exists) throw new Error(`Missing VM account ${key.toBase58()}`)
    return info
  }

  function tokenAmount(address: PublicKey) {
    return AccountLayout.decode(Buffer.from(existingAccount(address).data)).amount
  }

  function state(address: PublicKey) {
    return program.coder.accounts.decode('event', Buffer.from(existingAccount(address).data))
  }

  function participationState(address: PublicKey) {
    return program.coder.accounts.decode('participation', Buffer.from(existingAccount(address).data))
  }

  function setTokenAmount(key: PublicKey, amount: bigint) {
    const original = existingAccount(key)
    const data = Buffer.from(original.data)
    data.writeBigUInt64LE(amount, 64)
    svm.setAccount({ ...original, data })
    return original
  }

  function createOtherMint() {
    const other = Keypair.generate()
    success(send([
      SystemProgram.createAccount({
        fromPubkey: organizer.publicKey,
        newAccountPubkey: other.publicKey,
        lamports: Number(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))),
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(other.publicKey, 6, organizer.publicKey, null),
    ], [organizer, other]))
    return other.publicKey
  }

  function createTokenAccount(owner: PublicKey) {
    const account = Keypair.generate()
    const result = send([
      SystemProgram.createAccount({
        fromPubkey: organizer.publicKey,
        newAccountPubkey: account.publicKey,
        lamports: Number(svm.minimumBalanceForRentExemption(BigInt(ACCOUNT_SIZE))),
        space: ACCOUNT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccount3Instruction(account.publicKey, MINT, owner),
    ], [organizer, account])
    success(result)
    return account.publicKey
  }

  async function createEvent(id: number, capacity = 3, minWallets = 2) {
    const event = eventAddress(organizer.publicKey, id)
    const vault = vaultAddress(event)
    const ix = await program.methods.createEvent({
      eventId: new BN(id),
      title: `Boundary ${id}`,
      description: 'Local VM, worthless mint only',
      fulfillmentMode: { online: {} },
      venue: 'https://example.invalid/test',
      timeZone: 'America/Los_Angeles',
      unitPrice: new BN(PRICE.toString()),
      minWallets,
      capacity,
      registrationDeadline: new BN(DEADLINE),
      eventStart: new BN(DEADLINE + 3600),
    }).accountsStrict({
      organizer: organizer.publicKey,
      mint: MINT,
      organizerTokenAccount: payout,
      event,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).instruction()
    success(send([ix], [organizer]))
    expect(existingAccount(event).data.length).to.equal(772)
    expect(state(event).timeZone).to.equal('America/Los_Angeles')
    return { event, vault }
  }

  async function join(event: PublicKey, vault: PublicKey, participant: Keypair, tokenAccount: PublicKey) {
    const ix = await program.methods.joinEvent().accountsStrict({
      participant: participant.publicKey,
      mint: MINT,
      participantTokenAccount: tokenAccount,
      event,
      vault,
      participation: participationAddress(event, participant.publicKey),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).instruction()
    return send([ix], [participant])
  }

  async function cancel(event: PublicKey, vault: PublicKey) {
    const ix = await program.methods.cancelEvent().accountsStrict({ organizer: organizer.publicKey, event, vault }).instruction()
    return send([ix], [organizer])
  }

  async function finalize(event: PublicKey, vault: PublicKey) {
    const ix = await program.methods.finalizeFailedOrEmpty().accountsStrict({ caller: alice.publicKey, event, vault }).instruction()
    return send([ix], [alice])
  }

  async function settle(event: PublicKey, vault: PublicKey, overrides: { vault?: PublicKey; mint?: PublicKey } = {}) {
    const ix = await program.methods.settleEvent().accountsStrict({
      caller: bob.publicKey,
      mint: overrides.mint ?? MINT,
      event,
      vault: overrides.vault ?? vault,
      organizerTokenAccount: payout,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction()
    return send([ix], [bob])
  }

  async function refund(
    event: PublicKey,
    vault: PublicKey,
    participant: Keypair,
    tokenAccount: PublicKey,
    overrides: { vault?: PublicKey; mint?: PublicKey; participation?: PublicKey } = {},
  ) {
    const ix = await program.methods.claimRefund().accountsStrict({
      participant: participant.publicKey,
      mint: overrides.mint ?? MINT,
      event,
      vault: overrides.vault ?? vault,
      participation: overrides.participation ?? participationAddress(event, participant.publicKey),
      participantTokenAccount: tokenAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction()
    return send([ix], [participant])
  }

  beforeEach(() => {
    svm = new LiteSVM()
    svm.addProgramFromFile(vmAddress(PROJECT_ID), 'target/local/group_pay.so')
    for (const signer of [organizer, alice, bob, carol]) {
      success(svm.airdrop(vmAddress(signer.publicKey), lamports(2_000_000_000n))!)
    }
    at(T0)
    success(send([
      SystemProgram.createAccount({
        fromPubkey: organizer.publicKey,
        newAccountPubkey: MINT,
        lamports: Number(svm.minimumBalanceForRentExemption(BigInt(MINT_SIZE))),
        space: MINT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(MINT, 6, organizer.publicKey, null),
    ], [organizer, fixedMint]))
    payout = createTokenAccount(organizer.publicKey)
    aliceToken = createTokenAccount(alice.publicKey)
    bobToken = createTokenAccount(bob.publicKey)
    carolToken = createTokenAccount(carol.publicKey)
    for (const account of [aliceToken, bobToken, carolToken]) {
      success(send([createMintToInstruction(MINT, account, organizer.publicKey, 100_000_000n)], [organizer]))
    }
  })

  it('uses < deadline for join/cancel and >= deadline for failure/empty/settlement', async () => {
    const failed = await createEvent(401)
    const cancelled = await createEvent(402)
    const empty = await createEvent(403)
    const met = await createEvent(404)
    const shortage = await createEvent(405)

    at(DEADLINE - 1)
    success(await join(failed.event, failed.vault, alice, aliceToken))
    success(await join(shortage.event, shortage.vault, alice, aliceToken))
    success(await join(met.event, met.vault, bob, bobToken))
    success(await join(met.event, met.vault, carol, carolToken))
    rejected(await settle(met.event, met.vault), 'DeadlineNotReached')
    rejected(await finalize(empty.event, empty.vault), 'DeadlineNotReached')
    success(await cancel(cancelled.event, cancelled.vault))
    expect(state(cancelled.event).status).to.deep.equal({ closedEmpty: {} })
    expect(state(cancelled.event).emptyCloseReason).to.deep.equal({ cancelled: {} })

    at(DEADLINE)
    const bobBefore = tokenAmount(bobToken)
    rejected(await join(failed.event, failed.vault, bob, bobToken), 'RegistrationClosed')
    expect(svm.getAccount(vmAddress(participationAddress(failed.event, bob.publicKey))).exists).to.equal(false)
    expect(tokenAmount(bobToken)).to.equal(bobBefore)
    rejected(await cancel(failed.event, failed.vault), 'CancellationClosed')
    success(await finalize(failed.event, failed.vault))
    expect(state(failed.event).status).to.deep.equal({ refundingFailed: {} })
    rejected(await finalize(failed.event, failed.vault), 'EventNotOpen')
    const aliceBeforeRefund = tokenAmount(aliceToken)
    success(await refund(failed.event, failed.vault, alice, aliceToken))
    expect(tokenAmount(aliceToken) - aliceBeforeRefund).to.equal(PRICE)
    expect(state(failed.event).status).to.deep.equal({ refunded: {} })
    rejected(await refund(failed.event, failed.vault, alice, aliceToken), 'RefundNotAvailable')
    success(await finalize(empty.event, empty.vault))
    expect(state(empty.event).status).to.deep.equal({ closedEmpty: {} })
    expect(state(empty.event).emptyCloseReason).to.deep.equal({ deadline: {} })
    rejected(await finalize(empty.event, empty.vault), 'EventNotOpen')
    const payoutBefore = tokenAmount(payout)
    success(await settle(met.event, met.vault))
    expect(tokenAmount(payout) - payoutBefore).to.equal(PRICE * 2n)
    expect(state(met.event).status).to.deep.equal({ paid: {} })

    // Inject an unreachable-on-normal-path token shortage to exercise the explicit invariant error.
    const vaultInfo = setTokenAmount(shortage.vault, PRICE - 1n)
    rejected(await finalize(shortage.event, shortage.vault), 'VaultBelowObligation')
    expect(state(shortage.event).status).to.deep.equal({ open: {} })
    svm.setAccount(vaultInfo)
    success(await finalize(shortage.event, shortage.vault))
    success(await refund(shortage.event, shortage.vault, alice, aliceToken))
    expect(state(shortage.event).status).to.deep.equal({ refunded: {} })
  })

  it('rejects settlement with another vault, wrong mint, or a vault shortage without paying', async () => {
    const target = await createEvent(406, 2, 2)
    const other = await createEvent(407)
    const wrongMint = createOtherMint()
    success(await join(target.event, target.vault, alice, aliceToken))
    success(await join(target.event, target.vault, bob, bobToken))
    const obligation = PRICE * 2n
    const payoutBefore = tokenAmount(payout)

    rejected(await settle(target.event, target.vault, { vault: other.vault }), 'ConstraintHasOne')
    rejected(await settle(target.event, target.vault, { mint: wrongMint }), 'WrongMint')
    expect(tokenAmount(other.vault)).to.equal(0n)
    expect(tokenAmount(target.vault)).to.equal(obligation)
    expect(tokenAmount(payout)).to.equal(payoutBefore)
    expect(state(target.event).expectedEscrow.toString()).to.equal(obligation.toString())
    expect(state(target.event).status).to.deep.equal({ ready: {} })

    const original = setTokenAmount(target.vault, obligation - 1n)
    rejected(await settle(target.event, target.vault), 'VaultBelowObligation')
    expect(tokenAmount(target.vault)).to.equal(obligation - 1n)
    expect(tokenAmount(payout)).to.equal(payoutBefore)
    expect(state(target.event).expectedEscrow.toString()).to.equal(obligation.toString())
    expect(state(target.event).status).to.deep.equal({ ready: {} })
    expect(participationState(participationAddress(target.event, alice.publicKey)).refunded).to.equal(false)
    svm.setAccount(original)

    success(await settle(target.event, target.vault))
    expect(tokenAmount(payout) - payoutBefore).to.equal(obligation)
    expect(tokenAmount(target.vault)).to.equal(0n)
    expect(state(target.event).expectedEscrow.toString()).to.equal('0')
    expect(state(target.event).status).to.deep.equal({ paid: {} })
  })

  it('binds refunds to the signer and event; wrong vault, mint, and shortage leave claims untouched', async () => {
    const target = await createEvent(408)
    const other = await createEvent(409)
    const wrongMint = createOtherMint()
    success(await join(target.event, target.vault, alice, aliceToken))
    success(await join(target.event, target.vault, bob, bobToken))
    success(await join(other.event, other.vault, alice, aliceToken))
    success(await cancel(target.event, target.vault))
    success(await cancel(other.event, other.vault))
    const aliceClaim = participationAddress(target.event, alice.publicKey)
    const bobClaim = participationAddress(target.event, bob.publicKey)
    const foreignClaim = participationAddress(other.event, alice.publicKey)
    const aliceBefore = tokenAmount(aliceToken)
    const obligation = PRICE * 2n

    rejected(await refund(target.event, target.vault, alice, aliceToken, { participation: bobClaim }), 'ConstraintSeeds')
    rejected(await refund(target.event, target.vault, alice, aliceToken, { participation: foreignClaim }), 'ConstraintSeeds')
    rejected(await refund(target.event, target.vault, alice, aliceToken, { vault: other.vault }), 'ConstraintHasOne')
    rejected(await refund(target.event, target.vault, alice, aliceToken, { mint: wrongMint }), 'WrongMint')
    expect(tokenAmount(aliceToken)).to.equal(aliceBefore)
    expect(tokenAmount(target.vault)).to.equal(obligation)
    expect(tokenAmount(other.vault)).to.equal(PRICE)
    expect(state(target.event).expectedEscrow.toString()).to.equal(obligation.toString())
    expect(state(target.event).refundedCount).to.equal(0)
    expect(participationState(aliceClaim).refunded).to.equal(false)
    expect(participationState(bobClaim).refunded).to.equal(false)

    const original = setTokenAmount(target.vault, obligation - 1n)
    rejected(await refund(target.event, target.vault, alice, aliceToken), 'VaultBelowObligation')
    expect(tokenAmount(target.vault)).to.equal(obligation - 1n)
    expect(tokenAmount(aliceToken)).to.equal(aliceBefore)
    expect(state(target.event).expectedEscrow.toString()).to.equal(obligation.toString())
    expect(state(target.event).refundedCount).to.equal(0)
    expect(state(target.event).status).to.deep.equal({ refundingCancelled: {} })
    expect(participationState(aliceClaim).refunded).to.equal(false)
    svm.setAccount(original)

    success(await refund(target.event, target.vault, alice, aliceToken))
    expect(tokenAmount(aliceToken) - aliceBefore).to.equal(PRICE)
    expect(state(target.event).expectedEscrow.toString()).to.equal(PRICE.toString())
    expect(participationState(aliceClaim).refunded).to.equal(true)
    success(await refund(target.event, target.vault, bob, bobToken))
    expect(tokenAmount(target.vault)).to.equal(0n)
    expect(state(target.event).expectedEscrow.toString()).to.equal('0')
    expect(state(target.event).status).to.deep.equal({ refunded: {} })
  })
})
