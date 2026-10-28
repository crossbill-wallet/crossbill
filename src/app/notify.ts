// Notifications from the phone itself: a payment's first and sixth confirmation, and Lightning payments that
// finished. iOS wakes the app for a short background check when it chooses, at most about every 15 minutes, and
// never after the app is swiped away. The rules are in src/core/notices.ts; this keeps their state file and hands
// the notices to iOS. Nothing is shown while the app is open: the screens already show it.

import { App as CapApp } from '@capacitor/app';
import { confirmationNotices, EMPTY_NOTICE_STATE, lightningNotices, type Notice, type NoticeKinds, type NoticeLightning, type NoticeState, type NoticeTx } from '../core/notices';
import { isNative, ShrikeNative } from './native';
import { readJson, writeJson } from './storage';

export interface NotifySettings extends NoticeKinds {
  /** Background checks and notifications at all */
  on: boolean;
}

export const DEFAULT_NOTIFY: NotifySettings = { on: false, firstConf: true, sixthConf: true, lightning: true, amounts: false };

const STATE_FILE = 'notify-state.json';

export class Notifier {
  private state: NoticeState | null = null;
  /** One update to the state at a time: a background check and a foreground refresh can overlap */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly settings: () => NotifySettings,
    private readonly fmt: (sats: number) => string,
  ) {}

  /** Forgets everything, so the next check only takes note. Done each time notifications are turned on. */
  async reset(): Promise<void> {
    await this.run(async () => {
      this.state = { ...EMPTY_NOTICE_STATE };
      await writeJson(STATE_FILE, this.state);
    });
  }

  /** After the wallets on a network were checked against the node. */
  chain(network: string, tip: number, txs: NoticeTx[]): Promise<void> {
    return this.update((s, kinds) => confirmationNotices(s, network, tip, txs, kinds, this.fmt));
  }

  /** After the Lightning node's activity was read. */
  lightning(items: NoticeLightning[]): Promise<void> {
    return this.update((s, kinds) => lightningNotices(s, items, kinds, this.fmt));
  }

  private update(step: (s: NoticeState, kinds: NoticeKinds) => { notices: Notice[]; state: NoticeState }): Promise<void> {
    const kinds = this.settings();
    if (!kinds.on) return Promise.resolve();
    return this.run(async () => {
      if (!this.state) this.state = (await readJson<NoticeState>(STATE_FILE)) ?? { ...EMPTY_NOTICE_STATE };
      const { notices, state } = step(this.state, kinds);
      this.state = state;
      await writeJson(STATE_FILE, state);
      if (!notices.length || (await appOpen())) return;
      for (const n of notices) await ShrikeNative.notify(n).catch(() => undefined);
    });
  }

  private run(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }
}

/** The app is on screen. A background check runs with it in the background. */
async function appOpen(): Promise<boolean> {
  if (!isNative) return document.visibilityState === 'visible';
  try {
    return (await CapApp.getState()).isActive;
  } catch {
    return false;
  }
}
