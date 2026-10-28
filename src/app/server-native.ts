// The native plugin's stand-in for the StartOS build (src/app/target.ts). The page runs in a browser and the
// Crossbill server (server/main.ts) does what the iPhone's Swift does: it reaches Bitcoin Knots with the RPC
// password only it holds, reaches Lightning Fork through StartOS (or an onion through Tor), and keeps the app's
// files. There are no seed words here, ever: the server refuses to store them, and wallets sign on a Krux.
//
// Face ID and the iPhone passcode don't exist in a browser. Signing in to the server is what opens the app, so
// authenticate() answers yes for a signed-in page. Two-factor still applies to everything it covers on the iPhone.

import { WebPlugin } from '@capacitor/core';
import type { NativeHttpRequest, NativeHttpResponse, NetworkPath, ShrikeNativePlugin, TorHealth, TorRepairResult, TorStatus, WidgetTrouble } from './native';
import { serverApi, serverInfo, ServerError } from './server-api';
import { PRICE_HOST } from '../core/price';
import type { Scanner } from './server-scanner';

const PRICE_HOSTNAME = new URL(PRICE_HOST).hostname;

class NativeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** What a request is, as the server sorts it: the node's RPC, the Lightning node's mobile API, or the price. */
export type ServerRequestKind = 'rpc' | 'lightning' | 'price';

export function requestKind(req: Pick<NativeHttpRequest, 'url' | 'method'>): ServerRequestKind {
  const u = new URL(req.url);
  if (u.pathname.startsWith('/api/v1/') && u.hostname !== PRICE_HOSTNAME) return 'lightning';
  return req.method === 'GET' ? 'price' : 'rpc';
}

export class ShrikeNativeServer extends WebPlugin implements ShrikeNativePlugin {
  private async tor(): Promise<boolean> {
    try {
      return (await serverInfo()).tor;
    } catch {
      return false;
    }
  }

  async torStart(): Promise<void> {}

  async torStatus(): Promise<TorStatus> {
    return (await this.tor()) ? { state: 'ready', progress: 100 } : { state: 'off', progress: 0, summary: 'This server has no Tor proxy set up' };
  }

  async torCheck(): Promise<TorHealth> {
    const on = await this.tor();
    return { state: on ? 'ready' : 'off', controller: on, socks: on, circuit: on };
  }

  async torRepair(): Promise<TorRepairResult> {
    return (await this.tor()) ? { ok: true } : { ok: false, stage: 'off' };
  }

  /** The server isn't on the person's Wi-Fi: a Lightning node's home address is never tried, only its onion. */
  async networkPath(): Promise<NetworkPath> {
    return { known: true, satisfied: true, wifi: false, wired: false, cellular: false, other: true };
  }

  async httpRequest(req: NativeHttpRequest): Promise<NativeHttpResponse> {
    const kind = requestKind(req);
    if (kind === 'lightning' && (req.pinPem || req.captureRootSha256)) {
      // A home address is pinned to the node's root certificate, which only the iPhone checks. The server goes to
      // the node through StartOS instead, so the onion route carries everything
      throw new NativeError('Crossbill on StartOS reaches your Lightning node through StartOS, not its home address.', 'network');
    }
    try {
      return await serverApi<NativeHttpResponse>('http', {
        method: 'POST',
        body: { kind, url: req.url, method: req.method ?? 'POST', headers: req.headers, body: req.body, timeoutMs: req.timeoutMs, useTor: req.useTor },
      });
    } catch (e) {
      if (e instanceof ServerError) throw new NativeError(e.message, e.code ?? 'network');
      // The Crossbill server itself didn't answer: the request may not have left this browser
      throw new NativeError('Can’t reach the Crossbill server.', 'offline');
    }
  }

  async vaultSet(opts: { key: string; value: string }): Promise<void> {
    await serverApi(`vault/${encodeURIComponent(opts.key)}`, { method: 'PUT', body: { value: opts.value } });
  }

  async vaultGet(opts: { key: string }): Promise<{ value: string | null }> {
    return serverApi<{ value: string | null }>(`vault/${encodeURIComponent(opts.key)}`);
  }

  async vaultDelete(opts: { key: string }): Promise<void> {
    await serverApi(`vault/${encodeURIComponent(opts.key)}`, { method: 'DELETE' });
  }

  async authenticate(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async biometryTrust(): Promise<{ changed: boolean }> {
    return { changed: false };
  }

  async biometryType(): Promise<{ type: 'none' }> {
    return { type: 'none' };
  }

  private scanner: Scanner | null = null;

  /**
   * Opens the page's own scanner (src/app/server-scanner.ts): the camera of the device the page is open on, a
   * picture of a code, or its pasted text. For the Krux's signature, its microSD file works as on the iPhone.
   */
  async scanQr(opts?: { parts?: boolean; title?: string }): Promise<{ value: string | null }> {
    if (this.scanner) throw new NativeError('The scanner is already open', 'busy');
    const { openScanner } = await import('./server-scanner');
    const scanner = openScanner({
      parts: opts?.parts ?? false,
      title: opts?.title ?? 'Scan QR code',
      onPart: (value) => void this.notifyListeners('qrPart', { value }),
    });
    this.scanner = scanner;
    try {
      return { value: await scanner.done };
    } finally {
      this.scanner = null;
    }
  }

  async scanQrProgress(opts: { text: string; reset?: boolean }): Promise<void> {
    this.scanner?.progress(opts.text, opts.reset ?? false);
  }

  async scanQrFinish(): Promise<void> {
    this.scanner?.finish('finished');
  }

  async keepAwake(): Promise<void> {}

  async copyPrivately(opts: { text: string }): Promise<void> {
    await navigator.clipboard.writeText(opts.text);
  }

  async openUrl(opts: { url: string }): Promise<{ opened: boolean }> {
    // With "noopener" window.open always answers null, so the opener is cut here instead
    const w = window.open(opts.url, '_blank');
    if (w) w.opener = null;
    return { opened: w != null };
  }

  async widgetsUpdate(): Promise<{ ok: boolean; reason?: WidgetTrouble }> {
    return { ok: false, reason: 'web' };
  }

  async widgetsInstalled(): Promise<{ ok: boolean; reason?: WidgetTrouble; widgets: { kind: string; family: string }[] }> {
    return { ok: false, reason: 'web', widgets: [] };
  }

  // StartOS has no notifications: the server page is open only while someone looks at it
  async notifyPermission(): Promise<{ granted: boolean }> {
    return { granted: false };
  }

  async notifyStatus(): Promise<{ status: 'granted' | 'denied' | 'notDetermined' }> {
    return { status: 'denied' };
  }

  async notify(): Promise<void> {}

  async backgroundChecks(): Promise<void> {}

  async backgroundCheckDone(): Promise<void> {}
}
