import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    watch: { ignored: ['**/contract/target/**', '**/output/playwright/**'] },
    proxy: { '/local-rpc': { target: 'http://127.0.0.1:8899', changeOrigin: true, rewrite: (path) => path.replace(/^\/local-rpc/, '') || '/' } },
  },
  // Keep both standard and prefixed backdrop-filter declarations in the production CSS.
  build: { cssMinify: false },
})
