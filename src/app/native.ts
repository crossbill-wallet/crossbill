// The bridge to the app's own native plugin (ios/App/App/ShrikeNativePlugin.swift). In a browser during
// development it falls back to web-native.ts, which is for testing only and never holds a real seed. The StartOS
// build (src/app/target.ts) uses server-native.ts instead, which asks the Crossbill server.

import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type TorState = 'off' | 'starting' | 'ready' | 'error';

export interface TorStatus {
  state: TorState;
  /** Bootstrap progress, 0 to 100. */
  progress: number;
  summary?: string;
  error?: string;
}

/** What works in the embedded Tor right now. */
export interface TorHealth {
  state: TorState;
  /** The control connection answers */
  controller: boolean;
  /** The local SOCKS port takes connections. iOS takes it back after a while in the background */
  socks: boolean;
  /** Tor has a circuit ready */
  circuit: boolean;
  port?: number;
}

export interface TorRepairResult {
  ok: boolean;
  /** The SOCKS port was moved to a fresh listener */
  reopened?: boolean;
  /** What couldn't be fixed: Tor never started, no controller, or no port would open */
  stage?: 'off' | 'control' | 'socks';
  port?: number;
}

/**
 * Codes native errors carry, besides the message. "refused" means the proxy on the phone refused the connection,
 * so the request never left the phone.
 */
export type NativeErrorKind = 'refused' | 'timeout' | 'offline' | 'network' | 'needs-pin' | 'certificate';

export function errorKind(e: unknown): NativeErrorKind | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'refused' || code === 'timeout' || code === 'offline' || code === 'network' || code === 'needs-pin' || code === 'certificate' ? code : undefined;
}

/** How the iPhone is connected right now. A VPN, such as WireGuard to a home network, shows as `other`. */
export interface NetworkPath {
  known: boolean;
  satisfied?: boolean;
  wifi: boolean;
  wired: boolean;
  cellular: boolean;
  other: boolean;
}

/** Why the widgets can't be handed anything: the build has no App Group, or this is the browser stand-in. */
export type WidgetTrouble = 'no-app-group' | 'web';

export interface NativeHttpRequest {
  url: string;
  /** POST unless said otherwise. GET sends no body. */
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  /** Route through the embedded Tor client. Required for .onion hosts. */
  useTor: boolean;
  /**
   * Without Tor: HTTPS whose chain must end in this root certificate and no other (a Lightning node's home
   * address). Fails with the code "certificate" when it doesn't.
   */
  pinPem?: string;
  /** Without Tor, before the root is known: the SHA-256 the last certificate presented must have; it comes back as rootPem. */
  captureRootSha256?: string;
  /** Never follow a redirect: the request's key goes to the address asked and no other. */
  noRedirect?: boolean;
}

export interface NativeHttpResponse {
  status: number;
  body: string;
  rootPem?: string;
}

export interface ShrikeNativePlugin {
  torStart(): Promise<void>;
  torStatus(): Promise<TorStatus>;
  /** Checks the controller, the SOCKS port and whether Tor has a circuit. */
  torCheck(): Promise<TorHealth>;
  /**
   * Moves the SOCKS port to a fresh listener if iOS took it back while the app was suspended (or with freshPort),
   * reattaching the controller when that needs it. With newCircuit, also asks Tor for new circuits. One repair
   * runs at a time. The app also does this by itself each time it comes back from the background.
   */
  torRepair(opts: { newCircuit: boolean; freshPort?: boolean }): Promise<TorRepairResult>;
  httpRequest(req: NativeHttpRequest): Promise<NativeHttpResponse>;
  /** Wi-Fi, cellular or a VPN, for choosing between a Lightning node's home address and its onion. */
  networkPath(): Promise<NetworkPath>;
  /**
   * Stores a secret in the iOS Keychain. With requireAuth the item is bound to the device passcode and
   * reading it asks for Face ID, Touch ID or the passcode every time (kSecAccessControlUserPresence). With
   * whenPasscodeSet it's read without asking, but exists only while the iPhone has a passcode.
   */
  vaultSet(opts: { key: string; value: string; requireAuth: boolean; whenPasscodeSet?: boolean }): Promise<void>;
  /**
   * Reads a Keychain item. With biometricsOnly (the app PIN is on), Face ID alone is tried first, with "Use PIN"
   * instead of the iPhone passcode, and a failure rejects with code "needs-pin" so the page can ask for the PIN.
   */
  vaultGet(opts: { key: string; prompt: string; biometricsOnly?: boolean; fallbackTitle?: string }): Promise<{ value: string | null }>;
  vaultDelete(opts: { key: string }): Promise<void>;
  /**
   * Face ID, or the passcode. With biometricsOnly, Face ID alone; pin is true when the app PIN should be asked for
   * instead. Without a passcode on the iPhone it answers ok, unless requirePasscode, which answers noPasscode.
   */
  authenticate(opts: { reason: string; biometricsOnly?: boolean; fallbackTitle?: string; requirePasscode?: boolean }): Promise<{ ok: boolean; pin?: boolean; changed?: boolean; noPasscode?: boolean }>;
  /**
   * The faces Face ID accepts, while the app PIN is on. set trusts the current ones, clear forgets them, check says
   * whether they've changed. Once they change (anyone with the passcode can add a face), Face ID alone no longer
   * opens the app or reads seed words until they're trusted again with the PIN.
   */
  biometryTrust(opts: { action: 'set' | 'clear' | 'check' }): Promise<{ changed: boolean }>;
  biometryType(): Promise<{ type: 'faceId' | 'touchId' | 'opticId' | 'none' }>;
  /**
   * Scans a QR code. With parts, for a hardware wallet's animated codes, the scanner stays open and each new code
   * read fires 'qrPart'; scanQrProgress shows how far along it is and scanQrFinish closes it, resolving with
   * "finished". Cancelling resolves with null either way.
   */
  scanQr(opts?: { parts?: boolean; title?: string }): Promise<{ value: string | null }>;
  scanQrProgress(opts: { text: string; reset?: boolean }): Promise<void>;
  scanQrFinish(): Promise<void>;
  /** Keeps the screen awake while on, as while the Krux reads codes off it. */
  keepAwake(opts: { on: boolean }): Promise<void>;
  /** Opens a link in Safari, or an onionhttp(s) link in Onion Browser. opened is false if no app takes it. */
  openUrl(opts: { url: string }): Promise<{ opened: boolean }>;
  /** Copies text that stays on this device (no Universal Clipboard) and clears itself after `seconds`. */
  copyPrivately(opts: { text: string; seconds: number }): Promise<void>;
  /**
   * Hands the widgets what to show (a WidgetSnapshot as JSON, or nothing to clear it) and asks iOS to redraw
   * them. ok is false with reason "no-app-group" when this build has no App Group to share with the widgets.
   */
  widgetsUpdate(opts: { snapshot: string | null }): Promise<{ ok: boolean; reason?: WidgetTrouble }>;
  /** The Crossbill widgets on the Home Screen and Lock Screen right now, and whether the App Group is set up. */
  widgetsInstalled(): Promise<{ ok: boolean; reason?: WidgetTrouble; widgets: { kind: string; family: string }[] }>;
  /** Fires when the person takes a screenshot. iOS can't block one, so screens showing seed words warn instead. */
  addListener(eventName: 'screenshot', listener: () => void): Promise<PluginListenerHandle>;
  /** Each new code a parts scanner reads. */
  addListener(eventName: 'qrPart', listener: (e: { value: string }) => void): Promise<PluginListenerHandle>;
}

// The target is spelled out here (rather than read from target.ts) so the iPhone build drops the StartOS code
const STARTOS_BUILD = typeof __CROSSBILL_TARGET__ !== 'undefined' && __CROSSBILL_TARGET__ === 'server';

export const ShrikeNative = registerPlugin<ShrikeNativePlugin>('ShrikeNative', {
  web: () => (STARTOS_BUILD ? import('./server-native').then((m) => new m.ShrikeNativeServer()) : import('./web-native').then((m) => new m.ShrikeNativeWeb())),
});

export const isNative = Capacitor.isNativePlatform();
