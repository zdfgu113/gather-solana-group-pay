import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { DEVNET_GENESIS, DEVNET_MINT, DEVNET_MINT_AUTHORITY, DEVNET_PROGRAM_ID } from './src/devnet/public-events.ts'

export default defineConfig(({ mode }) => {
  const reviewed = mode === 'review-candidate' || mode === 'readonly-candidate'
  return {
  plugins: [react()],
  envDir: reviewed ? false : undefined,
  define: reviewed ? {
    'import.meta.env.VITE_DEVNET_PROGRAM_ID': JSON.stringify(DEVNET_PROGRAM_ID),
    'import.meta.env.VITE_DEVNET_TEST_MINT': JSON.stringify(DEVNET_MINT),
    'import.meta.env.VITE_DEVNET_MINT_AUTHORITY': JSON.stringify(DEVNET_MINT_AUTHORITY),
    'import.meta.env.VITE_DEVNET_GENESIS_HASH': JSON.stringify(DEVNET_GENESIS),
    'import.meta.env.VITE_DEVNET_RPC_URL': JSON.stringify('https://api.devnet.solana.com/'),
  } : undefined,
  server: { watch: { ignored: ['**/contract/target/**', '**/output/playwright/**'] } },
  build: {
    outDir: mode === 'public-preview' ? 'dist-public-preview'
      : mode === 'review-candidate' ? 'dist-review-candidate'
        : mode === 'readonly-candidate' ? 'dist-readonly-integration-candidate' : 'dist-devnet',
    cssMinify: false, sourcemap: !['public-preview', 'review-candidate', 'readonly-candidate'].includes(mode),
    rollupOptions: { input: 'devnet.html' },
  },
}})
