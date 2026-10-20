// The bridge to the app's own native plugin (ios/App/App/ShrikeNativePlugin.swift). In a browser during
// development it falls back to web-native.ts, which is for testing only and never holds a real seed.

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
export type NativeErrorKind = 'refused' | 'timeout' | 'offline' | 'network';

export function errorKind(e: unknown): NativeErrorKind | undefined {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'refused' || code === 'timeout' || code === 'offline' || code === 'network' ? code : undefined;
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
  httpRequest(req: NativeHttpRequest): Promise<{ status: number; body: string }>;
  /**
   * Stores a secret in the iOS Keychain. With requireAuth the item is bound to the device passcode and
   * reading it asks for Face ID, Touch ID or the passcode every time (kSecAccessControlUserPresence).
   */
  vaultSet(opts: { key: string; value: string; requireAuth: boolean }): Promise<void>;
  vaultGet(opts: { key: string; prompt: string }): Promise<{ value: string | null }>;
  vaultDelete(opts: { key: string }): Promise<void>;
  authenticate(opts: { reason: string }): Promise<{ ok: boolean }>;
  biometryType(): Promise<{ type: 'faceId' | 'touchId' | 'opticId' | 'none' }>;
  scanQr(): Promise<{ value: string | null }>;
  /** Opens a link in Safari, or an onionhttp(s) link in Onion Browser. opened is false if no app takes it. */
  openUrl(opts: { url: string }): Promise<{ opened: boolean }>;
  /** Copies text that stays on this device (no Universal Clipboard) and clears itself after `seconds`. */
  copyPrivately(opts: { text: string; seconds: number }): Promise<void>;
  /**
   * Hands the widgets what to show (a WidgetSnapshot as JSON, or nothing to clear it) and asks iOS to redraw
   * them. ok is false with reason "no-app-group" when this build has no App Group to share with the widgets.
   */
  widgetsUpdate(opts: { snapshot: string | null }): Promise<{ ok: boolean; reason?: WidgetTrouble }>;
  /** The Shrike widgets on the Home Screen and Lock Screen right now, and whether the App Group is set up. */
  widgetsInstalled(): Promise<{ ok: boolean; reason?: WidgetTrouble; widgets: { kind: string; family: string }[] }>;
  /** Fires when the person takes a screenshot. iOS can't block one, so screens showing seed words warn instead. */
  addListener(eventName: 'screenshot', listener: () => void): Promise<PluginListenerHandle>;
}

export const ShrikeNative = registerPlugin<ShrikeNativePlugin>('ShrikeNative', {
  web: () => import('./web-native').then((m) => new m.ShrikeNativeWeb()),
});

export const isNative = Capacitor.isNativePlatform();
