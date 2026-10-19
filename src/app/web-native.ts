// Development stand-in for the native plugin, used only when the app runs in a desktop browser. Secrets are
// kept in memory for the session, Tor is not available, and RPC goes through the Vite dev server's proxy.
// None of this ships in the iPhone build, where the Swift plugin answers instead.

import { WebPlugin } from '@capacitor/core';
import type { NativeHttpRequest, ShrikeNativePlugin, TorStatus } from './native';

const memoryVault = new Map<string, string>();

export class ShrikeNativeWeb extends WebPlugin implements ShrikeNativePlugin {
  async torStart(): Promise<void> {}

  async torRecover(): Promise<void> {}

  async torStatus(): Promise<TorStatus> {
    return { state: 'off', progress: 0, summary: 'Tor runs in the iPhone app only' };
  }

  async httpRequest(req: NativeHttpRequest): Promise<{ status: number; body: string }> {
    if (req.useTor) throw new Error('Tor is only available in the iPhone app. Turn Tor off to test against a local node.');
    // http://host:port/path -> /__rpc/path, forwarded by vite.config.ts to the dev node
    const u = new URL(req.url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
    try {
      const res = await fetch(`/__rpc${u.pathname}`, {
        method: 'POST',
        headers: { ...req.headers, 'X-Rpc-Target': `${u.hostname}:${u.port}` },
        body: req.body,
        signal: ctrl.signal,
      });
      return { status: res.status, body: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  }

  async vaultSet(opts: { key: string; value: string }): Promise<void> {
    memoryVault.set(opts.key, opts.value);
  }

  async vaultGet(opts: { key: string }): Promise<{ value: string | null }> {
    return { value: memoryVault.get(opts.key) ?? null };
  }

  async vaultDelete(opts: { key: string }): Promise<void> {
    memoryVault.delete(opts.key);
  }

  async authenticate(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async biometryType(): Promise<{ type: 'none' }> {
    return { type: 'none' };
  }

  async scanQr(): Promise<{ value: string | null }> {
    return { value: window.prompt('Paste what the QR code holds') };
  }

  async openUrl(opts: { url: string }): Promise<{ opened: boolean }> {
    return { opened: window.open(opts.url, '_blank', 'noopener') != null };
  }
}
