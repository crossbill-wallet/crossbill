import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// In development the browser cannot talk to a node directly (no CORS on Knots RPC), so the dev server
// forwards /__rpc to DEV_RPC_TARGET (a local regtest node by default). The iPhone build never uses this:
// there, requests go through the native plugin and Tor.
export default defineConfig({
  base: './',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: 'dist',
    target: 'safari16',
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/__rpc': {
        target: process.env.DEV_RPC_TARGET ?? 'http://127.0.0.1:18443',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/__rpc/, '') || '/',
      },
      // A Lightning Fork node's mobile API: the pretend dashboard in tools/lf-mock by default
      '/__lf': {
        target: process.env.DEV_LF_TARGET ?? 'http://127.0.0.1:18480',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/__lf/, '') || '/',
      },
      // The XBT price, straight from Neoxa Exchange (or a stand-in for tests) without Tor
      '/__price': {
        target: process.env.DEV_PRICE_TARGET ?? 'https://neoxa.exchange',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/__price/, '') || '/',
      },
    },
  },
});
