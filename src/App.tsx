import { useEffect, useRef, useState, type FormEvent } from 'react'
import { COPY, formatDate, phrase, type Language } from './copy'
import { DEFAULT_TIME_ZONE, localToZonedIso, SUPPORTED_TIME_ZONES, utcOffsetAt, zonedInputTime } from './time-zones'
import { LOCAL_COPY } from './local/copy'
import { DEVNET_COPY } from './devnet/copy'
import type { LocalAppBridge } from './local/types'
import {
  CLASSIC_TOKEN_PROGRAM, initialDemoState, isAfterDeadline,
  obligation, payoutAccountFor, refundPending, transition,
  type Action, type Activity, type CreateInput, type DemoState, type Operation,
} from './simulation'

type Page = 'detail' | 'manage' | 'create' | 'read'
const PHOTO_URL = 'https://unsplash.com/photos/hands-shape-a-clay-pot-on-a-pottery-wheel-BFBikYWtA9c'

function savedLanguage(): Language {
  try { return localStorage.getItem('gather-language') === 'zh' ? 'zh' : 'en' } catch { return 'en' }
}

function App({ bridge }: { bridge?: LocalAppBridge }) {
  const [language, setLanguage] = useState<Language>(savedLanguage)
  const [page, setPage] = useState<Page>(bridge?.mode === 'devnet' && bridge.requestedAddress && !bridge.address ? 'read' : bridge && !bridge.address ? 'create' : 'detail')
  const [simulation, setSimulation] = useState<DemoState>(initialDemoState)
  const demo = bridge?.state ?? simulation
  const local = Boolean(bridge)
  const l = bridge?.mode === 'devnet' ? DEVNET_COPY[language] : LOCAL_COPY[language]
  const txLocked = Boolean(bridge?.busy || bridge?.pending)
  const [menuOpen, setMenuOpen] = useState(false)
  const [payoutChoice, setPayoutChoice] = useState(bridge?.mode === 'devnet' ? '' : payoutAccountFor(demo.activity.organizer, 2))
  const [createZone, setCreateZone] = useState(DEFAULT_TIME_ZONE)
  const [deadlineLocal, setDeadlineLocal] = useState(() => zonedInputTime(new Date(Date.now() + 7 * 86400000), DEFAULT_TIME_ZONE))
  const [startLocal, setStartLocal] = useState(() => zonedInputTime(new Date(Date.now() + 9 * 86400000), DEFAULT_TIME_ZONE))
  const [wallNow, setWallNow] = useState(Date.now)
  const languageRef = useRef<HTMLDivElement>(null)
  const firstLanguageRef = useRef<HTMLButtonElement>(null)
  const cancelDialogRef = useRef<HTMLDialogElement>(null)
  const t = COPY[language]
  const activity = demo.activity
  const count = activity.participations.length
  const due = obligation(activity)
  const surplus = activity.vaultBalance >= due ? activity.vaultBalance - due : null
  const afterDeadline = bridge?.mode === 'devnet' ? wallNow >= Date.parse(activity.registrationDeadline) : isAfterDeadline(activity)
  const participation = activity.participations.find((item) => item.wallet === demo.wallet)
  const refunding = activity.status === 'REFUNDING_FAILED' || activity.status === 'REFUNDING_CANCELLED'
  const canCancel = demo.connected && demo.wallet === activity.organizer && activity.status === 'OPEN' && !afterDeadline
  const canUpdatePayout = demo.connected && demo.wallet === activity.organizer && (activity.status === 'OPEN' || activity.status === 'READY')
  const noticeValues = { ...demo.notice.values }
  if (local && typeof noticeValues.action === 'string') noticeValues.action = t.operation[noticeValues.action as Operation] ?? noticeValues.action
  const noticeText = phrase((local ? l.messages[demo.notice.key as keyof typeof l.messages] : undefined) ??
    t.messages[demo.notice.key as keyof typeof t.messages] ?? t.messages.intro, noticeValues)
  const deadlineIso = localToZonedIso(deadlineLocal, createZone)
  const startIso = localToZonedIso(startLocal, createZone)
  const zoneLabel = (iso: string) => `${activity.timeZone} (${utcOffsetAt(iso, activity.timeZone)})`

  const send = (action: Action) => bridge ? bridge.send(action) : setSimulation((previous) => transition(previous, action))

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
    document.title = `${t.brand} · ${t.details}`
    try { localStorage.setItem('gather-language', language) } catch { /* Language still works for this visit. */ }
  }, [language, t.brand, t.details])

  useEffect(() => { setPage(bridge?.mode === 'devnet' && bridge.requestedAddress && !bridge.address ? 'read' : bridge && !bridge.address ? 'create' : 'detail') }, [activity.id, bridge?.address, bridge?.requestedAddress])
  useEffect(() => { setPayoutChoice(bridge?.mode === 'devnet' ? '' : bridge?.payoutOptions[1] ?? payoutAccountFor(activity.organizer, 2)) }, [activity.organizer, activity.id, bridge?.mode, bridge?.payoutOptions.join('|')])
  useEffect(() => {
    if (bridge?.mode !== 'devnet' || activity.status !== 'OPEN') return
    const timer = window.setInterval(() => setWallNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [bridge, activity.status, activity.registrationDeadline])
  useEffect(() => {
    if (!menuOpen) return
    firstLanguageRef.current?.focus()
    const closeOutside = (event: PointerEvent) => { if (!languageRef.current?.contains(event.target as Node)) setMenuOpen(false) }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [menuOpen])

  function changePage(next: Page) {
    setPage(next)
    setMenuOpen(false)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }

  function changeLanguage(next: Language) {
    setLanguage(next)
    setMenuOpen(false)
    requestAnimationFrame(() => languageRef.current?.querySelector('button')?.focus())
  }

  function createEvent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const input: CreateInput = {
      title: String(form.get('title') ?? ''),
      description: String(form.get('description') ?? ''),
      price: Number(form.get('price')),
      minWallets: Number(form.get('minWallets')),
      capacity: Number(form.get('capacity')),
      registrationDeadline: deadlineIso,
      eventStart: startIso,
      timeZone: createZone,
      fulfillmentMode: String(form.get('fulfillmentMode')) as CreateInput['fulfillmentMode'],
      venue: String(form.get('venue') ?? ''),
    }
    send({ type: 'CREATE', input, now: new Date().toISOString() })
  }

  function primaryAction() {
    if (!demo.connected) return { label: local ? l.connect : t.connect, run: () => send({ type: 'CONNECT' }) }
    if (activity.status === 'OPEN' && !afterDeadline && !participation) return { label: t.join, run: () => send({ type: 'JOIN' }) }
    if (activity.status === 'READY') return { label: t.settle, run: () => send({ type: 'SETTLE' }) }
    if (activity.status === 'OPEN' && afterDeadline) return { label: t.finalize, run: () => send({ type: 'FINALIZE' }) }
    if (refunding && participation && !participation.refundedAt && !participation.refunded) return { label: t.claimRefund, run: () => send({ type: 'REFUND' }) }
    return { label: refunding || activity.status === 'REFUNDED' ? t.viewRefund : t.viewEvent, run: () => document.getElementById(refunding || activity.status === 'REFUNDED' ? 'transactions' : 'event-facts')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }
  }

  const primary = primaryAction()
  const status = t.status[activity.status]
  const personal = !participation ? t.notJoined : participation.refundedAt || participation.refunded ? t.claimed : refunding ? t.claimable : activity.status === 'PAID' ? t.paidPersonal : t.joined
  const personalShort = !participation ? t.notJoinedShort : participation.refundedAt || participation.refunded ? t.claimedShort : refunding ? t.claimableShort : activity.status === 'PAID' ? t.paidShort : t.joinedShort

  return <div className="site-shell">
    <header className="product-header glass">
      <div className="header-inner">
        <button className="wordmark" type="button" onClick={() => changePage(bridge?.mode === 'devnet' && bridge.requestedAddress && !bridge.address ? 'read' : local && !bridge?.address ? 'create' : 'detail')} aria-label={t.details}><span className="wordmark-icon" aria-hidden="true"><img src="/gather-logo.png" alt="" width="38" height="38" /></span><strong>{t.brand}</strong><span className="demo-pill">{local ? l.badge : t.demoBadge}</span></button>
        <nav className="product-nav" aria-label={t.details}>
          <button className={page === 'detail' ? 'is-active' : ''} type="button" disabled={local && !bridge?.address} onClick={() => changePage('detail')}>{t.details}</button>
          <button className={page === 'manage' ? 'is-active' : ''} type="button" disabled={local && !bridge?.address} onClick={() => changePage('manage')}>{t.manage}</button>
          <button className={page === 'create' ? 'is-active' : ''} type="button" onClick={() => changePage('create')}>{t.create}</button>
        </nav>
        <div className="header-actions">
          <div className="language-control" ref={languageRef} onKeyDown={(event) => { if (event.key === 'Escape') { setMenuOpen(false); (event.currentTarget.querySelector('.language-button') as HTMLButtonElement)?.focus() } }}>
            <button className="language-button" type="button" aria-label={`${t.language}: ${language === 'en' ? t.english : t.chinese}`} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><span aria-hidden="true">◎</span><span>{language === 'en' ? t.english : t.chinese}</span><span aria-hidden="true">⌄</span></button>
            {menuOpen && <div className="language-menu glass" role="menu" aria-label={t.language}>
              <button ref={firstLanguageRef} role="menuitemradio" aria-checked={language === 'en'} type="button" onClick={() => changeLanguage('en')}>{t.english}<span>{language === 'en' ? '✓' : ''}</span></button>
              <button role="menuitemradio" aria-checked={language === 'zh'} type="button" onClick={() => changeLanguage('zh')}>{t.chinese}<span>{language === 'zh' ? '✓' : ''}</span></button>
            </div>}
          </div>
          <button className="identity-button" type="button" onClick={() => send({ type: 'CONNECT' })} data-testid="wallet-button" aria-label={demo.connected ? `${local ? l.disconnect : t.disconnect}: ${demo.wallet}` : local ? l.connect : t.connect}>{demo.connected ? <><span className="identity-dot" /><span className="identity-name" title={demo.wallet}>{local ? shortAddress(demo.wallet) : demo.wallet}</span></> : <><span className="identity-label-full">{local ? l.connect : t.connect}</span><span className="identity-label-short">{t.connectShort}</span></>}</button>
        </div>
      </div>
    </header>

    <div className="demo-banner" role="note"><strong>{local ? l.badge : t.demoBadge}</strong><span>{local ? l.notice : t.demoNotice}</span></div>
    {page === 'read' && bridge?.mode === 'devnet' && <main className="create-page" id="main" data-testid="event-read-status" aria-live="polite"><header><span className="section-kicker">{DEVNET_COPY[language].event}</span><h1>{bridge.readStatus === 'failed' ? DEVNET_COPY[language].readFailedTitle : DEVNET_COPY[language].readLoadingTitle}</h1><p>{bridge.readStatus === 'failed' ? DEVNET_COPY[language].readFailedHelp : DEVNET_COPY[language].readLoadingHelp}</p></header><div className="create-form"><section className="form-section"><h2>{DEVNET_COPY[language].readAddress}</h2><p className="read-address">{bridge.requestedAddress}</p>{bridge.readStatus === 'failed' && <><ActionResult demo={demo} text={noticeText} label={t.result} /><button className="small-primary" type="button" onClick={bridge.retryRead} data-testid="event-read-retry">{DEVNET_COPY[language].readRetry}</button></>}</section></div></main>}
    {bridge && !bridge.address && bridge.controls(language)}

    {page === 'detail' && <main className="detail-layout" id="main">
      <div className="detail-main">
        <Cover activity={activity} language={language} />
        <div className="event-heading"><div className="eyebrow"><span>{local ? l.event : t.sampleEvent}</span><StatusBadge status={activity.status} label={status} /></div><h1>{activity.title}</h1><p>{activity.description}</p><small>{t.organizerContent}</small></div>
        <EventFacts activity={activity} language={language} />
        <section className="group-card mobile-only" aria-label={t.progress}>
          <div className="price-row"><div><small>{t.fee}</small><strong>{activity.price} <span>TEST</span></strong><em>{t.worthlessToken}</em></div><span className="one-wallet-tag">{t.onePerWallet}</span></div>
          <Progress activity={activity} language={language} />
          {activity.status === 'OPEN' && !afterDeadline && <p className="signup-note">{phrase(t.fundsExplanation, { price: activity.price })}</p>}
          <PersonalStatus label={t.personalStatus} value={personal} />
          <ActionResult demo={demo} text={noticeText} label={t.result} />
        </section>
        {Intl.DateTimeFormat().resolvedOptions().timeZone !== activity.timeZone && <p className="viewer-time"><span>{t.localTime}</span><strong>{formatDate(activity.eventStart, language, Intl.DateTimeFormat().resolvedOptions().timeZone)}</strong></p>}
        <SecondaryDetails language={language} />
        <TransactionHistory activity={activity} language={language} local={local} devnet={bridge?.mode === 'devnet'} />
      </div>
      <aside className="desktop-aside"><div className="desktop-booking">
        <StatusBadge status={activity.status} label={status} />
        <div className="desktop-price"><small>{t.fee}</small><strong>{activity.price} TEST</strong><span>{t.worthlessToken}</span></div>
        <Progress activity={activity} language={language} />
        {activity.status === 'OPEN' && !afterDeadline && <p className="signup-note">{phrase(t.fundsExplanation, { price: activity.price })}</p>}
        <PersonalStatus label={t.personalStatus} value={personal} />
        <button className="primary-button" type="button" disabled={txLocked} onClick={primary.run} data-testid="primary-action">{txLocked ? l.pendingAction : primary.label}<span aria-hidden="true">↗</span></button>
        <ActionResult demo={demo} text={noticeText} label={t.result} />
      </div></aside>
    </main>}

    {page === 'manage' && <main className="manage-layout" id="main"><div className="manage-main">
      <div className="manage-heading"><div className="manage-title-row"><div><span className="section-kicker">{t.organizerPage}</span><h1>{t.manage}</h1></div><img className="manage-thumb" src="/pottery-cover.jpg" alt="" /></div><h2>{activity.title}</h2><p>{formatDate(activity.eventStart, language, activity.timeZone)} · {zoneLabel(activity.eventStart)}</p><p>{activity.venue}</p><p>{t.deadline}: {formatDate(activity.registrationDeadline, language, activity.timeZone)} · {zoneLabel(activity.registrationDeadline)}</p></div>
      <section className="situation-card"><div className="situation-top"><span className="section-kicker">{t.currentSituation}</span><StatusBadge status={activity.status} label={status} /></div><div className="situation-number"><div className="wallet-tally"><small>{t.walletCount}</small><strong>{count}</strong><span>{phrase(t.capacity, { capacity: activity.capacity })}</span></div><div><small>{t.fee}</small><b>{activity.price} TEST</b></div></div><Progress activity={activity} language={language} showCount={false} /><p>{activity.status === 'OPEN' && afterDeadline ? t.situationAfterDeadline : t.situation[activity.status]}</p></section>
      <section className="next-card"><span className="section-kicker">{t.nextStep}</span><p>{activity.status === 'OPEN' && afterDeadline ? t.nextAfterDeadline : t.next[activity.status]}</p>{(activity.status === 'READY' || activity.status === 'OPEN' && afterDeadline) && <button className="text-action" type="button" disabled={txLocked || !demo.connected} onClick={() => send({ type: activity.status === 'READY' ? 'SETTLE' : 'FINALIZE' })}>{activity.status === 'READY' ? t.settle : t.finalize}<span aria-hidden="true">↗</span></button>}</section>
      <section className="roster-card"><div className="section-heading"><h2>{t.participation}</h2><span>{phrase(t.rosterCount, { count })}</span></div>{count === 0 ? <p className="empty-note">{t.noParticipants}</p> : <ul>{activity.participations.map((item, index) => <li key={item.wallet}><span className="participant-avatar" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><span className="participant-name" title={item.wallet}>{local ? shortAddress(item.wallet) : item.wallet}</span><span className={`participant-status ${item.refundedAt || item.refunded ? 'is-claimed' : ''}`}>{refunding || activity.status === 'REFUNDED' ? item.refundedAt || item.refunded ? t.refundDone : t.refundPending : t.joinedStatus}</span></li>)}</ul>}</section>
      <section className="manage-facts"><h2>{t.eventFacts}</h2><div><span>{t.originalOrganizer}</span><strong title={activity.organizer}>{local ? shortAddress(activity.organizer) : activity.organizer}</strong></div><div><span>{t.deadline}</span><strong>{formatDate(activity.registrationDeadline, language, activity.timeZone)} · {zoneLabel(activity.registrationDeadline)}</strong></div><div><span>{t.heldFunds}</span><strong>{due} TEST</strong></div><div><span>{t.releasedFunds}</span><strong>{activity.status === 'PAID' ? activity.price * count : 0} TEST</strong></div><div><span>{t.pendingClaims}</span><strong>{refunding ? refundPending(activity) : 0}</strong></div><div><span>{t.completedClaims}</span><strong>{activity.participations.filter((item) => item.refundedAt || item.refunded).length} / {count}</strong></div></section>
      <section className="organizer-tools"><h2>{t.organizerOptions}</h2><p>{t.organizerBoundary}</p><div className="organizer-actions"><button type="button" disabled={txLocked || !canCancel} onClick={() => cancelDialogRef.current?.showModal()} data-testid="cancel-action">{t.cancel}<span aria-hidden="true">↗</span></button></div>
        <form onSubmit={(event) => { event.preventDefault(); send({ type: 'UPDATE_PAYOUT', account: payoutChoice }) }}><label>{t.payoutAccount}<input value={activity.organizerTokenAccount} readOnly /></label>{activity.unavailablePayoutAccounts.includes(activity.organizerTokenAccount) && <p className="warning-note">{t.payoutUnavailableFlag}</p>}<label>{t.newPayout}{bridge?.mode === 'devnet' ? <input value={payoutChoice} onChange={(event) => setPayoutChoice(event.target.value.trim())} placeholder={t.payoutPlaceholder} maxLength={44} disabled={txLocked || !canUpdatePayout} data-testid="payout-address" /> : <select value={payoutChoice} disabled={txLocked || !canUpdatePayout} onChange={(event) => setPayoutChoice(event.target.value)}>{(bridge?.payoutOptions ?? [1, 2, 3].map((number) => payoutAccountFor(activity.organizer, number))).map((account) => <option key={account} value={account}>{account}</option>)}</select>}</label><p>{t.payoutRecovery}</p><button className="small-primary" type="submit" disabled={txLocked || !canUpdatePayout || !payoutChoice || payoutChoice === activity.organizerTokenAccount} data-testid="payout-submit">{t.savePayout}</button></form>
      </section>
      <ActionResult demo={demo} text={noticeText} label={t.result} />
      <SecondaryDetails language={language} />
      <TransactionHistory activity={activity} language={language} local={local} devnet={bridge?.mode === 'devnet'} />
    </div></main>}

    {page === 'create' && <main className="create-page" id="main"><header><span className="section-kicker">{local ? l.createIntro : t.createIntro}</span><h1>{local ? l.createTitle : t.createTitle}</h1><p>{local ? l.createHelp : t.createHelp}</p></header><form className="create-form" onSubmit={createEvent} noValidate data-testid="create-form">
      <section className="form-section"><h2>{t.activityInfo}</h2><label>{t.titleField}<input name="title" defaultValue="A Slow Clay Afternoon" maxLength={64} /></label><label>{t.descriptionField}<textarea name="description" defaultValue="An unhurried afternoon at the pottery wheel." maxLength={280} /></label><label>{t.timeZoneField}<select name="timeZone" value={createZone} onChange={(event) => setCreateZone(event.target.value)}>{SUPPORTED_TIME_ZONES.map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></label><div className="field-row"><label>{t.deadlineField}<input name="registrationDeadline" type="datetime-local" value={deadlineLocal} onChange={(event) => setDeadlineLocal(event.target.value)} /><small>{deadlineIso ? utcOffsetAt(deadlineIso, createZone) : t.messages.createTimeInvalid}</small></label><label>{t.eventStartField}<input name="eventStart" type="datetime-local" value={startLocal} onChange={(event) => setStartLocal(event.target.value)} /><small>{startIso ? utcOffsetAt(startIso, createZone) : t.messages.createTimeInvalid}</small></label></div><div className="field-row"><label>{t.modeField}<select name="fulfillmentMode" defaultValue="offline"><option value="offline">{t.offlineOption}</option><option value="online">{t.onlineOption}</option></select></label><label>{t.venueField}<input name="venue" defaultValue="Example Studio, Jing’an District, Shanghai" maxLength={160} /></label></div><small>{t.timeHelp}</small></section>
      <section className="form-section"><h2>{t.groupAndFunds}</h2><div className="field-row three"><label>{t.priceField}<input name="price" type="number" min="1" step="1" defaultValue="25" /></label><label>{t.minimumField}<input name="minWallets" type="number" min="2" max="100" step="1" defaultValue="4" /></label><label>{t.capacityField}<input name="capacity" type="number" min="2" max="100" step="1" defaultValue="6" /></label></div><label>{t.fixedMint}<input value={activity.mint} readOnly /></label><label>{t.tokenProgram}<input value={CLASSIC_TOKEN_PROGRAM} readOnly /></label></section>
      <section className="form-section"><h2>{t.organizerSection}</h2><div className="field-row"><label>{local ? l.currentIdentity : t.currentIdentity}<input value={demo.wallet} readOnly /></label><label>{local ? l.createPayout : t.createPayout}<input value={bridge?.createPayout ?? payoutAccountFor(demo.wallet, 1)} readOnly /></label></div><small>{t.immutable}</small></section>
      <ActionResult demo={demo} text={noticeText} label={t.result} />
      <button className="primary-button create-submit" type="submit" disabled={txLocked}>{txLocked ? l.pendingAction : local ? l.createButton : t.createButton}<span aria-hidden="true">↗</span></button>
    </form></main>}

    {bridge ? bridge.address && bridge.controls(language) : <details className="demo-tools"><summary>{t.demoTools}<span aria-hidden="true">＋</span></summary><div className="demo-body"><p>{t.demoToolsHelp}</p><div className="demo-control-row"><label>{t.identity}<select value={demo.wallet} onChange={(event) => send({ type: 'SELECT_WALLET', wallet: event.target.value })} data-testid="demo-wallet-select">{demo.wallets.map((wallet) => <option key={wallet} value={wallet}>{wallet}</option>)}</select></label><button type="button" onClick={() => send({ type: 'ADD_WALLET' })}>{t.addIdentity}</button><button type="button" onClick={() => send({ type: 'CONNECT' })}>{demo.connected ? t.disconnect : t.connect}</button></div><div className="demo-actions">
      <button type="button" onClick={() => send({ type: 'ADVANCE_DEADLINE' })} data-testid="demo-deadline">{t.advanceClock}</button>
      <button type="button" onClick={() => send({ type: 'CLOSE_PAYOUT' })}>{t.closePayout}</button>
      <button type="button" onClick={() => send({ type: 'INJECT_SURPLUS' })}>{t.injectSurplus}</button>
      <button type="button" onClick={() => send({ type: 'CANCEL' })} data-testid="demo-cancel">{t.requestCancel}</button>
      <button type="button" onClick={() => send({ type: 'REFUND' })}>{t.requestRefund}</button>
      <button type="button" onClick={() => send({ type: 'SETTLE' })}>{t.requestSettle}</button>
      <button type="button" onClick={() => { send({ type: 'RESET' }); changePage('detail') }} data-testid="demo-reset">{t.resetDemo}</button>
    </div><div className="demo-ledger"><span>{t.simulatedClock}: <strong>{formatDate(activity.simulatedNow, language, activity.timeZone)} · {zoneLabel(activity.simulatedNow)}</strong></span><span>{t.vaultBalance}: <strong>{activity.vaultBalance} TEST</strong></span><span>{t.obligation}: <strong>{due} TEST</strong></span><span>{surplus === null ? t.deficit : t.surplus}: <strong>{surplus === null ? t.deficit : `${surplus} TEST`}</strong></span></div></div></details>}

    {page === 'detail' && <div className="mobile-dock glass"><div className="dock-context"><small>{activity.status === 'OPEN' && !afterDeadline ? t.fee : t.personalStatus}</small><strong>{activity.status === 'OPEN' && !afterDeadline ? `${activity.price} TEST` : personalShort}</strong><span>{phrase(t.dockProgress, { count, capacity: activity.capacity, min: activity.minWallets })}</span></div><button className="primary-button" type="button" disabled={txLocked} onClick={primary.run} data-testid="primary-action-mobile">{txLocked ? l.pendingAction : primary.label}<span aria-hidden="true">↗</span></button></div>}

    <dialog className="confirm-dialog glass" ref={cancelDialogRef} aria-labelledby="cancel-title"><form method="dialog"><button className="dialog-close" type="submit" aria-label={t.closeDialog}>×</button><span className="section-kicker">{t.organizerOptions}</span><h2 id="cancel-title">{t.confirmCancelTitle}</h2><p>{t.confirmCancelBody}</p><div className="dialog-actions"><button type="submit">{t.keepEvent}</button><button type="button" className="danger-button" disabled={txLocked || !canCancel} onClick={() => { cancelDialogRef.current?.close(); send({ type: 'CANCEL' }) }}>{t.confirmCancel}</button></div></form></dialog>
    <footer>{local ? l.footer : t.footer}</footer>
  </div>
}

function StatusBadge({ status, label }: { status: Activity['status']; label: string }) {
  return <span className={`status-pill status-${status.toLowerCase()}`}>{label}</span>
}

function shortAddress(value: string) {
  return value.length > 18 ? `${value.slice(0, 6)}…${value.slice(-6)}` : value
}

function Cover({ activity, language }: { activity: Activity; language: Language }) {
  const t = COPY[language]
  return <figure className="cover"><img src="/pottery-cover.jpg" alt={t.photoAlt} /><span className="cover-tag">{activity.fulfillmentMode === 'offline' ? t.inPerson : t.online}</span><figcaption>{t.photoBy} <a href={PHOTO_URL} target="_blank" rel="noopener noreferrer">Vitaly Gariev / Unsplash</a><span> · {t.photoDisclaimer}</span></figcaption></figure>
}

function EventFacts({ activity, language }: { activity: Activity; language: Language }) {
  const t = COPY[language]
  return <section className="fact-grid" id="event-facts" aria-label={t.eventFacts}>
    <div className="fact"><span className="fact-icon" aria-hidden="true">◷</span><div><small>{t.eventTime}</small><strong>{formatDate(activity.eventStart, language, activity.timeZone)}</strong><span>{activity.timeZone} ({utcOffsetAt(activity.eventStart, activity.timeZone)})</span></div></div>
    <div className="fact"><span className="fact-icon" aria-hidden="true">⌖</span><div><small>{activity.fulfillmentMode === 'offline' ? t.location : t.onlineMethod}</small><strong>{activity.venue}</strong></div></div>
    <div className="fact deadline-fact"><span className="fact-icon" aria-hidden="true">↗</span><div><small>{t.deadline}</small><strong>{formatDate(activity.registrationDeadline, language, activity.timeZone)}</strong><span>{activity.timeZone} ({utcOffsetAt(activity.registrationDeadline, activity.timeZone)})</span></div></div>
  </section>
}

function Progress({ activity, language, showCount = true }: { activity: Activity; language: Language; showCount?: boolean }) {
  const t = COPY[language]
  const count = activity.participations.length
  return <div className="progress-block"><div className="progress-head"><span>{t.progress}</span>{showCount && <strong>{phrase(t.reserved, { count, capacity: activity.capacity })}</strong>}</div><div className="progress-track" role="progressbar" aria-label={t.progress} aria-valuemin={0} aria-valuemax={activity.capacity} aria-valuenow={count}><span style={{ width: `${count / activity.capacity * 100}%` }} /><i style={{ left: `${activity.minWallets / activity.capacity * 100}%` }} /></div><div className="progress-legend"><span>{phrase(t.minimum, { min: activity.minWallets })}</span><span>{phrase(t.capacity, { capacity: activity.capacity })}</span></div><p className="wallet-caveat">{t.walletCaveat}</p></div>
}

function PersonalStatus({ label, value }: { label: string; value: string }) {
  return <div className="personal-row"><span>{label}</span><strong>{value}</strong></div>
}

function ActionResult({ demo, text, label }: { demo: DemoState; text: string; label: string }) {
  return <div className={`action-result ${demo.notice.tone}`} role="status" aria-label={label} data-testid="action-result">{text}</div>
}

function SecondaryDetails({ language }: { language: Language }) {
  const t = COPY[language]
  return <section className="secondary-details"><details><summary>{t.paymentRules}<span aria-hidden="true">＋</span></summary><p>{t.paymentRulesBody}</p></details><details><summary>{t.technical}<span aria-hidden="true">＋</span></summary><p>{t.technicalBody}</p></details></section>
}

function TransactionHistory({ activity, language, local = false, devnet = false }: { activity: Activity; language: Language; local?: boolean; devnet?: boolean }) {
  const t = COPY[language]
  const l = devnet ? DEVNET_COPY[language] : LOCAL_COPY[language]
  const groups = activity.transactions.reduce<Partial<Record<Activity['transactions'][number]['operation'], Activity['transactions']>>>((all, item) => {
    ;(all[item.operation] ??= []).push(item)
    return all
  }, {})
  return <section className="transactions-card" id="transactions"><h2>{local ? l.transactionTitle : t.transactions}</h2><p>{local ? l.transactionNote : t.transactionsNote}</p>{local && activity.transactions.length === 0 && <p>{l.emptyHistory}</p>}{Object.entries(groups).map(([operation, items]) => <div className="transaction-group" key={operation}><h3>{t.operation[operation as keyof typeof t.operation]} <span>{items?.length}</span></h3>{items?.map((item) => <div className="transaction-row" key={item.id} data-operation={item.operation}><div><small>{formatDate(item.createdAt, language, activity.timeZone)} · {local ? shortAddress(item.actor) : item.actor}</small><strong>{item.id}</strong></div><span>{item.amount ? `${item.amount} TEST` : t.noTokenTransfer}</span></div>)}</div>)}</section>
}

export default App
