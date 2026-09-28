import { Buffer } from 'node:buffer'
import { Connection, PublicKey } from '@solana/web3.js'
import { readEvent, vaultAddress } from '../../src/chain/client.ts'
import type { ChainConfig } from '../../src/chain/config.ts'
import { validatePublicActivity } from '../../src/devnet/public-read.ts'
import {
  DEVNET_GENESIS, DEVNET_MINT, DEVNET_MINT_AUTHORITY, DEVNET_PROGRAM_ID,
  devnetPublicEvent, type DevnetPublicEvent,
} from '../../src/devnet/public-events.ts'

declare const Netlify: { env: { get(name: string): string | undefined } }

const MAX_REQUEST_URL_BYTES = 512
const MAX_RPC_REQUEST_BYTES = 4_096
const MAX_UPSTREAM_BYTES = 1_000_000
const MAX_DISPLAY_BYTES = 64_000
const READ_BUDGET_MS = 12_000

const CONFIG: ChainConfig = {
  cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com/',
  programId: new PublicKey(DEVNET_PROGRAM_ID), mint: new PublicKey(DEVNET_MINT),
  mintAuthority: new PublicKey(DEVNET_MINT_AUTHORITY), expectedGenesisHash: DEVNET_GENESIS,
}

class ReadFailure extends Error {
  readonly kind: string
  constructor(kind: string) { super(kind); this.kind = kind }
}

type Runtime = {
  fetcher: typeof fetch
  readKey: () => string | undefined
  budgetMs?: number
}

type RpcRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
type RpcState = { seen: Set<string>; bytes: number; slot?: number }

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join('|') === [...keys].sort().join('|')
}

function confirmedBase64(value: unknown) {
  return record(value) && exactKeys(value, ['commitment', 'encoding']) &&
    value.commitment === 'confirmed' && value.encoding === 'base64'
}

function allowRpcCall(request: RpcRequest, target: DevnetPublicEvent, state: RpcState) {
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string' || !Array.isArray(request.params)) {
    throw new ReadFailure('unexpected_rpc_request')
  }
  const params = request.params
  let key = request.method
  if (request.method === 'getAccountInfo') {
    if (params.length !== 2 || typeof params[0] !== 'string' || !confirmedBase64(params[1]) ||
      !([target.event, target.vault, target.payout] as readonly string[]).includes(params[0])) {
      throw new ReadFailure('unexpected_rpc_request')
    }
    key += `:${params[0]}`
  } else if (request.method === 'getProgramAccounts') {
    const config = params[1]
    const filters = record(config) ? config.filters : null
    if (params.length !== 2 || params[0] !== DEVNET_PROGRAM_ID || !record(config) ||
      !exactKeys(config, ['commitment', 'encoding', 'filters']) || config.commitment !== 'confirmed' ||
      config.encoding !== 'base64' || !Array.isArray(filters) || filters.length !== 2 ||
      !record(filters[0]) || filters[0].dataSize !== 90 || !record(filters[1]) ||
      !record(filters[1].memcmp) || filters[1].memcmp.offset !== 8 || filters[1].memcmp.bytes !== target.event) {
      throw new ReadFailure('unexpected_rpc_request')
    }
  } else if (request.method === 'getSlot') {
    if (params.length !== 1 || !record(params[0]) || !exactKeys(params[0], ['commitment']) ||
      params[0].commitment !== 'confirmed') throw new ReadFailure('unexpected_rpc_request')
  } else if (request.method === 'getBlockTime') {
    if (params.length !== 1 || !Number.isSafeInteger(params[0]) || params[0] !== state.slot) {
      throw new ReadFailure('unexpected_rpc_request')
    }
  } else throw new ReadFailure('unexpected_rpc_method')
  if (state.seen.has(key) || state.seen.size >= 6) throw new ReadFailure('duplicate_or_excess_rpc_request')
  state.seen.add(key)
}

async function limitedText(response: Response, state: RpcState) {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_UPSTREAM_BYTES)) {
    throw new ReadFailure('oversized_upstream_response')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let body = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    state.bytes += value.byteLength
    if (state.bytes > MAX_UPSTREAM_BYTES) {
      await reader.cancel()
      throw new ReadFailure('oversized_upstream_response')
    }
    body += decoder.decode(value, { stream: true })
  }
  return body + decoder.decode()
}

function guardedFetch(endpoint: string, target: DevnetPublicEvent, deadline: number, signal: AbortSignal,
  runtime: Runtime, state: RpcState): typeof fetch {
  return async (_input, init) => {
    if (Date.now() >= deadline) throw new ReadFailure('timeout')
    if (typeof init?.body !== 'string' || Buffer.byteLength(init.body) > MAX_RPC_REQUEST_BYTES) {
      throw new ReadFailure('unexpected_rpc_request')
    }
    let request: RpcRequest
    try { request = JSON.parse(init.body) } catch { throw new ReadFailure('unexpected_rpc_request') }
    allowRpcCall(request, target, state)
    let response: Response
    try {
      response = await runtime.fetcher(endpoint, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: init.body,
        redirect: 'error', signal,
      })
    } catch (error) {
      if (signal.aborted || error instanceof ReadFailure && error.kind === 'timeout') throw new ReadFailure('timeout')
      // Fetch errors can include the credential URL. Never serialize their message or cause.
      throw new ReadFailure('network_or_invalid_response')
    }
    const body = await limitedText(response, state)
    let json: { result?: unknown; error?: unknown }
    try { json = JSON.parse(body) } catch { throw new ReadFailure('invalid_upstream_response') }
    if (!response.ok) throw new ReadFailure('upstream_http')
    if (json.error || !Object.hasOwn(json, 'result')) throw new ReadFailure('upstream_rpc')
    if (request.method === 'getSlot') {
      if (!Number.isSafeInteger(json.result) || Number(json.result) <= 0) throw new ReadFailure('invalid_upstream_response')
      state.slot = Number(json.result)
    }
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  let text = JSON.stringify(body)
  if (Buffer.byteLength(text) > MAX_DISPLAY_BYTES) {
    status = 502
    text = JSON.stringify({ schema: 1, ok: false, error: 'oversized_display_response' })
  }
  return new Response(text, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', ...extraHeaders,
    },
  })
}

export async function handleReadOnlyEvent(request: Request, runtime: Runtime) {
  if (request.method !== 'GET') return json({ schema: 1, ok: false, error: 'method_not_allowed' }, 405, { allow: 'GET' })
  const contentLength = request.headers.get('content-length')
  if (request.body !== null || Buffer.byteLength(request.url) > MAX_REQUEST_URL_BYTES ||
    contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > 0)) {
    return json({ schema: 1, ok: false, error: 'request_too_large' }, 413)
  }
  const url = new URL(request.url)
  if (url.pathname !== '/.netlify/functions/read-event' || [...url.searchParams.keys()].join('|') !== 'event' ||
    url.searchParams.getAll('event').length !== 1) return json({ schema: 1, ok: false, error: 'invalid_request' }, 400)
  const target = devnetPublicEvent(url.searchParams.get('event') ?? '')
  if (!target) return json({ schema: 1, ok: false, error: 'unsupported_event' }, 404)
  if (vaultAddress(CONFIG, new PublicKey(target.event)).toBase58() !== target.vault) {
    return json({ schema: 1, ok: false, error: 'invalid_fixed_configuration' }, 500)
  }
  const key = runtime.readKey()
  if (!key || /[\s/?&#:]/.test(key)) return json({ schema: 1, ok: false, error: 'read_service_not_configured' }, 503)

  const controller = new AbortController()
  const budget = runtime.budgetMs ?? READ_BUDGET_MS
  const deadline = Date.now() + budget
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new ReadFailure('timeout')) }, budget)
  })
  const state: RpcState = { seen: new Set(), bytes: 0 }
  try {
    const endpoint = `https://devnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`
    const connection = new Connection('https://readonly.invalid/', {
      commitment: 'confirmed', disableRetryOnRateLimit: true,
      fetch: guardedFetch(endpoint, target, deadline, controller.signal, runtime, state),
    })
    const activity = validatePublicActivity(await Promise.race([
      readEvent(connection, CONFIG, new PublicKey(target.event)), timeout,
    ]), target)
    if (Date.now() > deadline || state.seen.size !== 6) throw new ReadFailure('incomplete_or_late_read')
    return json({ schema: 1, ok: true, checkedAtUtc: new Date().toISOString(), observedSlot: state.slot, activity })
  } catch (error) {
    const failure = controller.signal.aborted ? 'timeout'
      : error instanceof ReadFailure ? error.kind : 'invalid_display_data'
    return json({ schema: 1, ok: false, error: failure }, failure === 'timeout' ? 504 : 502)
  } finally {
    clearTimeout(timer!)
  }
}

export default (request: Request) => handleReadOnlyEvent(request, {
  fetcher: (input, init) => fetch(input, init),
  readKey: () => Netlify.env.get('HELIUS_DEVNET_API_KEY'),
})
