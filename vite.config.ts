import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// In development the browser cannot talk to a node directly (no CORS on Knots RPC), so the dev server
// forwards /__rpc to DEV_RPC_TARGET (a local regtest node by default). The iPhone build never uses this:
// there, requests go through the native plugin and Tor.
//
// `--mode server` builds the StartOS version into dist-server (src/app/target.ts): the same screens, talking to
// server/main.ts. In development, `npm run dev -- --mode server` forwards /api to a Crossbill server
// (DEV_SERVER_TARGET, http://127.0.0.1:8080 by default) started with `npm run server`.
export default defineConfig(({ mode }) => {
  const server = mode === 'server';
  return {
    base: './',
    plugins: [react()],
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
      __CROSSBILL_TARGET__: JSON.stringify(server ? 'server' : 'app'),
    },
    build: {
      outDir: server ? 'dist-server' : 'dist',
      target: 'safari16',
      sourcemap: false,
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      proxy: (server
        ? {
            '/api': { target: process.env.DEV_SERVER_TARGET ?? 'http://127.0.0.1:8080', changeOrigin: false },
            '/login': { target: process.env.DEV_SERVER_TARGET ?? 'http://127.0.0.1:8080', changeOrigin: false },
          }
        : {
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
          }) as Record<string, ProxyOptions>,
    },
  };
});
