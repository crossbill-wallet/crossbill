import { useEffect } from 'react';
import { BALANCE_WIDGET, FAMILY_NAMES, PRICE_WIDGET } from '../app/widgets';
import { Choice, Screen, Toggle, useApp } from './kit';

const KIND_NAMES: Record<string, string> = { [PRICE_WIDGET]: 'XBT price', [BALANCE_WIDGET]: 'Balance' };

function clock(ms: number): string {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** The Home Screen and Lock Screen widgets: what they show, the balance setting, and how to add them. */
export function WidgetsScreen() {
  const app = useApp();
  const w = app.widgets;
  const snap = app.widgetSnapshot;
  const wallets = app.networkWallets();
  const shown = app.widgetWallet();

  // Widgets added while this screen was away show up when it opens
  useEffect(() => {
    void app.checkWidgets();
  }, [app]);

  return (
    <Screen title="Widgets">
      <p style={{ marginTop: 0 }}>
        Two widgets, XBT price and Balance. On the Home Screen each comes as a small square or a wide rectangle, and on the Lock Screen as a round or a rectangular one. Tap one to
        open Shrike on the Market or Wallet tab.
      </p>
      <p className="note">
        Widgets can’t run Tor, so they show what Shrike last got through it, with the time. They change when you open Shrike, and every few minutes while it stays open.
      </p>

      {w.status === 'no-app-group' && (
        <div className="banner error" role="alert">
          This build of Shrike can’t hand anything to its widgets, because the App Group they share isn’t set up. Run <span className="mono">npm run ios:sync</span>, then build
          again in Xcode. GETTING-STARTED.md has the steps under Widgets.
        </div>
      )}
      {w.status === 'web' && <div className="banner">Widgets are part of the iPhone app.</div>}

      <div className="section-title">What they show now</div>
      <dl className="facts" style={{ marginTop: 0 }}>
        <div>
          <dt>XBT price</dt>
          <dd>
            {!app.settings.prices ? (
              'Prices are off'
            ) : snap?.price ? (
              <>
                <span className="mono">{snap.price.price}</span>
                <div className="note">as of {clock(snap.price.at)}</div>
              </>
            ) : (
              'None yet. Open the Market tab to get it'
            )}
          </dd>
        </div>
        <div>
          <dt>Balance</dt>
          <dd>
            {!app.settings.widgetBalance ? (
              'Hidden'
            ) : snap?.balance ? (
              <>
                <span className="mono">
                  {snap.balance.amount} {snap.balance.unit}
                </span>
                <div className="note">
                  {snap.balance.wallet}, as of {clock(snap.balance.at)}
                </div>
              </>
            ) : (
              'None yet. It shows once the wallet has synced'
            )}
          </dd>
        </div>
        <div>
          <dt>On your screens</dt>
          <dd>
            {w.installed.length === 0
              ? 'No Shrike widgets yet'
              : w.installed.map((x, i) => (
                  <div key={i}>
                    {KIND_NAMES[x.kind] ?? x.kind}, {FAMILY_NAMES[x.family] ?? x.family}
                  </div>
                ))}
          </dd>
        </div>
      </dl>

      <div className="section-title">Balance widget</div>
      <Toggle
        label="Show the balance"
        detail="Anyone who can see your iPhone can read a widget, on the Lock Screen too. Off, the Balance widget only says it’s hidden, and the balance isn’t handed to it at all."
        checked={app.settings.widgetBalance}
        onChange={(v) => void app.updateSettings({ widgetBalance: v })}
      />
      {app.settings.widgetBalance && (
        <p className="note">
          To have iOS hide the Lock Screen balance until Face ID recognizes you, turn off Lock Screen Widgets in the iPhone’s Settings, under Face ID &amp; Passcode, Allow Access
          When Locked.
        </p>
      )}
      {app.settings.widgetBalance && wallets.length > 1 && (
        <>
          <div className="field" style={{ marginBottom: 6 }}>
            <span className="label">Wallet</span>
          </div>
          {wallets.map((x, i) => (
            <Choice
              key={x.config.id}
              checked={shown?.config.id === x.config.id}
              onSelect={() => void app.updateSettings({ widgetWallet: i === 0 ? null : x.config.id })}
              title={x.config.name}
              detail={i === 0 ? 'The wallet Shrike opens to' : undefined}
            />
          ))}
        </>
      )}

      <div className="section-title">Adding one</div>
      <ol className="steps">
        <li>
          <strong>Home Screen.</strong> Touch and hold an empty spot until the apps jiggle, tap Edit, then Add Widget. Search for Shrike, pick XBT price or Balance, swipe to
          the size you want, and tap Add Widget.
        </li>
        <li>
          <strong>Lock Screen.</strong> Touch and hold the Lock Screen, tap Customize, then Lock Screen. Tap the row of widgets under the clock, and pick a Shrike widget.
        </li>
      </ol>
      {w.sentAt > 0 && <p className="note">Last handed to the widgets at {clock(w.sentAt)}.</p>}
    </Screen>
  );
}
