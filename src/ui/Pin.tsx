import { useEffect, useState, type ReactNode } from 'react';
import { friendlyError } from '../app/model';
import { PIN_LENGTH } from '../core/pin';
import { Choice, Screen, Sheet, useApp, useNav } from './kit';

/** Seconds left on the PIN lockout, counting down on screen. */
function usePinWait(): number {
  const app = useApp();
  const [, tick] = useState(0);
  const wait = app.pinWait();
  useEffect(() => {
    if (wait <= 0) return;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [wait]);
  return wait;
}

/**
 * Six dots and a keypad. When the sixth digit is in, `onComplete` runs; if it throws, its message shows, the
 * dots shake and clear for another try.
 */
export function PinPad({
  title,
  detail,
  onComplete,
  onCancel,
  extra,
  tone = 'paper',
}: {
  title: string;
  detail?: ReactNode;
  onComplete: (pin: string) => Promise<void>;
  onCancel?: () => void;
  /** A key bottom left, such as Face ID on the lock screen */
  extra?: { label: ReactNode; aria: string; onClick: () => void };
  tone?: 'paper' | 'band';
}) {
  const [digits, setDigits] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);
  const wait = usePinWait();
  const locked = busy || wait > 0;

  const press = (d: string) => {
    if (locked || digits.length >= PIN_LENGTH) return;
    const next = digits + d;
    setDigits(next);
    setError(null);
    if (next.length < PIN_LENGTH) return;
    setBusy(true);
    // A moment for the last dot to fill before anything moves
    setTimeout(() => {
      onComplete(next)
        .then(() => setDigits(''))
        .catch((e) => {
          setError(friendlyError(e));
          setShake((x) => x + 1);
          setDigits('');
        })
        .finally(() => setBusy(false));
    }, 120);
  };
  const del = () => !locked && setDigits((d) => d.slice(0, -1));

  // Typing digits works too, for a keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') del();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className={`pinpad${tone === 'band' ? ' on-band' : ''}`}>
      <div className="pin-title">{title}</div>
      {detail && <div className="pin-detail">{detail}</div>}
      <div key={shake} className={`pin-dots${shake ? ' shake' : ''}`} role="img" aria-label={`${digits.length} of ${PIN_LENGTH} digits entered`}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <span key={i} className={i < digits.length ? 'on' : ''} />
        ))}
      </div>
      <div className="pin-error" role="alert" aria-live="assertive">
        {wait > 0 ? `Too many wrong PINs. Try again in ${wait < 90 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}.` : error ?? ' '}
      </div>
      <div className="pin-keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
          <button key={k} type="button" onClick={() => press(k)} disabled={locked}>
            {k}
          </button>
        ))}
        {extra ? (
          <button type="button" className="pin-extra" aria-label={extra.aria} onClick={extra.onClick} disabled={busy}>
            {extra.label}
          </button>
        ) : (
          <span />
        )}
        <button type="button" onClick={() => press('0')} disabled={locked}>
          0
        </button>
        <button type="button" className="pin-del" aria-label="Delete a digit" onClick={del} disabled={locked || digits.length === 0}>
          <svg width="26" height="20" viewBox="0 0 26 20" aria-hidden>
            <path d="M8 1h15a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8l-7-9z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
            <path d="M12 6.5l7 7M19 6.5l-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      {onCancel && (
        <button type="button" className="btn quiet pin-cancel" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}

export function FaceIdGlyph() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
      <path d="M2 9V5a3 3 0 0 1 3-3h4M19 2h4a3 3 0 0 1 3 3v4M26 19v4a3 3 0 0 1-3 3h-4M9 26H5a3 3 0 0 1-3-3v-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M9 10v2M19 10v2M14 10v6h-1.5M10 19.5c2.2 1.6 5.8 1.6 8 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** When Face ID doesn't confirm it's you before the seed words are read: the app PIN, over whatever is open. */
export function PinSheet() {
  const app = useApp();
  const ask = app.pinAsk;
  if (!ask) return null;
  return (
    <Sheet title="App PIN" onClose={() => app.cancelPin()}>
      <PinPad title="Enter your app PIN" detail={ask.reason} onComplete={(pin) => app.answerPin(pin)} onCancel={() => app.cancelPin()} />
      <p className="note" style={{ textAlign: 'center', marginBottom: 0 }}>
        Then iOS asks for the iPhone passcode.
      </p>
    </Sheet>
  );
}

type Flow =
  | { step: 'idle' }
  | { step: 'new' }
  | { step: 'confirm'; pin: string }
  | { step: 'change-current' }
  | { step: 'change-new'; current: string }
  | { step: 'change-confirm'; current: string; pin: string }
  | { step: 'off' }
  | { step: 'duress-wallet' }
  | { step: 'duress-new'; wallet: string }
  | { step: 'duress-confirm'; wallet: string; pin: string }
  | { step: 'duress-current'; wallet: string; pin: string }
  | { step: 'duress-remove' }
  | { step: 'trust' };

/** Settings, App PIN: turning it on and off, changing it, and the duress PIN. */
export function PinScreen() {
  const app = useApp();
  const nav = useNav();
  const [flow, setFlow] = useState<Flow>({ step: 'idle' });
  const [msg, setMsg] = useState<string | null>(null);
  const [duress, setDuress] = useState<string | null | undefined>(undefined);
  // In a duress session this screen looks and acts as it would in a real one; the model keeps the difference
  const on = app.pinOn;

  useEffect(() => {
    let alive = true;
    void app.duressWallet().then((w) => alive && setDuress(w));
    return () => {
      alive = false;
    };
  }, [app, app.version]);

  useEffect(() => {
    void app.checkFaceId();
  }, [app]);

  const done = (text: string) => {
    setFlow({ step: 'idle' });
    setMsg(text);
  };
  const back = () => setFlow({ step: 'idle' });
  const mismatch = () => {
    throw new Error('Those don’t match. Start again.');
  };

  if (flow.step !== 'idle') {
    let pad: ReactNode = null;
    switch (flow.step) {
      case 'new':
        pad = <PinPad title="Choose a 6-digit PIN" detail="Not your iPhone passcode, and not a date or a number people know." onComplete={async (pin) => setFlow({ step: 'confirm', pin })} />;
        break;
      case 'confirm':
        pad = (
          <PinPad
            title="Enter it again"
            onComplete={async (pin) => {
              if (pin !== flow.pin) {
                setFlow({ step: 'new' });
                mismatch();
              }
              await app.setPin(pin);
              done('The app PIN is on. When Face ID doesn’t work, Crossbill asks for it instead of the iPhone passcode.');
            }}
          />
        );
        break;
      case 'change-current':
        pad = <PinPad title="Enter your current PIN" onComplete={async (current) => setFlow({ step: 'change-new', current })} />;
        break;
      case 'change-new':
        pad = <PinPad title="Choose a new PIN" onComplete={async (pin) => setFlow({ step: 'change-confirm', current: flow.current, pin })} />;
        break;
      case 'change-confirm':
        pad = (
          <PinPad
            title="Enter the new PIN again"
            onComplete={async (pin) => {
              if (pin !== flow.pin) {
                setFlow({ step: 'change-new', current: flow.current });
                mismatch();
              }
              try {
                await app.changePin(flow.current, pin);
              } catch (e) {
                setFlow({ step: 'change-current' });
                throw e;
              }
              done('PIN changed.');
            }}
          />
        );
        break;
      case 'off':
        pad = (
          <PinPad
            title="Enter your PIN to turn it off"
            onComplete={async (pin) => {
              await app.disablePin(pin);
              done('The app PIN is off. When Face ID doesn’t work, the iPhone passcode opens Crossbill again.');
            }}
          />
        );
        break;
      case 'duress-wallet':
        pad = (
          <>
            <p style={{ marginTop: 0 }}>Which wallet should the duress PIN open? Pick one with a small amount in it. Every other wallet stays hidden.</p>
            {app.networkWallets().map((w) => (
              <Choice key={w.config.id} checked={false} onSelect={() => setFlow({ step: 'duress-new', wallet: w.config.id })} title={w.config.name} />
            ))}
            {app.networkWallets().length < 2 && (
              <p className="note">With only one wallet, the duress PIN would open the same one. Add a second wallet with a small amount first.</p>
            )}
          </>
        );
        break;
      case 'duress-new':
        pad = <PinPad title="Choose a duress PIN" detail="Different from your app PIN." onComplete={async (pin) => setFlow({ step: 'duress-confirm', wallet: flow.wallet, pin })} />;
        break;
      case 'duress-confirm':
        pad = (
          <PinPad
            title="Enter the duress PIN again"
            onComplete={async (pin) => {
              if (pin !== flow.pin) {
                setFlow({ step: 'duress-new', wallet: flow.wallet });
                mismatch();
              }
              setFlow({ step: 'duress-current', wallet: flow.wallet, pin });
            }}
          />
        );
        break;
      case 'duress-current':
        pad = (
          <PinPad
            title="Now your app PIN"
            detail="To confirm it’s you setting this."
            onComplete={async (current) => {
              try {
                await app.setDuress(current, flow.pin, flow.wallet);
              } catch (e) {
                if (!/isn’t right|Too many/.test(String((e as Error).message))) setFlow({ step: 'duress-new', wallet: flow.wallet });
                throw e;
              }
              const name = app.walletById(flow.wallet)?.config.name;
              done(app.settings.widgetBalance && name ? `Duress PIN set. The Balance widget now shows ${name}, so the Home Screen matches what the duress PIN opens.` : 'Duress PIN set.');
            }}
          />
        );
        break;
      case 'trust':
        pad = (
          <PinPad
            title="Enter your PIN"
            detail="To let Face ID open Crossbill again, with the faces it accepts now."
            onComplete={async (pin) => {
              await app.trustFaceId(pin);
              done('Face ID opens Crossbill again.');
            }}
          />
        );
        break;
      case 'duress-remove':
        pad = (
          <PinPad
            title="Enter your app PIN"
            detail="To remove the duress PIN."
            onComplete={async (pin) => {
              await app.clearDuress(pin);
              done('Duress PIN removed.');
            }}
          />
        );
        break;
    }
    return (
      <div className="screen">
        <header className="bar">
          <div className="side">
            <button onClick={back}>Cancel</button>
          </div>
          <h1>App PIN</h1>
          <div className="side end" />
        </header>
        <main className="body">{pad}</main>
      </div>
    );
  }

  const decoyWallet = duress ? app.walletById(duress) : undefined;

  return (
    <Screen title="App PIN">
      {msg && <div className="banner on-banner">{msg}</div>}
      {on && app.faceIdChanged && (
        <div className="banner error" role="alert">
          Face ID on this iPhone changed since you set the PIN: a face or an appearance was added or removed. Until you confirm it was you, Crossbill asks for the PIN instead of using Face ID.
          <div style={{ marginTop: 10 }}>
            <button className="btn secondary small" onClick={() => setFlow({ step: 'trust' })}>
              It was me: use Face ID again
            </button>
          </div>
        </div>
      )}
      <p style={{ marginTop: 0 }}>
        {on
          ? 'Crossbill opens with Face ID. When Face ID doesn’t work, it asks for this PIN instead of the iPhone passcode, to open the app and before reading seed words to sign.'
          : 'A 6-digit PIN for Crossbill alone. When Face ID doesn’t work, Crossbill asks for it instead of the iPhone passcode, so someone who has seen your passcode still can’t open your wallets.'}
      </p>
      {on ? (
        <>
          <dl className="facts">
            <div>
              <dt>App PIN</dt>
              <dd>On</dd>
            </div>
          </dl>
          <div style={{ display: 'grid', gap: 10 }}>
            <button className="btn secondary" onClick={() => setFlow({ step: 'change-current' })}>
              Change PIN
            </button>
            <button className="btn secondary" onClick={() => setFlow({ step: 'off' })}>
              Turn off
            </button>
          </div>
          <>
            <div className="section-title">Duress PIN</div>
              <p className="note" style={{ marginTop: 0 }}>
                If someone forces you to open Crossbill, cancel Face ID and type the duress PIN instead of yours. Crossbill opens showing only one wallet you choose, with nothing on screen to say others exist.
              </p>
              {decoyWallet ? (
                <>
                  <dl className="facts">
                    <div>
                      <dt>Opens</dt>
                      <dd>{decoyWallet.config.name}</dd>
                    </div>
                  </dl>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <button className="btn secondary" onClick={() => setFlow({ step: 'duress-wallet' })}>
                      Change
                    </button>
                    <button className="btn secondary" onClick={() => setFlow({ step: 'duress-remove' })}>
                      Remove
                    </button>
                  </div>
                  <p className="note">
                    The Lock Screen and Home Screen still show before the PIN is typed, and a duress session leaves them as they were. Set the Balance widget to {decoyWallet.config.name}, or
                    hide its balance, in{' '}
                    <button className="btn link" onClick={() => nav.push({ name: 'widgets' })}>
                      Widgets
                    </button>
                    . Skins hint at what you hold too: the Crossbill skin gives nothing away.
                  </p>
                </>
              ) : (
                <button className="btn secondary" onClick={() => setFlow({ step: 'duress-wallet' })} disabled={duress === undefined}>
                  Set a duress PIN
                </button>
              )}
          </>
        </>
      ) : (
        <button className="btn primary" onClick={() => setFlow({ step: 'new' })}>
          Set a PIN
        </button>
      )}
      <p className="note">Forgot the PIN? Remove Crossbill from the iPhone and add your wallets again with your seed words. Wrong PINs make the next try wait longer each time.</p>
    </Screen>
  );
}
