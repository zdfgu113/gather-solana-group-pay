import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { PublicKey } from '@solana/web3.js'
import { chromium } from 'playwright-core'
import { initialActivity } from '../src/simulation.ts'
import {
  CLASSIC_TOKEN_PROGRAM, DEVNET_MINT, DEVNET_PUBLIC_EVENTS,
} from '../src/devnet/public-events.ts'

const root = resolve(import.meta.dirname, '..')
const previewDir = process.env.PREVIEW_DIR || 'dist-readonly-runtime-fix-candidate'
const output = resolve(root, 'output/playwright/readonly-integration-candidate')
mkdirSync(output, { recursive: true })
process.env.TMP = output
process.env.TEMP = output

const freePort = () => new Promise((resolvePort, reject) => {
  const listener = createServer()
  listener.once('error', reject)
  listener.listen(0, '127.0.0.1', () => {
    const port = listener.address().port
    listener.close(() => resolvePort(port))
  })
})

const participants = [41, 42].map((byte) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58())
const organizer = new PublicKey(new Uint8Array(32).fill(40)).toBase58()
function activity(target) {
  const refunded = target.status === 'REFUNDED'
  return {
    ...initialActivity(), id: target.event, title: refunded ? 'Refunded public example' : 'Paid public example',
    description: 'Validated fixed Devnet display data.', organizer, organizerTokenAccount: target.payout,
    unavailablePayoutAccounts: [], mint: DEVNET_MINT, tokenProgram: CLASSIC_TOKEN_PROGRAM,
    status: target.status, price: 25, minWallets: 2, capacity: 2, vaultBalance: 0,
    registrationDeadline: '2026-09-01T00:00:00.000Z', eventStart: '2026-09-02T00:00:00.000Z',
    simulatedNow: '2026-09-27T00:00:00.000Z', transactions: [],
    participations: participants.map((wallet, index) => ({
      wallet, paidAmount: 25, joinedAt: `2026-08-2${index + 1}T00:00:00.000Z`, refunded,
    })),
  }
}

const port = await freePort()
const origin = `http://127.0.0.1:${port}`
const server = spawn(process.execPath, [
  'node_modules/vite/bin/vite.js', 'preview', '--config', 'vite.devnet.config.ts', '--mode', 'readonly-candidate',
  '--outDir', previewDir, '--host', '127.0.0.1', '--port', String(port), '--strictPort',
], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
let serverOutput = ''
server.stdout.on('data', (chunk) => { serverOutput += chunk })
server.stderr.on('data', (chunk) => { serverOutput += chunk })

let browser
try {
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error(`Preview exited ${server.exitCode}: ${serverOutput}`)
    try { ready = (await fetch(`${origin}/devnet.html`)).ok } catch { /* starting */ }
    if (ready) break
    await delay(250)
  }
  assert.equal(ready, true, `Read-only candidate did not start: ${serverOutput}`)
  browser = await chromium.launch({ channel: 'msedge', headless: true, artifactsDir: output, args: ['--disable-extensions'] })

  for (const [name, target] of Object.entries(DEVNET_PUBLIC_EVENTS)) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
    const page = await context.newPage()
    const reads = []
    const directRpc = []
    page.on('request', (request) => { if (request.url().startsWith('https://api.devnet.solana.com/')) directRpc.push(request.url()) })
    await page.route('**/.netlify/functions/read-event**', (route) => {
      reads.push(route.request().url())
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        schema: 1, ok: true, checkedAtUtc: '2026-09-27T00:00:00.000Z', observedSlot: 500, activity: activity(target),
      }) })
    })
    await page.goto(`${origin}/devnet.html?event=${target.event}`)
    await page.getByText('Simulation only. TEST has no cash value', { exact: false }).waitFor()
    assert.equal(reads.length, 0, 'Default simulation must not call the display endpoint')
    await page.getByTestId('devnet-mode-switch').click()
    await page.locator(`.status-${target.status.toLowerCase()}`).first().waitFor()
    assert.equal(reads.length, 1)
    assert.equal(new URL(reads[0]).searchParams.get('event'), target.event)
    assert.deepEqual(directRpc, [])
    assert.match(await page.getByTestId('wallet-button').textContent(), /Connect wallet/)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
    await page.screenshot({ path: resolve(output, `${name}-390.png`), fullPage: true })
    await context.close()
  }

  {
    const target = DEVNET_PUBLIC_EVENTS.refunded
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
    const page = await context.newPage()
    let reads = 0
    let fail = true
    await page.route('**/.netlify/functions/read-event**', (route) => {
      reads += 1
      return fail
        ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ schema: 1, ok: false, error: 'read_service_not_configured' }) })
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ schema: 1, ok: true, activity: activity(target) }) })
    })
    await page.goto(`${origin}/devnet.html?event=${target.event}`)
    await page.getByTestId('devnet-mode-switch').click()
    await page.getByTestId('event-read-retry').waitFor()
    assert.match(await page.getByTestId('event-read-status').textContent(), /read-only display service returned an invalid or unavailable result/i)
    await delay(300)
    assert.equal(reads, 1, 'A failed display read must not retry automatically')
    await page.locator('.language-button').click()
    await page.getByRole('menuitemradio', { name: /简体中文/ }).click()
    assert.match(await page.getByTestId('event-read-status').textContent(), /只读展示服务返回无效结果或暂不可用/)
    fail = false
    await page.getByTestId('event-read-retry').click()
    await page.locator('.status-refunded').first().waitFor()
    assert.equal(reads, 2, 'One explicit retry must issue one new display read')
    await page.screenshot({ path: resolve(output, 'refunded-retry-zh-390.png'), fullPage: true })
    await context.close()
  }

  {
    const unsupported = new PublicKey(new Uint8Array(32).fill(9)).toBase58()
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
    const page = await context.newPage()
    let reads = 0
    await page.route('**/.netlify/functions/read-event**', (route) => { reads += 1; return route.abort() })
    await page.goto(`${origin}/devnet.html?event=${unsupported}`)
    await page.getByTestId('devnet-mode-switch').click()
    await page.getByTestId('event-read-retry').waitFor()
    assert.match(await page.getByTestId('event-read-status').textContent(), /supports only the two completed examples/i)
    assert.equal(reads, 0, 'An unsupported address must be rejected before a network request')
    assert.equal(await page.getByTestId('create-form').count(), 0)
    await context.close()
  }

  console.log('PASS fixed paid/refunded display, explicit Devnet, no wallet or direct RPC, 390px')
  console.log('PASS bilingual failure, no automatic retry, one explicit retry')
  console.log('PASS unsupported address is rejected before the display endpoint')
} finally {
  await browser?.close()
  server.kill()
}
