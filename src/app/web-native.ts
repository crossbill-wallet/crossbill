// Development stand-in for the native plugin, used only when the app runs in a desktop browser. Secrets are
// kept in memory for the session, Tor is not available, and RPC goes through the Vite dev server's proxy.
// None of this ships in the iPhone build, where the Swift plugin answers instead.

import { WebPlugin } from '@capacitor/core';
import type { NativeHttpRequest, ShrikeNativePlugin, TorHealth, TorRepairResult, TorStatus } from './native';

const memoryVault = new Map<string, string>();

/**
 * A pretend Tor, for checking the price screens in a browser. Off unless localStorage 'shrike.devTor' is set:
 *   'ok'        everything works
 *   'dead-port' the SOCKS port is refused, as after iOS takes it back, until a repair reopens it
 *   'stuck'     the controller can't be reached, so nothing can be repaired
 *   'no-route'  Tor works but every request through it fails
 * The page also has to be told Tor is available: __shrike.torAvailable = true.
 */
function devTor(): string | null {
  try {
    return localStorage.getItem('shrike.devTor');
  } catch {
    return null;
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Refused extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export class ShrikeNativeWeb extends WebPlugin implements ShrikeNativePlugin {
  private socksDead = devTor() === 'dead-port';

  async torStart(): Promise<void> {}

  async torStatus(): Promise<TorStatus> {
    if (devTor()) return { state: 'ready', progress: 100 };
    return { state: 'off', progress: 0, summary: 'Tor runs in the iPhone app only' };
  }

  async torCheck(): Promise<TorHealth> {
    const mode = devTor();
    if (!mode) return { state: 'off', controller: false, socks: false, circuit: false };
    await pause(300);
    return { state: 'ready', controller: mode !== 'stuck', socks: !this.socksDead && mode !== 'stuck', circuit: true, port: 39050 };
  }

  async torRepair(): Promise<TorRepairResult> {
    const mode = devTor();
    if (!mode) return { ok: false, stage: 'off' };
    await pause(1200);
    if (mode === 'stuck') return { ok: false, stage: 'control' };
    const reopened = this.socksDead;
    this.socksDead = false;
    return { ok: true, reopened, port: reopened ? 39051 : 39050 };
  }

  async httpRequest(req: NativeHttpRequest): Promise<{ status: number; body: string }> {
    const u = new URL(req.url);
    if (req.method === 'GET') {
      if (req.useTor) {
        const mode = devTor();
        if (this.socksDead || mode === 'stuck') throw new Refused('Could not connect to the server. (-1004, 61)', 'refused');
        await pause(700);
        if (mode === 'no-route') throw new Refused('Could not connect to the server. (-1004, 2)', 'network');
      }
      // Public price data: https://neoxa.exchange/api/... -> /__price/api/..., forwarded by vite.config.ts.
      // Never through Tor here; the browser version is for testing screens only
      const res = await fetch(`/__price${u.pathname}${u.search}`, { headers: req.headers });
      return { status: res.status, body: await res.text() };
    }
    if (req.useTor) throw new Error('Tor is only available in the iPhone app. Turn Tor off to test against a local node.');
    // http://host:port/path -> /__rpc/path, forwarded by vite.config.ts to the dev node
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

  async copyPrivately(opts: { text: string }): Promise<void> {
    await navigator.clipboard.writeText(opts.text);
  }

  async openUrl(opts: { url: string }): Promise<{ opened: boolean }> {
    return { opened: window.open(opts.url, '_blank', 'noopener') != null };
  }
}
