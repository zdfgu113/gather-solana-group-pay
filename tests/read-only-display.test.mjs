import assert from 'node:assert/strict'
import test from 'node:test'
import { Buffer } from 'node:buffer'
import BN from 'bn.js'
import { Program } from '@anchor-lang/core'
import { ACCOUNT_SIZE, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { Connection, PublicKey } from '@solana/web3.js'
import idl from '../src/idl/group_pay.devnet.json' with { type: 'json' }
import { handleReadOnlyEvent } from '../netlify/functions/read-event.mts'
import {
  DEVNET_MINT, DEVNET_PROGRAM_ID, DEVNET_PUBLIC_EVENTS,
} from '../src/devnet/public-events.ts'
import { readPublicEvent } from '../src/devnet/public-read.ts'

const PROGRAM = new PublicKey(DEVNET_PROGRAM_ID)
const MINT = new PublicKey(DEVNET_MINT)
const ORGANIZER = new PublicKey(Uint8Array.from({ length: 32 }, () => 32))
const PARTICIPANTS = [34, 35].map((byte) => new PublicKey(Uint8Array.from({ length: 32 }, () => byte)))
const coder = new Program(idl, { connection: new Connection('http://127.0.0.1:1') }).coder.accounts
const secret = 'fixture-secret-never-return'

function tokenData(owner, amount = 0n) {
  const data = Buffer.alloc(ACCOUNT_SIZE)
  MINT.toBuffer().copy(data, 0)
  owner.toBuffer().copy(data, 32)
  data.writeBigUInt64LE(amount, 64)
  data[108] = 1
  return data
}

const rpcAccount = (owner, data) => ({
  data: [Buffer.from(data).toString('base64'), 'base64'], executable: false,
  lamports: 1_000_000, owner: owner.toBase58(), rentEpoch: 0, space: data.length,
})

async function fixture(target, status = target.status) {
  const event = new PublicKey(target.event)
  const refunded = status === 'REFUNDED'
  const eventData = await coder.encode('event', {
    eventId: new BN(refunded ? 2 : 1), organizer: ORGANIZER,
    organizerTokenAccount: new PublicKey(target.payout), mint: MINT, vault: new PublicKey(target.vault),
    title: refunded ? 'Refunded public example' : 'Paid public example',
    description: 'Offline read-only display fixture', fulfillmentMode: { online: {} },
    venue: 'Online', timeZone: 'UTC', unitPrice: new BN(25_000_000), minWallets: 2, capacity: 2,
    registrationDeadline: new BN(1_790_000_000), eventStart: new BN(1_790_100_000),
    participantCount: 2, refundedCount: refunded ? 2 : 0, expectedEscrow: new BN(0),
    status: refunded ? { refunded: {} } : { paid: {} }, emptyCloseReason: { notClosed: {} }, bump: 1,
  })
  const participationData = await Promise.all(PARTICIPANTS.map((participant, index) => coder.encode('participation', {
    event, participant, paidAmount: new BN(25_000_000), joinedAt: new BN(1_789_000_000 + index),
    refunded, bump: 1,
  })))
  return {
    accounts: new Map([
      [target.event, rpcAccount(PROGRAM, eventData)],
      [target.vault, rpcAccount(TOKEN_PROGRAM_ID, tokenData(event))],
      [target.payout, rpcAccount(TOKEN_PROGRAM_ID, tokenData(ORGANIZER, 50_000_000n))],
    ]),
    participationData,
  }
}

async function mockedRuntime(target, options = {}) {
  const data = await fixture(target, options.status)
  const calls = []
  const fetcher = async (url, init) => {
    assert.match(String(url), /^https:\/\/devnet\.helius-rpc\.com\/\?api-key=/)
    const request = JSON.parse(init.body)
    calls.push(request)
    if (options.hang) return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })
    if (options.oversized) return new Response('{}', { headers: { 'content-length': '1000001' } })
    if (options.httpStatus) return new Response(JSON.stringify({ error: 'bounded fixture failure' }), { status: options.httpStatus })
    let result
    if (request.method === 'getAccountInfo') result = { context: { slot: 500 }, value: data.accounts.get(request.params[0]) ?? null }
    else if (request.method === 'getProgramAccounts') result = data.participationData.map((account, index) => ({
      pubkey: PARTICIPANTS[index].toBase58(), account: rpcAccount(PROGRAM, account),
    }))
    else if (request.method === 'getSlot') result = 500
    else if (request.method === 'getBlockTime') result = 1_790_395_000
    else throw new Error(`Unexpected method ${request.method}`)
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  return { runtime: { fetcher, readKey: () => secret, budgetMs: options.budgetMs ?? 1_000 }, calls }
}

const request = (event) => new Request(`https://preview.example/.netlify/functions/read-event?event=${event}`)

for (const [name, target] of Object.entries(DEVNET_PUBLIC_EVENTS)) test(`${name} display uses six fixed reads and returns validated data`, async () => {
  const { runtime, calls } = await mockedRuntime(target)
  const response = await handleReadOnlyEvent(request(target.event), runtime)
  const text = await response.text()
  const body = JSON.parse(text)
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.activity.id, target.event)
  assert.equal(body.activity.status, target.status)
  assert.equal(body.activity.mint, DEVNET_MINT)
  assert.equal(body.activity.participations.length, 2)
  assert.equal(body.observedSlot, 500)
  assert.equal(calls.length, 6)
  assert.deepEqual(calls.map(({ method }) => method).sort(), [
    'getAccountInfo', 'getAccountInfo', 'getAccountInfo', 'getBlockTime', 'getProgramAccounts', 'getSlot',
  ])
  assert.deepEqual(calls.filter(({ method }) => method === 'getAccountInfo').map(({ params }) => params[0]).sort(),
    [target.event, target.payout, target.vault].sort())
  assert.equal(calls.some(({ method }) => /send|transaction|airdrop|simulate/i.test(method)), false)
  assert.equal(text.includes(secret), false)
  assert.equal(text.includes('api-key='), false)
})

test('request shape and allowlist reject everything except one fixed Event', async () => {
  const { runtime, calls } = await mockedRuntime(DEVNET_PUBLIC_EVENTS.paid)
  assert.equal((await handleReadOnlyEvent(new Request('https://preview.example/.netlify/functions/read-event', { method: 'POST' }), runtime)).status, 405)
  assert.equal((await handleReadOnlyEvent(new Request('https://preview.example/.netlify/functions/read-event'), runtime)).status, 400)
  assert.equal((await handleReadOnlyEvent(new Request(`${request(DEVNET_PUBLIC_EVENTS.paid.event).url.replace('/.netlify/', '/extra/.netlify/')}`), runtime)).status, 400)
  assert.equal((await handleReadOnlyEvent(new Request(`${request(DEVNET_PUBLIC_EVENTS.paid.event).url}&extra=1`), runtime)).status, 400)
  assert.equal((await handleReadOnlyEvent(new Request(request(DEVNET_PUBLIC_EVENTS.paid.event), {
    headers: { 'content-length': '1' },
  }), runtime)).status, 413)
  assert.equal((await handleReadOnlyEvent({
    method: 'GET', headers: new Headers(), url: request(DEVNET_PUBLIC_EVENTS.paid.event).url,
    body: new ReadableStream(),
  }, runtime)).status, 413)
  assert.equal((await handleReadOnlyEvent(request(new PublicKey(new Uint8Array(32).fill(9)).toBase58()), runtime)).status, 404)
  assert.equal(calls.length, 0)
})

test('browser contract rejects an oversized display response before parsing it', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('x'.repeat(64_001), { status: 200 })
  try {
    await assert.rejects(readPublicEvent(DEVNET_PUBLIC_EVENTS.paid.event, new AbortController().signal), /PUBLIC_READ_INVALID_RESPONSE/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('wrong terminal state is not accepted as the fixed display Event', async () => {
  const { runtime } = await mockedRuntime(DEVNET_PUBLIC_EVENTS.paid, { status: 'REFUNDED' })
  const response = await handleReadOnlyEvent(request(DEVNET_PUBLIC_EVENTS.paid.event), runtime)
  assert.equal(response.status, 502)
  assert.equal((await response.json()).error, 'invalid_display_data')
})

test('upstream size and deadline fail once without retry or credential disclosure', async () => {
  const throttled = await mockedRuntime(DEVNET_PUBLIC_EVENTS.paid, { httpStatus: 429 })
  assert.equal((await handleReadOnlyEvent(request(DEVNET_PUBLIC_EVENTS.paid.event), throttled.runtime)).status, 502)
  assert.equal(throttled.calls.length, 1)

  const oversized = await mockedRuntime(DEVNET_PUBLIC_EVENTS.paid, { oversized: true })
  const oversizedResponse = await handleReadOnlyEvent(request(DEVNET_PUBLIC_EVENTS.paid.event), oversized.runtime)
  assert.equal(oversizedResponse.status, 502)
  assert.equal(oversized.calls.length, 1)

  const timed = await mockedRuntime(DEVNET_PUBLIC_EVENTS.paid, { hang: true, budgetMs: 20 })
  const timedResponse = await handleReadOnlyEvent(request(DEVNET_PUBLIC_EVENTS.paid.event), timed.runtime)
  const timedText = await timedResponse.text()
  assert.equal(timedResponse.status, 504)
  assert.equal(timed.calls.length, 1)
  assert.equal(timedText.includes(secret), false)
  assert.equal(timedText.includes('api-key='), false)
})
