import { copyFileSync } from 'node:fs'

const output = process.argv[2] || 'dist-public-preview'
copyFileSync(
  new URL(`../${output}/devnet.html`, import.meta.url),
  new URL(`../${output}/index.html`, import.meta.url),
)
