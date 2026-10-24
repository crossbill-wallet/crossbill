import { useEffect, useMemo, useState } from 'react';
import { encodeSecret, groupSecret, newTotpSecret, otpauthUri } from '../core/totp';
import { friendlyError } from '../app/model';
import { ShrikeNative } from '../app/native';
import { Qr, Screen, SecondFactorField, codeReady, copyPrivately, useApp, useNav } from './kit';

const ISSUER = 'Crossbill';
const ACCOUNT = 'iPhone wallet';

/**
 * Turning two-factor on: what it does, the key for the authenticator (QR code, typed key, or straight into an
 * authenticator on this iPhone), a code to prove it took, then the recovery codes. Offered once after setup,
 * with Skip, and any time from Settings.
 */
export function TwoFactorSetup({ onboarding, onDone, onCancel }: { onboarding?: boolean; onDone: () => void; onCancel?: () => void }) {
  const app = useApp();
  const [step, setStep] = useState<'intro' | 'key'>('intro');
  const secret = useMemo(() => encodeSecret(newTotpSecret()), []);
  const uri = otpauthUri(secret, ACCOUNT, ISSUER);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (step === 'intro') {
    return (
      <Screen title="Two-factor" back={!onboarding && !onCancel} end={onCancel ? <button onClick={onCancel}>Cancel</button> : undefined}>
        <h2 className="lead">Ask for a code before every send</h2>
        <p>
          With two-factor on, sending needs a 6-digit code from an authenticator app as well as Face ID. That covers every send, raising a fee and cancelling. Showing seed words needs a code
          too.
        </p>
        <p>Any authenticator app works, such as Google Authenticator, Microsoft Authenticator, 2FAS, Ente Auth, or the Passwords app on iPhone.</p>
        <div className="banner">
          It’s strongest with the authenticator on another device, such as a second phone or a tablet. Then someone who has this iPhone and its passcode still can’t send.
        </div>
        <p className="note">
          The code is checked on this iPhone. It guards this app, not your seed words: anyone who has the words can spend with another wallet. Keep them on paper, out of sight.
        </p>
        <div style={{ display: 'grid', gap: 10, marginTop: 18 }}>
          <button className="btn primary" onClick={() => setStep('key')}>
            Set up two-factor
          </button>
          {onboarding && (
            <button className="btn secondary" onClick={onDone}>
              Skip for now
            </button>
          )}
        </div>
        {onboarding && <p className="note">You can turn it on later in Settings, under Security.</p>}
      </Screen>
    );
  }

  if (step === 'key') {
    return (
      <Screen title="Add to authenticator" back={false} end={<button onClick={() => setStep('intro')}>Back</button>}>
        <p style={{ marginTop: 0 }}>Scan this with your authenticator app. It adds an entry called Crossbill.</p>
        <Qr text={uri} />
        <div className="section-title">Or type this key</div>
        <div className="secret mono">{groupSecret(secret)}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '10px 0 4px' }}>
          <button className="btn secondary small" onClick={async () => setNote((await copyPrivately(secret)) ? 'Key copied. It stays on this iPhone and clears from the clipboard in a minute.' : null)}>
            Copy key
          </button>
          <button
            className="btn secondary small"
            onClick={async () => {
              const r = await ShrikeNative.openUrl({ url: uri }).catch(() => ({ opened: false }));
              setNote(r.opened ? 'Add the entry in the app that opened, then come back here.' : 'No app on this iPhone opened it. Scan the QR code from your authenticator instead.');
            }}
          >
            Add to an app on this iPhone
          </button>
        </div>
        <p className="note">{note ?? 'Time-based, 6 digits, every 30 seconds, if your app asks.'}</p>
        <div className="section-title">Then check it works</div>
        <SecondFactorFieldPlain value={code} onChange={setCode} />
        {error && <div className="banner error">{error}</div>}
        <button
          className="btn primary"
          disabled={busy || !/^\d{6}$/.test(code.replace(/\s/g, ''))}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              // The recovery codes come up next, from Root, until they're confirmed as saved
              await app.enableTwoFactor(secret, code);
              onDone();
            } catch (e) {
              setError(friendlyError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Checking' : 'Turn on two-factor'}
        </button>
      </Screen>
    );
  }

  return null;
}

/** The six-digit field during setup, before there are recovery codes to offer instead. */
function SecondFactorFieldPlain({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="field">
      <label htmlFor="otp-setup">The 6-digit code your authenticator shows</label>
      <input
        id="otp-setup"
        className="input mono code-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={7}
        placeholder="000000"
      />
    </div>
  );
}

/** New recovery codes, shown until the person says they've saved them. */
export function RecoveryCodes({ codes, title, onDone }: { codes: string[]; title: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Screen title={title} back={false}>
      <h2 className="lead">Save your recovery codes</h2>
      <p>If you lose the authenticator, each of these works once in place of a code. Write them on the paper with your seed words.</p>
      <ol className="recovery-codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <p className="note">This is the only time they’re shown. Settings can make a new set later, which replaces these.</p>
      <div style={{ display: 'grid', gap: 10 }}>
        <button className="btn secondary" onClick={async () => setCopied(await copyPrivately(codes.join('\n'), 120))}>
          {copied ? 'Copied for two minutes, on this iPhone only' : 'Copy them'}
        </button>
        <button className="btn primary" onClick={onDone}>
          I’ve saved them
        </button>
      </div>
    </Screen>
  );
}

/** Settings, Security, Two-factor. */
export function TwoFactorScreen() {
  const app = useApp();
  const nav = useNav();
  const [mode, setMode] = useState<'status' | 'setup' | 'off' | 'renew'>('status');
  const [since, setSince] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = app.settings.twoFactor;

  useEffect(() => {
    if (on) void app.twoFactorSince().then(setSince);
  }, [on, app]);

  if (mode === 'setup') return <TwoFactorSetup onCancel={() => setMode('status')} onDone={() => setMode('status')} />;

  if (mode === 'off' || mode === 'renew') {
    const off = mode === 'off';
    return (
      <Screen title={off ? 'Turn off two-factor' : 'New recovery codes'} back={false} end={<button onClick={() => setMode('status')}>Cancel</button>}>
        <p style={{ marginTop: 0 }}>
          {off ? 'Sends will need Face ID only. Enter a code to confirm it’s you.' : 'A new set of recovery codes replaces the ones you have now, used or not. Enter a code to confirm it’s you.'}
        </p>
        <SecondFactorField value={code} onChange={setCode} autoFocus />
        {error && <div className="banner error">{error}</div>}
        <button
          className={off ? 'btn danger' : 'btn primary'}
          disabled={busy || !codeReady(code)}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              // New codes come up from Root until they're confirmed as saved
              if (off) await app.disableTwoFactor(code);
              else await app.replaceRecoveryCodes(code);
              setMode('status');
              setCode('');
            } catch (e) {
              setError(friendlyError(e));
              setCode('');
            } finally {
              setBusy(false);
            }
          }}
        >
          {off ? 'Turn off' : 'Make new codes'}
        </button>
      </Screen>
    );
  }

  return (
    <Screen title="Two-factor">
      {on ? (
        <>
          <div className="banner on-banner">
            <strong>On</strong>
            {since ? ` since ${new Date(since).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}` : ''}. A code from your authenticator is needed to send, raise a fee,
            cancel, show seed words, and turn this off.
          </div>
          <dl className="facts">
            <div>
              <dt>Recovery codes left</dt>
              <dd className="mono">{app.recoveryLeft} of 8</dd>
            </div>
          </dl>
          <div style={{ display: 'grid', gap: 10 }}>
            <button className="btn secondary" onClick={() => setMode('renew')}>
              Make new recovery codes
            </button>
            <button className="btn danger" onClick={() => setMode('off')}>
              Turn off two-factor
            </button>
          </div>
          <div className="section-title">Lost the authenticator?</div>
          <p className="note" style={{ marginTop: 0 }}>
            A recovery code works in place of a code, once each. Use one to turn two-factor off, then set it up again with your new authenticator. Lost both? Your coins are safe with your seed words:
            delete this app, install it again, and add your wallets with their seed words.
          </p>
        </>
      ) : (
        <>
          <p style={{ marginTop: 0 }}>Off. Sends need Face ID only.</p>
          <button className="btn primary" onClick={() => setMode('setup')}>
            Set up two-factor
          </button>
          <button className="btn quiet" onClick={() => nav.pop()}>
            Not now
          </button>
        </>
      )}
    </Screen>
  );
}
