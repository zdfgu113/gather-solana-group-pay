import { useEffect, useMemo, useRef, useState } from 'react'
import { ConnectionProvider, WalletProvider, useConnection, useWallet } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import App from '../App'
import type { Language } from '../copy'
import { initialActivity, validateCreate, type Action, type Activity, type DemoState, type Notice, type Operation } from '../simulation'
import { LOCAL_COPY } from '../local/copy'
import { DEVNET_COPY } from '../devnet/copy'
import { appendTransactionOnce, createPendingCheckGate } from '../local/pending-check'
import { tokenAccountFor, type ChainConfig } from './config'
import { clearCreateIntentIfSame, clearPendingIfSame, createIntent, readPending, savePending, samePending, withPendingLock } from './pending'
import {
  actionPrecondition, definitePreflightOutcome, prepareAction, readErrorNotice, readEvent,
  resolvePendingTransaction, rpcFailureKind,
  signAndBroadcast, type PendingTransaction,
} from './client'
import type { LocalAppBridge } from '../local/types'
import BN from 'bn.js'
import type { Adapter, WalletName } from '@solana/wallet-adapter-base'
import { readPublicEvent } from '../devnet/public-read'

type FixtureChoice = { name: WalletName<string>; address: string; rejectNext: () => void }
type Mode = 'local' | 'devnet'
type ModeProps = {
  config: ChainConfig; mode: Mode; adapters: Adapter[]; fixtureChoices?: FixtureChoice[]; fixturePayoutOptions?: string[]
  publicReader?: typeof readPublicEvent
}

const pendingKey = (config: ChainConfig) => config.cluster === 'localnet'
  ? 'gather-local-test-pending' : `gather-devnet-pending:${config.programId.toBase58()}`
const intentKey = (config: ChainConfig) => `gather-${config.cluster}-create-intent:${config.programId.toBase58()}`

function isSignatureRejection(error: unknown) { return /Fixture signature rejected|WalletSignTransactionError|User rejected|LOCAL_SIGNATURE_REJECTED/i.test(String(error)) }
function short(value: string) { return value.length > 18 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value }

function Controller({ config, mode, fixtureChoices = [], fixturePayoutOptions = [], publicReader = readPublicEvent }: ModeProps) {
  const { connection } = useConnection()
  const wallet = useWallet()
  const selected = fixtureChoices.find((item) => item.name === wallet.wallet?.adapter.name)
  const selectedAddress = mode === 'local' ? selected?.address ?? '' : wallet.wallet?.adapter.name ?? ''
  const walletAddress = wallet.publicKey?.toBase58() ?? ''
  const storeKey = pendingKey(config)
  const createKey = intentKey(config)
  const lockName = `gather-chain-action:${config.cluster}:${config.programId.toBase58()}`
  const stored = useMemo(() => readPending(localStorage, storeKey), [storeKey])
  const [state, setState] = useState<DemoState>(() => ({
    activity: { ...initialActivity(), id: 'CHAIN-NOT-LOADED', mint: config.mint.toBase58(), participations: [], transactions: [], vaultBalance: 0 },
    wallet: '', connected: false, wallets: fixtureChoices.map((item) => item.address),
    notice: { tone: 'info', key: 'localIntro' },
  }))
  const [loadedAddress, setLoadedAddress] = useState<string>()
  const [addressInput, setAddressInput] = useState(() => new URLSearchParams(location.search).get('event') ?? stored.record?.event ?? '')
  const [requestedAddress, setRequestedAddress] = useState(() => mode === 'devnet' ? new URLSearchParams(location.search).get('event') ?? '' : '')
  const [readStatus, setReadStatus] = useState<'loading' | 'failed' | 'idle'>(() => requestedAddress ? 'loading' : 'idle')
  const readInFlight = useRef(false)
  const [pending, setPending] = useState(stored.record)
  const [pendingInvalid, setPendingInvalid] = useState(stored.invalid)
  const pendingRef = useRef(pending)
  const checkPending = useMemo(() => createPendingCheckGate<PendingTransaction>(() => pendingRef.current), [])
  const busyRef = useRef(false)
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState(false)
  function isCurrentRecord(record: PendingTransaction | null) { return pendingRef.current === record }

  function notice(key: string, tone: Notice['tone'] = 'info', values?: Notice['values']) {
    setState((previous) => ({ ...previous, notice: { key, tone, values } }))
  }
  function setPendingRecord(value: PendingTransaction | null) {
    pendingRef.current = value
    setPending(value)
  }
  function setVerified(activity: Activity, message?: Notice) {
    setLoadedAddress(activity.id)
    setAddressInput(activity.id)
    setStale(false)
    setState((previous) => ({
      ...previous,
      activity: { ...activity, transactions: previous.activity.id === activity.id ? previous.activity.transactions : [] },
      notice: message ?? previous.notice,
    }))
    const url = new URL(location.href)
    url.searchParams.set('event', activity.id)
    history.replaceState(null, '', url)
  }
  async function refresh(address = loadedAddress ?? requestedAddress, announce = true) {
    if (!address) { notice('localNoEvent', 'error'); return null }
    if (mode === 'devnet' && readInFlight.current) return null
    if (mode === 'devnet') readInFlight.current = true
    if (mode === 'devnet') { setRequestedAddress(address); setReadStatus('loading') }
    const controller = mode === 'devnet' ? new AbortController() : null
    let timeout: number | undefined
    try {
      let publicKey: PublicKey
      try { publicKey = new PublicKey(address) } catch { throw new Error('EVENT_ADDRESS_INVALID') }
      // Only the two reviewed public examples use the bounded display endpoint. Transaction reads stay on `connection`.
      const reading = controller
        ? publicReader(publicKey.toBase58(), controller.signal)
        : readEvent(connection, config, publicKey)
      const activity = controller ? await Promise.race([reading, new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => {
          controller.abort()
          reject(new Error('Public read timed out'))
        }, 15_000)
      })]) : await reading
      setVerified(activity, announce ? { tone: 'success', key: 'localLoaded', values: { address: short(address) } } : undefined)
      if (mode === 'devnet') setReadStatus('idle')
      return activity
    } catch (error) {
      setStale(true)
      if (mode === 'devnet') setReadStatus('failed')
      const key = /PUBLIC_READ_UNSUPPORTED/.test(String(error)) ? 'localPublicUnsupported'
        : /PUBLIC_READ_(?:UNAVAILABLE|INVALID_RESPONSE)/.test(String(error)) ? 'localPublicUnavailable'
          : readErrorNotice(error, controller?.signal.aborted)
      notice(key, 'error')
      return null
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout)
      if (mode === 'devnet') readInFlight.current = false
    }
  }

  useEffect(() => {
    setState((previous) => ({ ...previous, wallet: walletAddress, connected: wallet.connected }))
  }, [walletAddress, wallet.connected])
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== storeKey) return
      const next = readPending(localStorage, storeKey)
      setPendingInvalid(next.invalid)
      if (!samePending(pendingRef.current, next.record)) setPendingRecord(next.record)
    }
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [storeKey])
  useEffect(() => {
    const address = new URLSearchParams(location.search).get('event')
    if (address) void refresh(address)
    // An explicitly selected chain mode may restore a public Event address, never auto-connect a wallet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function finishPending(record: PendingTransaction) {
    await checkPending(record, async () => {
      return resolvePendingTransaction(connection, config, record)
    }, async (outcome) => {
      if (!outcome.ok) {
        setStale(true)
        notice(rpcFailureKind(outcome.error) ? 'localUnknown' : 'localReadFailed', 'error', { signature: short(record.signature) })
        return
      }
      const result = outcome.value
      if (result.kind === 'unknown') { notice('localUnknown', 'error', { signature: short(record.signature) }); return }
      if (result.kind === 'expired-check') { notice('localExpired', 'error', { signature: short(record.signature) }); return }
      await withPendingLock(lockName, async () => {
        if (!isCurrentRecord(record) || !clearPendingIfSame(localStorage, storeKey, record)) return
        setPendingRecord(null)
        if (result.kind.startsWith('confirmed') && record.operation === 'CREATE' && record.eventId) {
          clearCreateIntentIfSame(localStorage, createKey, record.eventId)
        }
        if ('activity' in result && result.activity) setVerified(result.activity)
        if (result.kind === 'failed') {
          if (!result.activity) setStale(true)
          notice('localFailed', 'error')
          return
        }
        if (result.kind === 'confirmed-unread') {
          setStale(true)
          setAddressInput(record.event)
          if (mode === 'devnet') {
            setRequestedAddress(record.event)
            setReadStatus('failed')
            const url = new URL(location.href)
            url.searchParams.set('event', record.event)
            history.replaceState(null, '', url)
          }
          notice('localConfirmedUnread', 'error', { signature: short(record.signature) })
          return
        }
        if (result.kind === 'confirmed-mismatch') {
          notice('localConfirmedMismatch', 'error', { signature: short(record.signature) })
          return
        }
        const activity = result.activity
        const operation = record.operation as Operation
        setState((previous) => previous.activity.id !== record.event ? previous : ({ ...previous, activity: {
          ...previous.activity,
          transactions: appendTransactionOnce(previous.activity.transactions, {
            id: record.signature, activityId: record.event, operation,
            actor: record.actor || record.participant || previous.activity.organizer,
            amount: record.operation === 'JOIN' || record.operation === 'REFUND' ? activity.price :
              record.operation === 'SETTLE' ? activity.price * activity.participations.length : 0,
            createdAt: activity.simulatedNow,
          }),
        } }))
        notice(record.operation === 'CLOSE_PAYOUT' ? 'localPayoutClosed' : 'localConfirmed', 'success', {
          signature: short(record.signature), action: record.operation,
        })
      })
    })
  }

  async function runTransaction(action: Action) {
    const existing = readPending(localStorage, storeKey)
    if (busyRef.current || pendingRef.current || pendingInvalid || existing.invalid || existing.record) {
      notice('localUnknown', 'error', { signature: short(existing.record?.signature ?? pendingRef.current?.signature ?? '') })
      return
    }
    const actor = wallet.publicKey
    const signTransaction = wallet.signTransaction
    if (!wallet.connected || !actor || !signTransaction) { notice('localWalletRequired', 'error'); return }
    if (action.type !== 'CREATE' && !loadedAddress) { notice('localNoEvent', 'error'); return }
    if (mode === 'devnet' && (!config.expectedGenesisHash || !config.rpcUrl.startsWith('https://'))) {
      notice('localConfigMissing', 'error'); return
    }
    busyRef.current = true
    setBusy(true)
    const signedRecord: { current: PendingTransaction | null } = { current: null }
    try {
      const record = await withPendingLock(lockName, async () => {
        const latest = readPending(localStorage, storeKey)
        if (latest.invalid || latest.record) throw new Error('PENDING_ALREADY_EXISTS')
        let current = loadedAddress ? state.activity : undefined
        if (action.type === 'CREATE') {
          const result = validateCreate(action.input, Date.now())
          if (result) { notice(result, 'error'); return null }
        } else {
          current = await readEvent(connection, config, new PublicKey(loadedAddress!))
          setVerified(current)
          const invalid = actionPrecondition(current, action, actor.toBase58())
          if (invalid) { notice(invalid, 'error'); return null }
        }
        if (action.type === 'CLOSE_PAYOUT' && (mode !== 'local' || current?.organizer !== actor.toBase58())) {
          notice('localNoPayoutClose', 'error'); return null
        }
        const intent = action.type === 'CREATE'
          ? createIntent(localStorage, createKey, config, actor.toBase58(), action.input) : null
        const prepared = await prepareAction(connection, config, action, current,
          actor, intent ? new BN(intent.eventId) : undefined)
        return signAndBroadcast(connection, config, prepared, {
          publicKey: actor, signTransaction: (transaction) => signTransaction(transaction),
        }, (signed) => {
          if (!savePending(localStorage, storeKey, signed)) throw new Error('PENDING_ALREADY_EXISTS')
          signedRecord.current = signed
          setPendingRecord(signed)
        })
      })
      if (record === undefined) { notice('localAnotherTab', 'error'); return }
      if (record === null) return
      if (!isCurrentRecord(record)) return
      notice('localPending', 'info', { signature: short(record.signature) })
      await finishPending(record)
    } catch (error) {
      const record = signedRecord.current
      if (record && !isCurrentRecord(record)) return
      if (record) {
        try {
          const preflight = await definitePreflightOutcome(connection, record, error)
          if (preflight === 'status-found') { await finishPending(record); return }
          if (preflight === 'rejected') {
            let activity: Activity | null = null
            if (record.operation !== 'CREATE') {
              try { activity = await readEvent(connection, config, new PublicKey(record.event)) } catch { /* Rejection is already conclusive. */ }
            }
            await withPendingLock(lockName, async () => {
              if (!isCurrentRecord(record) || !clearPendingIfSame(localStorage, storeKey, record)) return
              setPendingRecord(null)
              if (activity) setVerified(activity)
              else if (record.operation !== 'CREATE') setStale(true)
              notice('localPreflightRejected', 'error')
            })
            return
          }
        } catch { /* Unknown signed result remains pending. */ }
        // Once signed, network and blockhash errors may race with a broadcast: keep the record.
        notice('localUnknown', 'error', { signature: short(record.signature) })
      } else if (String(error).includes('PENDING_ALREADY_EXISTS')) {
        const latest = readPending(localStorage, storeKey)
        if (latest.record) setPendingRecord(latest.record)
        notice('localUnknown', 'error', { signature: short(latest.record?.signature ?? '') })
      } else if (String(error).includes('LOCAL_BALANCE_INSUFFICIENT')) notice('localInsufficient', 'error')
      else if (String(error).includes('PAYOUT_ACCOUNT_SAME')) notice('payoutAccountSame', 'error')
      else if (String(error).includes('PAYOUT_ACCOUNT_INVALID')) notice('payoutAccountInvalid', 'error')
      else if (isSignatureRejection(error)) notice('localRejected', 'error')
      else if (rpcFailureKind(error)) { setStale(true); notice(readErrorNotice(error), 'error') }
      else if (/EVENT_ACCOUNT_/.test(String(error))) { setStale(true); notice(readErrorNotice(error), 'error') }
      else notice('localReadFailed', 'error')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  function send(action: Action) {
    if (action.type === 'CONNECT') {
      if (!wallet.wallet) { notice('localWalletRequired', 'error'); return }
      void (wallet.connected ? wallet.disconnect() : wallet.connect())
        .then(() => notice(wallet.connected ? 'localDisconnected' : 'localConnected'))
        .catch(() => notice('localRejected', 'error'))
      return
    }
    if (action.type === 'SELECT_WALLET') {
      const adapter = mode === 'local'
        ? fixtureChoices.find((item) => item.address === action.wallet)?.name
        : wallet.wallets.find((item) => item.adapter.name === action.wallet)?.adapter.name
      if (!adapter) { notice('unknownWallet', 'error'); return }
      wallet.select(adapter)
      notice('localWalletSelected')
      return
    }
    if (action.type === 'CLOSE_PAYOUT' || action.type === 'CREATE' || action.type === 'JOIN' ||
      action.type === 'SETTLE' || action.type === 'FINALIZE' || action.type === 'CANCEL' ||
      action.type === 'REFUND' || action.type === 'UPDATE_PAYOUT') void runTransaction(action)
  }

  const payoutOptions = mode === 'devnet' ? [] : !loadedAddress ? fixturePayoutOptions
    : mode === 'local' && fixturePayoutOptions.includes(state.activity.organizerTokenAccount)
      ? fixturePayoutOptions
      : [state.activity.organizerTokenAccount, wallet.publicKey ? tokenAccountFor(config, wallet.publicKey).toBase58() : ''].filter(Boolean)
  const controls = (language: Language) => {
    const l = mode === 'devnet' ? DEVNET_COPY[language] : LOCAL_COPY[language]
    return <details className="demo-tools local-tools" open>
    <summary>{l.controls}<span aria-hidden="true">＋</span></summary>
    <div className="demo-body"><p>{l.controlsHelp}</p>
      <div className="demo-control-row"><label>{l.wallet}
        <select value={selectedAddress} disabled={busy || Boolean(pending)} onChange={(event) => send({ type: 'SELECT_WALLET', wallet: event.target.value })} data-testid="local-wallet-select">
          <option value="">{l.chooseWallet}</option>
          {mode === 'local' ? fixtureChoices.map((item) => <option key={item.name} value={item.address}>{item.name} · {short(item.address)}</option>)
            : wallet.wallets.map((item) => <option key={item.adapter.name} value={item.adapter.name}>{item.adapter.name}</option>)}
        </select></label>
        <button type="button" disabled={busy || Boolean(pending)} onClick={() => send({ type: 'CONNECT' })} data-testid="local-connect">{wallet.connected ? l.disconnect : l.connect}</button>
      </div>
      <div className="demo-control-row"><label>{l.address}<input value={addressInput} onChange={(event) => setAddressInput(event.target.value)} data-testid="local-event-address" /></label>
        <button type="button" onClick={() => void refresh(addressInput)} data-testid="local-load">{l.load}</button>
        <button type="button" onClick={() => void refresh()} data-testid="local-refresh">{l.refresh}</button>
      </div>
      <div className="demo-actions">
        {mode === 'local' && <button type="button" onClick={() => { selected?.rejectNext(); notice('localRejectArmed') }} data-testid="local-reject-next">{l.rejectNext}</button>}
        {mode === 'local' && <button type="button" onClick={() => send({ type: 'CLOSE_PAYOUT' })} data-testid="local-close-payout">{l.closePayout}</button>}
        {pending && <button type="button" onClick={() => void finishPending(pending)} data-testid="local-recheck">{l.recheck}</button>}
      </div>
      {stale && loadedAddress && <p className="local-stale" role="status">{l.stale}</p>}
      {pending && <p className="local-pending" role="status">{(busy ? l.messages.localPending : l.messages.localUnknown).replace('{signature}', short(pending.signature))}</p>}
      {pendingInvalid && <p className="local-pending" role="alert">{l.messages.localInvalidPending}</p>}
    </div>
  </details>
  }

  const bridge: LocalAppBridge = {
    mode, state, send, address: loadedAddress, busy, pending: Boolean(pending) || pendingInvalid,
    requestedAddress: mode === 'devnet' ? requestedAddress : undefined,
    readStatus: mode === 'devnet' ? readStatus : undefined,
    retryRead: mode === 'devnet' ? () => { void refresh(requestedAddress) } : undefined,
    createPayout: wallet.publicKey ? tokenAccountFor(config, wallet.publicKey).toBase58() : '',
    payoutOptions, controls,
  }
  return <App bridge={bridge} />
}

export default function ChainMode(props: ModeProps) {
  return <ConnectionProvider endpoint={props.config.rpcUrl} config={{ commitment: 'confirmed' }}>
    <WalletProvider wallets={props.adapters} autoConnect={false} onError={() => { /* Per-action errors are handled in the controller. */ }}>
      <Controller {...props} />
    </WalletProvider>
  </ConnectionProvider>
}
