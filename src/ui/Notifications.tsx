import { useEffect, useState } from 'react';
import type { AppModel } from '../app/model';
import { friendlyError } from '../app/model';
import { isNative, ShrikeNative } from '../app/native';
import { Toggle, useApp } from './kit';

/** The line under Notifications on the Settings tab. */
export function notificationsSummary(app: AppModel): string {
  const n = app.settings.notify;
  if (!n.on) return 'Off';
  const kinds = [n.firstConf && 'first confirmation', n.sixthConf && 'sixth', n.lightning && app.lightning.paired && 'Lightning'].filter(Boolean);
  return kinds.length ? `On: ${kinds.join(', ')}` : 'On, every kind turned off';
}

/** Settings, Notifications: background checks, and which notifications they give. */
export function NotificationSettings() {
  const app = useApp();
  const n = app.settings.notify;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);

  // Notifications can be turned off for the app in the iPhone's Settings while Crossbill thinks they're on
  useEffect(() => {
    if (!n.on || !isNative) return;
    ShrikeNative.notifyStatus()
      .then((r) => setDenied(r.status === 'denied'))
      .catch(() => undefined);
  }, [n.on]);

  const turn = async (on: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await app.setNotifications(on);
      setDenied(false);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Toggle
        label="Notifications"
        detail="Crossbill checks your node in the background and tells you when a payment confirms."
        checked={n.on}
        disabled={busy}
        onChange={(v) => void turn(v)}
      />
      {error && (
        <div className="banner error" role="alert">
          {error}
        </div>
      )}
      {n.on && denied && (
        <div className="banner error" role="alert">
          Notifications for Crossbill are off in the iPhone’s Settings, so none will show. Turn them on in Settings, Notifications, Crossbill.
        </div>
      )}
      {n.on && (
        <>
          <Toggle
            label="First confirmation"
            detail="When a payment you sent or received goes into a block."
            checked={n.firstConf}
            onChange={(v) => void app.updateNotify({ firstConf: v })}
          />
          <Toggle
            label="Sixth confirmation"
            detail="When it has 6 confirmations and is settled."
            checked={n.sixthConf}
            onChange={(v) => void app.updateNotify({ sixthConf: v })}
          />
          <Toggle
            label="Lightning payments"
            detail={app.lightning.paired ? 'When a Lightning payment to or from your node goes through.' : 'Once Crossbill is paired with your Lightning Fork node.'}
            checked={n.lightning}
            onChange={(v) => void app.updateNotify({ lightning: v })}
          />
          <Toggle
            label="Show amounts"
            detail="Notifications show on the Lock Screen, where anyone holding your iPhone can read them. Off, they say a payment confirmed but not how much."
            checked={n.amounts}
            onChange={(v) => void app.updateNotify({ amounts: v })}
          />
        </>
      )}
      <p className="note">
        iOS decides when Crossbill can check: at most about every 15 minutes, less often when the battery is low or the app is rarely used, and not at all after you swipe Crossbill away in the app
        switcher. Nothing shows while Crossbill is open, since the screens already show it.
      </p>
      <p className="note">
        To check while your iPhone is locked, Crossbill keeps your node’s password and Lightning key readable while it’s locked, once you’ve unlocked it after turning it on. They still never leave this
        iPhone. Turning notifications off puts them back as before, readable only while it’s unlocked.
      </p>
    </>
  );
}
