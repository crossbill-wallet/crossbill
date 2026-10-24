// Serves the pretend Lightning Fork dashboard (mock.ts) for the browser version of the app:
//
//   node tools/lf-mock/server.ts            (Node 22.18 or later runs TypeScript as is)
//   LF_MOCK_BRIDGE=own|service|none         how SHA256 invoices are paid (own bridge by default)
//   LF_MOCK_PORT=18480
//
// `npm run dev` forwards /__lf to it (vite.config.ts). Every answer carries the pretend root certificate in
// X-Lf-Root, and its root alone at /__mock/root, which the browser stand-in checks in place of a TLS chain.
//
//   GET /__mock/code                     a pairing code (JSON, and its lightningfork:// link)
//   GET /__mock/sample?kind=sha256&amount=1250&memo=…&expiry=600   something to pay: sha256, xbt, offer, address
//   GET /__mock/settle?hash=…            marks one of the node's invoices paid
//   GET /__mock/mode?kind=bitcoin-invoice&mode=on_its_way            what the next payment of that kind does

import { createServer } from 'node:http';
import { MockNode, type PayMode } from './mock.ts';

const bridge = process.env.LF_MOCK_BRIDGE ?? 'own';
const node = new MockNode({
  ownBridge: bridge === 'own' ? { ready: true, availableSat: 196_500 } : null,
  service: bridge === 'service' ? { label: 'Pretend Bridge' } : null,
  autoSettleMs: 8_000,
});
const port = Number(process.env.LF_MOCK_PORT ?? 18480);
const root = Buffer.from(node.rootPem).toString('base64');

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (status: number, body: string, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type, 'X-Lf-Root': root, 'Access-Control-Expose-Headers': 'X-Lf-Root' });
    res.end(body);
  };
  // The root a server at the home address presents, for the browser stand-in to check before it sends anything
  if (url.pathname === '/__mock/root') return send(200, node.rootPem, 'text/plain');
  if (url.pathname === '/__mock/code') {
    const c = node.issueCode();
    return send(200, JSON.stringify({ json: c.json, link: c.link }));
  }
  if (url.pathname === '/__mock/sample') {
    const kind = (url.searchParams.get('kind') ?? 'sha256') as 'sha256' | 'xbt' | 'offer' | 'address';
    const amount = url.searchParams.get('amount');
    const text = node.sample(kind, amount === 'none' ? null : Number(amount ?? 1250), url.searchParams.get('memo') ?? 'Steak n Shake #241', Number(url.searchParams.get('expiry') ?? 600));
    return send(200, text, 'text/plain');
  }
  if (url.pathname === '/__mock/settle') {
    node.settle(url.searchParams.get('hash') ?? '');
    return send(200, '{}');
  }
  if (url.pathname === '/__mock/mode') {
    const kind = url.searchParams.get('kind') as 'lightning' | 'bitcoin-invoice' | 'onchain';
    node.payMode[kind] = (url.searchParams.get('mode') ?? 'ok') as PayMode;
    return send(200, '{}');
  }
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
  const out = await node.handle({ method: req.method ?? 'GET', path: url.pathname + url.search, headers, body: Buffer.concat(chunks).toString('utf8') });
  send(out.status, out.body);
}).listen(port, '127.0.0.1', () => {
  console.log(`Pretend Lightning Fork dashboard on http://127.0.0.1:${port} (bridge: ${bridge})`);
  console.log(`Pairing code: ${node.issueCode().json}`);
});
