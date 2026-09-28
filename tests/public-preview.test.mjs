import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, relative, extname } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const outputName = process.env.PREVIEW_DIR || 'dist-readonly-runtime-fix-candidate'
const output = resolve(root, outputName)
const files = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = resolve(directory, entry.name)
  return entry.isDirectory() ? files(path) : [relative(output, path).replaceAll('\\', '/')]
})

test(`${outputName} serves the same approved entry at / and /devnet.html`, () => {
  const names = files(output)
  assert.ok(names.includes('index.html'))
  assert.ok(names.includes('devnet.html'))
  assert.ok(names.includes('gather-logo.png'))
  assert.ok(names.some((name) => name.endsWith('.js')))
  assert.equal(names.length, 8, `Expected the eight-file public allowlist, got: ${names.join(', ')}`)
  assert.ok(names.every((name) => ['.html', '.js', '.css', '.svg', '.jpg', '.png', '.webp'].includes(extname(name))), `Unexpected public file: ${names.find((name) => !['.html', '.js', '.css', '.svg', '.jpg', '.png', '.webp'].includes(extname(name)))}`)
  assert.equal(names.some((name) => /(^|\/)local\.html$|\.map$|\.log$|\.json$|\.env|(^|\/)(?:tests|docs|target|output)\//i.test(name)), false)

  const html = readFileSync(resolve(output, 'devnet.html'), 'utf8')
  assert.equal(readFileSync(resolve(output, 'index.html'), 'utf8'), html)
  const scripts = names.filter((name) => name.endsWith('.js')).map((name) => readFileSync(resolve(output, name), 'utf8')).join('\n')
  assert.equal(scripts.includes('sourceMappingURL='), false)
  assert.match(html, /Gather · Devnet demo/)
  for (const publicValue of [
    '96piBXGNG9Ga8ycf6cpEJCFugjqpCvhuGjQHJc4KvzVe',
    'BAKZoZLZakRYowjaee7aXTSvTe4hVEwCybBNMAygp8nV',
    'SMhtCCQRnXFx2Zq7RVBRLnKDatpDd3oKvvZyome13dz',
    '4SZ2XvXx4eEyNPQLfFbrQTLtfFVJ4SgoagVrTTWkc87S',
  ]) assert.ok(scripts.includes(publicValue), `Missing public identifier: ${publicValue}`)
  const forbiddenMarkers = [
    'group-pay-devnet-keys', 'deployer-new.json', 'mint-authority.json',
    'program-id.json', 'test-mint.json', 'FixtureWalletAdapter',
    'fixture-wallet', 'local/fixtures', 'phase2b-verify', 'devnet-browser-acceptance-run',
    'HELIUS_DEVNET_API_KEY', 'devnet.helius-rpc.com',
  ]
  assert.deepEqual(forbiddenMarkers.filter((marker) => scripts.toLowerCase().includes(marker.toLowerCase())), [])
})
