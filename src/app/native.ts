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
  /** Asks Tor to reload (SIGNAL RELOAD and NEWNYM), reopening listeners iOS may have closed while suspended. */
  torRecover(): Promise<void>;
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
  /** Fires when the person takes a screenshot. iOS can't block one, so screens showing seed words warn instead. */
  addListener(eventName: 'screenshot', listener: () => void): Promise<PluginListenerHandle>;
}

export const ShrikeNative = registerPlugin<ShrikeNativePlugin>('ShrikeNative', {
  web: () => import('./web-native').then((m) => new m.ShrikeNativeWeb()),
});

export const isNative = Capacitor.isNativePlatform();
