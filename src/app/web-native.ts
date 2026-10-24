// Development stand-in for the native plugin, used only when the app runs in a desktop browser. Secrets are
// kept in memory for the session, Tor is not available, and RPC goes through the Vite dev server's proxy.
// None of this ships in the iPhone build, where the Swift plugin answers instead.

import { WebPlugin } from '@capacitor/core';
import type { NativeHttpRequest, NativeHttpResponse, NetworkPath, ShrikeNativePlugin, TorHealth, TorRepairResult, TorStatus, WidgetTrouble } from './native';
import { certFingerprint } from '../core/lfapi';

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

/**
 * A pretend way to a Lightning node, for the Lightning screens in a browser (tools/lf-mock answers for the node).
 * localStorage 'shrike.devLf':
 *   unset       both its home address and its onion answer, and the iPhone is on Wi-Fi
 *   'away'      on cellular: only the onion answers
 *   'home-only' Tor is down: only the home address answers
 *   'down'      nothing answers
 */
function devLf(): string | null {
  try {
    return localStorage.getItem('shrike.devLf');
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
  /** The pretend Lightning node's root certificate */
  private lfRoot: string | null = null;

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

  async networkPath(): Promise<NetworkPath> {
    const away = devLf() === 'away';
    return { known: true, satisfied: true, wifi: !away, wired: false, cellular: away, other: false };
  }

  async httpRequest(req: NativeHttpRequest): Promise<NativeHttpResponse> {
    const u = new URL(req.url);
    if (u.pathname.startsWith('/api/v1/') && u.hostname !== 'neoxa.exchange') return this.lightning(req, u);
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

  /**
   * https://<home address or onion>/api/v1/... -> /__lf/api/v1/..., forwarded by vite.config.ts to DEV_LF_TARGET.
   * The pretend node's root certificate, from /__mock/root, stands in for the TLS chain the iPhone checks.
   */
  private async lightning(req: NativeHttpRequest, u: URL): Promise<NativeHttpResponse> {
    const onion = u.hostname.endsWith('.onion');
    const mode = devLf();
    if (onion && !req.useTor) throw new Error('An onion address needs Tor');
    if (mode === 'down' || (onion && mode === 'home-only') || (!onion && mode === 'away')) {
      await pause(onion ? 1500 : 400);
      throw new Refused('Could not connect to the server. (-1004, 61)', onion ? 'network' : 'timeout');
    }
    if (onion) await pause(500);
    // As on the iPhone, a home address's certificate is checked before anything is sent to it
    let rootPem: string | undefined;
    if (!onion) {
      const root: string = this.lfRoot ?? (await (await fetch('/__lf/__mock/root')).text());
      this.lfRoot = root;
      const presented = certFingerprint(root);
      const wanted = req.pinPem ? certFingerprint(req.pinPem) : (req.captureRootSha256 ?? '').toUpperCase();
      if (!wanted || presented !== wanted) throw new Refused('This node’s certificate isn’t the one this phone paired with', 'certificate');
      if (!req.pinPem) rootPem = root;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
    try {
      const res = await fetch(`/__lf${u.pathname}${u.search}`, {
        method: req.method ?? 'POST',
        headers: req.headers,
        body: req.method === 'GET' ? undefined : req.body,
        signal: ctrl.signal,
        redirect: 'manual',
      });
      return { status: res.status, body: await res.text(), ...(rootPem ? { rootPem } : {}) };
    } finally {
      clearTimeout(timer);
    }
  }

  async vaultSet(opts: { key: string; value: string }): Promise<void> {
    memoryVault.set(opts.key, opts.value);
  }

  async vaultGet(opts: { key: string; biometricsOnly?: boolean }): Promise<{ value: string | null }> {
    if (opts.biometricsOnly && devFaceIdFails()) throw new Refused('Face ID didn’t confirm it’s you', 'needs-pin');
    return { value: memoryVault.get(opts.key) ?? null };
  }

  async vaultDelete(opts: { key: string }): Promise<void> {
    memoryVault.delete(opts.key);
  }

  /**
   * localStorage 'shrike.devFaceId' = 'fail' makes Face ID fail, to see the PIN pad in a browser; 'changed' acts as
   * if a face was added since the PIN was set.
   */
  async authenticate(opts: { biometricsOnly?: boolean }): Promise<{ ok: boolean; pin?: boolean; changed?: boolean }> {
    if (opts.biometricsOnly && devFaceId() === 'changed') return { ok: false, pin: true, changed: true };
    if (opts.biometricsOnly && devFaceIdFails()) return { ok: false, pin: true };
    return { ok: true };
  }

  async biometryTrust(opts: { action: 'set' | 'clear' | 'check' }): Promise<{ changed: boolean }> {
    if (opts.action === 'set') {
      try {
        if (devFaceId() === 'changed') localStorage.removeItem('shrike.devFaceId');
      } catch {
        // storage refused
      }
    }
    return { changed: opts.action === 'check' && devFaceId() === 'changed' };
  }

  async biometryType(): Promise<{ type: 'none' }> {
    return { type: 'none' };
  }

  private scanDone: ((v: string | null) => void) | null = null;

  /**
   * The camera, in a browser. One code is asked for with a prompt. For parts, localStorage 'shrike.devScan' can
   * hold a JSON list of codes to feed in, a frame every 150 ms, as an animated code would arrive; without it,
   * each code is asked for in turn until one is left empty.
   */
  async scanQr(opts?: { parts?: boolean; title?: string }): Promise<{ value: string | null }> {
    if (!opts?.parts) return { value: window.prompt('Paste what the QR code holds') };
    let feed: string[] | null = null;
    try {
      const raw = localStorage.getItem('shrike.devScan');
      feed = raw ? (JSON.parse(raw) as string[]) : null;
    } catch {
      feed = null;
    }
    const done = new Promise<string | null>((resolve) => (this.scanDone = resolve));
    void (async () => {
      for (let i = 0; this.scanDone; i++) {
        let value: string | null;
        if (feed) {
          await pause(150);
          value = i < feed.length ? feed[i] : null;
        } else {
          await pause(0);
          value = window.prompt(`${opts.title ?? 'Scan'}: paste a code, or leave it empty to stop`);
        }
        if (!this.scanDone) return;
        if (!value) {
          this.scanDone(null);
          this.scanDone = null;
          return;
        }
        this.notifyListeners('qrPart', { value });
      }
    })();
    return { value: await done };
  }

  async scanQrProgress(): Promise<void> {}

  async scanQrFinish(): Promise<void> {
    this.scanDone?.('finished');
    this.scanDone = null;
  }

  async keepAwake(): Promise<void> {}

  async copyPrivately(opts: { text: string }): Promise<void> {
    await navigator.clipboard.writeText(opts.text);
  }

  async openUrl(opts: { url: string }): Promise<{ opened: boolean }> {
    return { opened: window.open(opts.url, '_blank', 'noopener') != null };
  }

  /**
   * Widgets exist only on the iPhone. For checking the Widgets screen in a browser, localStorage
   * 'shrike.devWidgets' can list pretend ones, such as ["ShrikePrice:systemSmall"]; what the app would hand
   * them is kept in 'shrike.widgetSnapshot'.
   */
  async widgetsUpdate(opts: { snapshot: string | null }): Promise<{ ok: boolean; reason?: WidgetTrouble }> {
    const pretend = devWidgets();
    try {
      if (opts.snapshot == null) localStorage.removeItem('shrike.widgetSnapshot');
      else localStorage.setItem('shrike.widgetSnapshot', opts.snapshot);
    } catch {
      // storage refused
    }
    return pretend ? { ok: true } : { ok: false, reason: 'web' };
  }

  async widgetsInstalled(): Promise<{ ok: boolean; reason?: WidgetTrouble; widgets: { kind: string; family: string }[] }> {
    const pretend = devWidgets();
    if (!pretend) return { ok: false, reason: 'web', widgets: [] };
    return {
      ok: true,
      widgets: pretend.map((w) => {
        const [kind, family] = w.split(':');
        return { kind, family };
      }),
    };
  }
}

function devFaceId(): string | null {
  try {
    return localStorage.getItem('shrike.devFaceId');
  } catch {
    return null;
  }
}

function devFaceIdFails(): boolean {
  const v = devFaceId();
  return v === 'fail' || v === 'changed';
}

function devWidgets(): string[] | null {
  try {
    const v = localStorage.getItem('shrike.devWidgets');
    return v ? (JSON.parse(v) as string[]) : null;
  } catch {
    return null;
  }
}
