// Paperclip's Krux hardware wallet: adding a wallet from its key, linking it to a wallet already on the phone,
// signing a send on it by QR code or microSD, and the Settings page with its guide and links.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import QRCode from 'qrcode';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { base64 } from '@scure/base';
import { SCRIPT_TYPE_INFO, type ScriptType } from '../core/script';
import { matchWallet, type HardwareKey } from '../core/hwkey';
import { bbqrEncode, DENSITY_VERSION, QrAssembler, readPsbtFile, type QrDensity, type ScanResult } from '../core/qrtransfer';
import { kruxWarnsUnverifiedAmounts } from '../core/psbt';
import { friendlyError, signerOf, type RescanChoice, type Signer, type WalletRuntime } from '../app/model';
import { isNative, ShrikeNative } from '../app/native';
import { KRUX_LINKS } from '../app/links';
import { Address, Amount, Chevron, Choice, Field, Screen, Toggle, openLink, useApp, useNav } from './kit';
import { isServer } from '../app/target';
import { SentView } from './Send';

/** What the Krux calls each address type, in Wallet, Customize, Script Type. */
export const KRUX_TYPE: Record<ScriptType, string> = {
  P2WPKH: 'Native Segwit - 84',
  P2SH_P2WPKH: 'Nested Segwit - 49',
  P2TR: 'Taproot - 86 (Experimental)',
  P2PKH: 'Legacy - 44',
};

/** The Krux's menu entry for the key Crossbill reads, under Extended Public Key. Testnet keys are TPUB, UPUB and VPUB. */
export function kruxKeyMenu(type: ScriptType, testnet = false): string {
  const name = type === 'P2WPKH' ? (testnet ? 'VPUB' : 'ZPUB') : type === 'P2SH_P2WPKH' ? (testnet ? 'UPUB' : 'YPUB') : testnet ? 'TPUB' : 'XPUB';
  return `${name} - QR Code`;
}

export function signerText(s: Signer): string {
  return s === 'krux' ? 'Signs on your Krux' : s === 'both' ? 'Signs on this iPhone or your Krux' : 'Signs on this iPhone';
}

/**
 * Scans codes until a whole result is in: one code, or every part of an animated series. Null if cancelled.
 * The scanner shows how many parts are in, and starts over if a series doesn't decode.
 */
export async function scanCodes(title: string): Promise<ScanResult | null> {
  const asm = new QrAssembler();
  let result: ScanResult | null = null;
  let restarts = 0;
  const handle = await ShrikeNative.addListener('qrPart', ({ value }) => {
    if (result) return;
    try {
      const r = asm.add(value);
      if (r) {
        result = r;
        void ShrikeNative.scanQrFinish();
        return;
      }
      const p = asm.progress;
      // A code from another series dropped the parts read so far: the scanner has to pass them on again
      const reset = asm.restarts !== restarts;
      restarts = asm.restarts;
      if (p) void ShrikeNative.scanQrProgress({ text: `${p.have} of ${p.total} codes read`, reset });
    } catch (e) {
      asm.reset();
      void ShrikeNative.scanQrProgress({ text: friendlyError(e), reset: true });
    }
  });
  try {
    const res = await ShrikeNative.scanQr({ parts: true, title });
    return res.value == null ? null : result;
  } finally {
    await handle.remove();
  }
}

/** Reads a file the person picks, as bytes. */
function pickFile(input: HTMLInputElement | null): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    if (!input) return resolve(null);
    input.onchange = async () => {
      const f = input.files?.[0];
      input.value = '';
      resolve(f ? new Uint8Array(await f.arrayBuffer()) : null);
    };
    input.click();
  });
}

/** Saves the PSBT as a file, through the Share sheet on the iPhone, for Save to Files onto a microSD card. */
async function savePsbtFile(psbt: Uint8Array): Promise<void> {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const name = `crossbill-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.psbt`;
  if (isNative) {
    // No encoding: Filesystem takes the data as base64 and writes the bytes
    const res = await Filesystem.writeFile({ path: name, data: base64.encode(psbt), directory: Directory.Cache });
    try {
      await Share.share({ title: 'Transaction for your Krux', url: res.uri });
    } finally {
      await Filesystem.deleteFile({ path: name, directory: Directory.Cache }).catch(() => undefined);
    }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([psbt.slice().buffer], { type: 'application/octet-stream' }));
  a.download = name;
  a.click();
}

const FRAME_MS: Record<QrDensity, number> = { easy: 600, standard: 400, dense: 400 };

/** A series of QR codes shown one after another, on white, with a count under them. */
function AnimatedQr({ parts, interval }: { parts: string[]; interval: number }) {
  const [svgs, setSvgs] = useState<string[]>([]);
  const [i, setI] = useState(0);
  useEffect(() => {
    let alive = true;
    Promise.all(parts.map((p) => QRCode.toString(p, { type: 'svg', margin: 2, errorCorrectionLevel: 'L' }))).then((s) => {
      if (!alive) return;
      setSvgs(s);
      setI(0);
    });
    return () => {
      alive = false;
    };
  }, [parts]);
  useEffect(() => {
    if (svgs.length < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % svgs.length), interval);
    return () => clearInterval(t);
  }, [svgs, interval]);
  return (
    <>
      <div className="qr qr-krux" role="img" aria-label={`QR code ${i + 1} of ${parts.length}`} dangerouslySetInnerHTML={{ __html: svgs[i] ?? '' }} />
      <p className="note" style={{ textAlign: 'center', marginTop: -8 }}>
        {parts.length > 1 ? `Code ${i + 1} of ${parts.length}, repeating` : 'One code'}
      </p>
    </>
  );
}

/** The two ways a Krux's key reaches the phone: its QR code, or the .pub file it saves to microSD. */
function KeyButtons({ onKey, busy, label = 'Scan the Krux’s key', noFile }: { onKey: (text: string, from: 'camera' | 'file') => void; busy?: boolean; label?: string; noFile?: boolean }) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <button
        className="btn primary"
        disabled={busy}
        onClick={async () => {
          const r = await ShrikeNative.scanQr().catch(() => ({ value: null }));
          if (r.value) onKey(r.value, 'camera');
        }}
      >
        {label}
      </button>
      {!noFile && (
        <button
          className="btn secondary"
          disabled={busy}
          onClick={async () => {
            const bytes = await pickFile(fileRef.current);
            if (bytes) onKey(new TextDecoder().decode(bytes), 'file');
          }}
        >
          Open the key file from microSD
        </button>
      )}
      <input ref={fileRef} type="file" hidden />
    </div>
  );
}

function KeyFacts({ k }: { k: HardwareKey }) {
  return (
    <dl className="facts">
      <div>
        <dt>Master fingerprint</dt>
        <dd className="mono">{k.fingerprint}</dd>
      </div>
      <div>
        <dt>Address type</dt>
        <dd>{SCRIPT_TYPE_INFO[k.scriptType].label}</dd>
      </div>
      <div>
        <dt>Derivation</dt>
        <dd className="mono">{k.derivation}</dd>
      </div>
    </dl>
  );
}

// ------------------------------------------------------------------------------------------- adding

/**
 * Add a wallet, Use my Krux: read the Krux's key, then name the wallet and say how far back the node should look.
 * The phone keeps the public key only.
 */
export function AddKrux({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const app = useApp();
  const nav = useNav();
  const [key, setKey] = useState<HardwareKey | null>(null);
  const [onNode, setOnNode] = useState(false);
  const [restored, setRestored] = useState<string | null>(null);
  const [existing, setExisting] = useState<WalletRuntime | null>(null);
  const [name, setName] = useState(app.networkWallets().length ? 'Krux' : 'My Krux');
  const [rescan, setRescan] = useState<RescanChoice>({ kind: 'date' });
  const [since, setSince] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const testnet = app.settings.network !== 'mainnet';

  const read = async (text: string) => {
    setError(null);
    setExisting(null);
    let k: HardwareKey;
    try {
      k = app.readKruxKey(text);
    } catch (e) {
      setError(friendlyError(e));
      return;
    }
    const { wallet, waiting } = app.kruxKeyFor(k);
    if (wallet) {
      if (signerOf(wallet.config) === 'phone') setExisting(wallet);
      else setError(`${wallet.config.name} is already on this ${isServer ? 'server' : 'phone'}, signed on this Krux.`);
      return;
    }
    setBusy(true);
    try {
      setOnNode(await app.kruxOnNode(k));
      if (waiting) {
        setName(waiting.config.name);
        setRestored(waiting.config.name);
      }
      setKey(k);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  if (!key) {
    return (
      <Screen title="Use my Krux" back={false} end={<button onClick={onBack}>Back</button>}>
        <p style={{ marginTop: 0 }}>Your seed words stay on the Krux. {isServer ? 'This server' : 'This iPhone'} keeps the wallet’s public key, to watch it and to build sends for the Krux to sign.</p>
        <ol className="steps">
          <li>
            On the Krux, choose <strong>Load Mnemonic</strong>, <strong>Words</strong>, and type your seed words. Or choose <strong>New Mnemonic</strong> to make new ones, and write them on the backup
            card.
          </li>
          <li>
            On the screen that follows, use <strong>Passphrase</strong> if the wallet has one, and <strong>Customize</strong> to check Network is <strong>{testnet ? 'Testnet' : 'Mainnet'}</strong> and
            Script Type is the address type you want (<strong>{KRUX_TYPE.P2WPKH}</strong> is Crossbill’s default). With new words, both are under <strong>Wallet Options</strong>.
          </li>
          <li>
            Choose <strong>Load Wallet</strong> (<strong>Continue</strong> with new words), then <strong>Extended Public Key</strong>, and show the <strong>{kruxKeyMenu('P2WPKH', testnet)}</strong>. For
            Nested Segwit it’s the <strong>{kruxKeyMenu('P2SH_P2WPKH', testnet)}</strong>; for Taproot or Legacy, the <strong>{kruxKeyMenu('P2TR', testnet)}</strong>.
          </li>
        </ol>
        {existing && (
          <div className="banner on-banner">
            <p style={{ marginTop: 0 }}>
              That’s <strong>{existing.config.name}</strong>, already on this phone with its seed words. Link the Krux to it instead, and choose there whether to keep the seed words on this iPhone.
            </p>
            <button className="btn primary" style={{ width: '100%' }} onClick={() => nav.push({ name: 'krux-link', id: existing.config.id })}>
              Link the Krux to {existing.config.name}
            </button>
          </div>
        )}
        {error && <div className="banner error">{error}</div>}
        <KeyButtons onKey={(t) => void read(t)} busy={busy} label={busy ? 'Checking your node' : 'Scan the Krux’s key'} />
      </Screen>
    );
  }

  const sinceUnix = since ? Math.floor(new Date(since + 'T00:00:00Z').getTime() / 1000) - 86400 * 2 : NaN;
  const ready = onNode || rescan.kind !== 'date' || Number.isFinite(sinceUnix);
  return (
    <Screen title="Wallet details" back={false} end={<button onClick={() => setKey(null)}>Back</button>}>
      {restored && <div className="banner on-banner">This is {restored} from your backup. Its labels and frozen coins come back with it.</div>}
      {onNode && <div className="banner">Your node already watches this wallet, so its history is ready with no scan.</div>}
      <KeyFacts k={key} />
      <Field label="Name" htmlFor="kname">
        <input id="kname" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      {!onNode && (
        <>
          <div className="section-title">History</div>
          <Choice checked={rescan.kind === 'date'} onSelect={() => setRescan({ kind: 'date' })} title="Scan from a date" detail="Your node looks for payments from the day before this date onward." />
          {rescan.kind === 'date' && (
            <div className="field">
              <input className="input" type="date" value={since} onChange={(e) => setSince(e.target.value)} aria-label="Date the wallet was created" />
            </div>
          )}
          <Choice checked={rescan.kind === 'full'} onSelect={() => setRescan({ kind: 'full' })} title="Scan the whole chain" detail="Finds everything, but can take hours on a small node." />
          <Choice checked={rescan.kind === 'new'} onSelect={() => setRescan({ kind: 'new' })} title="It has never been used" detail="No scan. Payments made before today won’t show." />
        </>
      )}
      {busy && app.conn.message && (
        <p className="note">
          {app.conn.message}
          {app.conn.progress != null ? ` (${app.conn.progress}%)` : ''}
        </p>
      )}
      {error && <div className="banner error">{error}</div>}
      <button
        className="btn primary"
        disabled={busy || !ready || !name.trim()}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const choice: RescanChoice = onNode ? { kind: 'existing' } : rescan.kind === 'date' ? { kind: 'date', since: sinceUnix } : rescan;
            await app.addKruxWallet({ name, key, rescan: choice });
            onDone();
          } catch (e) {
            setError(friendlyError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Adding' : 'Add wallet'}
      </button>
      <p className="note">No seed words go on this {isServer ? 'server' : 'iPhone'}. Every send from this wallet is signed on the Krux.</p>
    </Screen>
  );
}

// ------------------------------------------------------------------------------------------- linking

/**
 * Links a wallet whose seed words are on this phone to a Krux holding the same ones. The Krux's key has to match
 * the wallet's; then the person chooses whether the seed words stay on this iPhone. With removeOnly, for a wallet
 * already linked, the choice is to take them off.
 */
export function KruxLink({ id, removeOnly }: { id: string; removeOnly?: boolean }) {
  const app = useApp();
  const nav = useNav();
  const w = app.walletById(id);
  const [key, setKey] = useState<HardwareKey | null>(null);
  const [fromFile, setFromFile] = useState(false);
  const [remove, setRemove] = useState(true);
  const [written, setWritten] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Signer | null>(null);
  if (!w) return <Screen title="Krux">{null}</Screen>;
  const c = w.config;
  const account = Number(/\/(\d+)'?$/.exec(c.derivation)?.[1] ?? 0);
  const testnet = c.network !== 'mainnet';
  // Seed words leave this iPhone only on a key read off the Krux's screen just now, which shows the Krux holds them
  // now. A key file can be weeks old.
  const removing = removeOnly || (remove && !fromFile);

  if (done) {
    return (
      <Screen title="Linked" back={false}>
        <div className="banner on-banner">
          {done === 'krux'
            ? `${c.name} now signs only on your Krux. Its seed words are no longer on this iPhone: keep your paper copy safe, away from the Krux.`
            : `${c.name} can now be signed on this iPhone or on your Krux. Each send asks which.`}
        </div>
        <button className="btn primary" onClick={() => nav.pop()}>
          Done
        </button>
      </Screen>
    );
  }

  return (
    <Screen title={removeOnly ? 'Seed words off this iPhone' : 'Sign with a Krux'}>
      {!key ? (
        <>
          <p style={{ marginTop: 0 }}>
            {removeOnly
              ? `Before the seed words leave this iPhone, scan the key off the Krux’s screen, so Crossbill knows the Krux holds ${c.name}’s seed words now.`
              : `The Krux needs ${c.name}’s seed words. Type them on the Krux from your paper copy, which checks that copy too; Crossbill never shows them as a code.`}
          </p>
          <ol className="steps">
            <li>
              On the Krux, choose <strong>Load Mnemonic</strong>, <strong>Words</strong>, and type {c.name}’s seed words from your paper copy. If you saved them on the Krux before, use{' '}
              <strong>From Storage</strong>.
            </li>
            {c.hasPassphrase && (
              <li>
                On the screen that follows, choose <strong>Passphrase</strong> and type its passphrase exactly.
              </li>
            )}
            <li>
              Choose <strong>Customize</strong> and set Network to <strong>{testnet ? 'Testnet' : 'Mainnet'}</strong>, Script Type to <strong>{KRUX_TYPE[c.scriptType]}</strong>
              {account ? (
                <>
                  , and Account to <strong>{account}</strong>
                </>
              ) : null}
              .
            </li>
            <li>
              Choose <strong>Load Wallet</strong>, then <strong>Extended Public Key</strong>, <strong>{kruxKeyMenu(c.scriptType, testnet)}</strong>.
            </li>
          </ol>
          {error && <div className="banner error">{error}</div>}
          <KeyButtons
            noFile={removeOnly}
            onKey={(text, from) => {
              setError(null);
              try {
                const k = app.readKruxKey(text);
                const m = matchWallet(k, c);
                if (!m.ok) throw new Error(m.reason);
                setFromFile(from === 'file');
                setKey(k);
              } catch (e) {
                setError(friendlyError(e));
              }
            }}
          />
        </>
      ) : (
        <>
          <div className="banner on-banner">
            {fromFile ? (
              <>
                This key file is {c.name}’s (fingerprint <span className="mono">{key.fingerprint}</span>).
              </>
            ) : (
              <>
                This Krux holds {c.name}’s keys (fingerprint <span className="mono">{key.fingerprint}</span>).
              </>
            )}
          </div>
          {!removeOnly && !fromFile && (
            <>
              <div className="section-title">The seed words on this iPhone</div>
              <Choice checked={remove} onSelect={() => setRemove(true)} title="Take them off this iPhone (suggested)" detail="Only the Krux can sign. Your paper copy stays the backup." />
              <Choice checked={!remove} onSelect={() => setRemove(false)} title="Keep them on this iPhone too" detail="Each send can be signed here, with Face ID, or on the Krux." />
            </>
          )}
          {fromFile && (
            <p className="note">
              The seed words stay on this iPhone too: a key file doesn’t show the Krux holds them now. To take them off later, choose <strong>Take the seed words off this iPhone</strong> in this
              wallet’s settings and scan the key off the Krux’s screen.
            </p>
          )}
          {removing && (
            <Toggle
              label="My seed words are written down"
              detail={`On paper, away from the Krux. Once they’re off this iPhone, the paper and the Krux are the only places ${c.name}’s seed words are.`}
              checked={written}
              onChange={setWritten}
            />
          )}
          {error && <div className="banner error">{error}</div>}
          <button
            className={removing ? 'btn danger' : 'btn primary'}
            disabled={busy || (removing && !written)}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await app.linkKrux(id, key, removing);
                setDone(removing ? 'krux' : 'both');
              } catch (e) {
                setError(friendlyError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {removing ? 'Link, and take the seed words off this iPhone' : 'Link'}
          </button>
        </>
      )}
    </Screen>
  );
}

/** The Krux section of a wallet's settings: link it, or say how it's signed. */
export function KruxWalletSection({ w }: { w: WalletRuntime }) {
  const app = useApp();
  const nav = useNav();
  const signer = signerOf(w.config);
  return (
    <>
      <div className="section-title">Krux hardware wallet</div>
      {signer === 'phone' && (
        <>
          <p className="note" style={{ marginTop: 0 }}>
            Sign this wallet’s sends on a Paperclip Krux holding the same seed words. You choose whether they stay on this iPhone too.
          </p>
          <button className="btn secondary" style={{ width: '100%' }} onClick={() => nav.push({ name: 'krux-link', id: w.config.id })}>
            Sign with a Krux
          </button>
        </>
      )}
      {signer === 'both' && (
        <>
          <p className="note" style={{ marginTop: 0 }}>
            Signed on this iPhone or on your Krux: each send asks which. The seed words are on both.
          </p>
          <div style={{ display: 'grid', gap: 10 }}>
            <button className="btn secondary" onClick={() => nav.push({ name: 'krux-link', id: w.config.id, removeOnly: true })}>
              Take the seed words off this iPhone
            </button>
            <button className="btn secondary" onClick={() => void app.unlinkKrux(w.config.id)}>
              Stop using the Krux for this wallet
            </button>
          </div>
        </>
      )}
      {signer === 'krux' && (
        <>
          <p className="note" style={{ marginTop: 0 }}>
            Signed only on your Krux. The seed words aren’t on this iPhone. To sign here too, add them again: <strong>Add a wallet</strong>, <strong>Use my seed words</strong>.
          </p>
          <button className="btn secondary" style={{ width: '100%' }} onClick={() => nav.push({ name: 'add-wallet', words: true })}>
            Put the seed words on this iPhone too
          </button>
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------------------------------- signing

function densityOf(v: string | null): QrDensity {
  return v === 'easy' || v === 'dense' ? v : 'standard';
}

/**
 * A send waiting for the Krux: the transaction as codes for the Krux's camera (or a file for microSD), then the
 * Krux's signed reply read back, checked, and sent.
 */
export function KruxSign({ onCancel, onSent }: { onCancel: () => void; onSent: (txid: string) => void }) {
  const app = useApp();
  const s = app.kruxSigning;
  const w = s ? app.walletById(s.walletId) : undefined;
  const [density, setDensity] = useState<QrDensity>(() => {
    try {
      return densityOf(localStorage.getItem('shrike.kruxDensity'));
    } catch {
      return 'standard';
    }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const parts = useMemo(() => (s ? bbqrEncode(s.psbt, { version: DENSITY_VERSION[density] }) : []), [s?.psbt, density]);

  // The Krux reads the codes off this screen, so it mustn't dim or lock meanwhile
  useEffect(() => {
    void ShrikeNative.keepAwake({ on: true }).catch(() => undefined);
    return () => void ShrikeNative.keepAwake({ on: false }).catch(() => undefined);
  }, []);

  if (!s || !w) {
    return (
      <Screen title="Krux" back={false}>
        <p>There’s no send waiting for your Krux.</p>
        <button className="btn primary" onClick={onCancel}>
          Done
        </button>
      </Screen>
    );
  }

  const unit = app.settings.unit;
  const payments = s.draft.outputs.filter((o) => !o.isChange);
  const total = payments.reduce((t, o) => t + o.value, 0) + s.draft.fee;

  const take = (data: Uint8Array) => {
    setError(null);
    try {
      app.acceptKruxSignature(data);
    } catch (e) {
      setError(friendlyError(e));
    }
  };

  const summary = (
    <dl className="facts">
      {payments.map((o, i) => (
        <div key={i}>
          <dt>{o.payment?.label || (payments.length > 1 ? `Payment ${i + 1}` : 'Paying')}</dt>
          <dd>
            <Amount sats={o.value} unit={unit} />
            <div style={{ marginTop: 6 }}>
              <Address value={o.payment?.address ?? ''} size="sm" />
            </div>
          </dd>
        </div>
      ))}
      <div>
        <dt>Fee</dt>
        <dd>
          <Amount sats={s.draft.fee} unit={unit} />
        </dd>
      </div>
      <div>
        <dt>Total leaving {w.config.name}</dt>
        <dd style={{ fontWeight: 700 }}>
          <Amount sats={total} unit={unit} />
        </dd>
      </div>
    </dl>
  );

  if (s.signed) {
    return (
      <Screen title="Ready to send" back={false} end={<button onClick={onCancel}>Cancel</button>}>
        <div className="banner on-banner">Signed by your Krux. Every signature checks out against {w.config.name}’s keys, and each one is replay protected.</div>
        {summary}
        {error && <div className="banner error">{error}</div>}
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              onSent(await app.sendKruxSigned());
            } catch (e) {
              setError(friendlyError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Sending' : 'Send'}
        </button>
        <p className="note" style={{ textAlign: 'center' }}>
          Sending can’t be undone once it confirms.
        </p>
      </Screen>
    );
  }

  return (
    <Screen title="Sign on your Krux" back={false} end={<button onClick={onCancel}>Cancel</button>}>
      <p style={{ marginTop: 0, marginBottom: 4 }}>
        On the Krux, choose <strong>Sign</strong>, <strong>PSBT</strong>, <strong>Load from camera</strong>, and point it at these codes.
      </p>
      <AnimatedQr parts={parts} interval={FRAME_MS[density]} />
      <ol className="steps" start={2}>
        <li>
          Answer <strong>Yes</strong> to <em>Bitcoin only, Unified SIGHASH_ALL (0x21)</em>. Check every address and amount the Krux shows against the ones below.
        </li>
        <li>
          Choose <strong>Sign to QR code</strong>, then scan the Krux’s codes here.
        </li>
      </ol>
      <div className="field">
        <span className="label">Code detail</span>
        <div className="segmented" role="group" aria-label="Code detail">
          {(['easy', 'standard', 'dense'] as QrDensity[]).map((d) => (
            <button
              key={d}
              aria-pressed={density === d}
              onClick={() => {
                setDensity(d);
                try {
                  localStorage.setItem('shrike.kruxDensity', d);
                } catch {
                  // remembered for this screen only
                }
              }}
            >
              {d === 'easy' ? 'Low' : d === 'standard' ? 'Standard' : 'High'}
            </button>
          ))}
        </div>
        <div className="hint">If the Krux struggles to read them, choose Low: simpler codes, more of them.</div>
      </div>
      {kruxWarnsUnverifiedAmounts(w.config.scriptType, s.draft.coins.length) && (
        <p className="note">
          This spends more than one coin, so the Krux will warn <em>Unverified input amounts</em>. That’s expected: the unified signature covers every coin’s amount, so a wrong amount
          would only make the signature invalid. Choose Yes.
        </p>
      )}
      {summary}
      {error && <div className="banner error">{error}</div>}
      <div style={{ display: 'grid', gap: 10 }}>
        <button
          className="btn primary"
          onClick={async () => {
            setError(null);
            try {
              const r = await scanCodes('Scan your Krux');
              if (!r) return;
              if (r.kind !== 'psbt') throw new Error('That isn’t a signed transaction. On the Krux, choose Sign to QR code and scan the codes it shows.');
              take(r.data);
            } catch (e) {
              setError(friendlyError(e));
            }
          }}
        >
          Scan the Krux’s signed codes
        </button>
        <button
          className="btn secondary"
          onClick={() =>
            void savePsbtFile(s.psbt).catch((e) => {
              if (!/cancel/i.test(String(e))) setError(friendlyError(e));
            })
          }
        >
          Save for microSD instead
        </button>
        <button
          className="btn secondary"
          onClick={async () => {
            setError(null);
            const bytes = await pickFile(fileRef.current);
            if (!bytes) return;
            try {
              take(readPsbtFile(bytes));
            } catch (e) {
              setError(friendlyError(e));
            }
          }}
        >
          Open the signed file
        </button>
        <input ref={fileRef} type="file" hidden />
      </div>
      <p className="note">
        With microSD: save the file to the card with a card reader, then on the Krux choose <strong>Load from SD card</strong> and <strong>Sign to SD card</strong>. Open the file ending in{' '}
        <span className="mono" style={{ whiteSpace: 'nowrap' }}>-signed.psbt</span> here.
      </p>
    </Screen>
  );
}

/** The signing screen on its own, for coming back to a send after the app locked. */
export function KruxSignScreen() {
  const app = useApp();
  const nav = useNav();
  const [sent, setSent] = useState<{ txid: string; total: number; unsaved: { address: string; label: string }[] } | null>(null);
  const s = app.kruxSigning;
  if (sent) return <SentView total={sent.total} txid={sent.txid} decision={app.replayDecision()} unsaved={sent.unsaved} onDone={() => nav.reset()} />;
  const payments = s ? s.draft.outputs.filter((o) => !o.isChange) : [];
  const total = s ? payments.reduce((t, o) => t + o.value, 0) + s.draft.fee : 0;
  const unsaved = s && !s.replaces ? payments.map((o) => ({ address: o.payment?.address ?? '', label: o.payment?.label ?? '' })).filter((p) => p.address && !app.contactFor(p.address) && !app.isOwnAddress(p.address)) : [];
  return (
    <KruxSign
      onCancel={() => {
        app.cancelKruxSigning();
        nav.pop();
      }}
      onSent={(txid) => setSent({ txid, total, unsaved })}
    />
  );
}

/** After the app locks partway through a Krux send, opening it again goes back to that send. */
export function useResumeKrux() {
  const app = useApp();
  const nav = useNav();
  useEffect(() => {
    const s = app.kruxSigning;
    if (s && app.walletById(s.walletId) && nav.stack[nav.stack.length - 1].name !== 'krux-sign') nav.push({ name: 'krux-sign' });
    // Only when the screens first appear after opening the app
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

// ------------------------------------------------------------------------------------------- Settings page

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <>
      <div className="section-title">{title}</div>
      {children}
    </>
  );
}

/** Settings, Hardware wallet: the Krux, how to use it with Crossbill, what to do when it goes wrong, and links. */
export function HardwareScreen() {
  const app = useApp();
  const nav = useNav();
  const wallets = app.networkWallets();
  const linked = wallets.filter((w) => signerOf(w.config) !== 'phone');
  const testnet = app.settings.network !== 'mainnet';
  return (
    <Screen title="Hardware wallet">
      <p style={{ marginTop: 0 }}>
        Crossbill works with Paperclip’s <strong>K210 Krux Hardware Wallet</strong>, an air-gapped signer for Bitcoin (XBT) with no Wi-Fi or Bluetooth. Your seed words stay on the Krux. Crossbill
        builds each send, the Krux shows you where it goes and signs it, and Crossbill sends it through your node. They pass the transaction by QR code or microSD card.
      </p>
      <div className="banner">
        Only Paperclip’s Krux firmware works. Standard Krux firmware can’t make the unified (replay-protected) signatures Bitcoin (XBT) needs, and refuses these transactions.
      </div>

      <Section title="Your wallets">
        {linked.map((w) => (
          <button key={w.config.id} className="row setting" onClick={() => nav.push({ name: 'wallet-info', id: w.config.id })}>
            <div className="main">
              <div className="title">{w.config.name}</div>
              <div className="meta">{signerText(signerOf(w.config))}</div>
            </div>
            <span className="go" aria-hidden>
              <Chevron dir="right" />
            </span>
          </button>
        ))}
        {linked.length === 0 && <p className="note" style={{ marginTop: 0 }}>No wallet signs on a Krux yet.</p>}
        <div style={{ display: 'grid', gap: 10, marginTop: 10 }}>
          <button className="btn secondary" onClick={() => nav.push({ name: 'add-wallet', krux: true })}>
            Add a wallet from a Krux
          </button>
        </div>
        {!isServer && (
          <p className="note">
            To use a wallet already on this iPhone, open it in Settings, Wallets, and choose <strong>Sign with a Krux</strong>.
          </p>
        )}
      </Section>

      <Section title="Setting up">
        <ol className="steps">
          <li>
            On the Krux, choose <strong>Load Mnemonic</strong>, <strong>Words</strong>, and type your seed words. Or <strong>New Mnemonic</strong> to make new ones, written on the backup card that
            came with it.
          </li>
          <li>
            On the screen that follows: <strong>Passphrase</strong> if you use one, and <strong>Customize</strong> for Network (<strong>{testnet ? 'Testnet' : 'Mainnet'}</strong>) and your wallet’s
            Script Type. <strong>Native Segwit - 84</strong> is Crossbill’s default; Taproot is marked experimental on the Krux. With new words, both are under <strong>Wallet Options</strong>.
          </li>
          <li>
            Choose <strong>Load Wallet</strong> (<strong>Continue</strong> with new words). In Crossbill, <strong>Add a wallet</strong>, <strong>Use my Krux</strong>. On the Krux,{' '}
            <strong>Extended Public Key</strong>, then the <strong>{kruxKeyMenu('P2WPKH', testnet)}</strong> (<strong>{kruxKeyMenu('P2SH_P2WPKH', testnet).replace(' - QR Code', '')}</strong> for
            Nested Segwit, <strong>{kruxKeyMenu('P2TR', testnet).replace(' - QR Code', '')}</strong> for Taproot or Legacy).
          </li>
        </ol>
        <p className="note">
          The Krux can keep the seed words encrypted on itself (<strong>Backup Mnemonic</strong>, <strong>Encrypted</strong>), so next time you load them <strong>From Storage</strong> instead of
          typing them. Your paper copy is still the backup.
        </p>
      </Section>

      <Section title="Sending">
        <ol className="steps">
          <li>
            Write the payment in Crossbill as usual, then choose <strong>Sign on your Krux</strong>.
          </li>
          <li>
            On the Krux: <strong>Sign</strong>, <strong>PSBT</strong>, <strong>Load from camera</strong>, and point it at Crossbill’s codes.
          </li>
          <li>
            Answer <strong>Yes</strong> to <em>Bitcoin only, Unified SIGHASH_ALL (0x21)</em>, then check every address and amount the Krux shows.
          </li>
          <li>
            Choose <strong>Sign to QR code</strong> and scan the Krux’s codes in Crossbill. Crossbill checks each signature against your wallet’s keys, then you choose <strong>Send</strong>.
          </li>
        </ol>
        <p className="note">
          With a microSD card reader instead: <strong>Save for microSD</strong> in Crossbill, <strong>Load from SD card</strong> and <strong>Sign to SD card</strong> on the Krux, then{' '}
          <strong>Open the signed file</strong> in Crossbill.
        </p>
      </Section>

      <Section title="Checking a receive address">
        <p className="note" style={{ marginTop: 0 }}>
          On the Krux: <strong>Address</strong>, <strong>Scan Address</strong>, and point it at the code on Crossbill’s Receive screen. The Krux says whether the address is its wallet’s.
        </p>
      </Section>

      <Section title="If something goes wrong">
        <dl className="facts faq">
          <div>
            <dt>The Krux won’t read Crossbill’s codes</dt>
            <dd>Choose Low code detail on the signing screen, turn the {isServer ? 'screen’s' : 'iPhone’s'} brightness up, and hold the Krux a hand’s width or two from the screen.</dd>
          </div>
          <div>
            <dt>Unverified input amounts</dt>
            <dd>Expected when a send spends two or more Segwit coins. The unified signature covers every coin’s amount, so a wrong amount would only make the signature invalid.</dd>
          </div>
          <div>
            <dt>Path mismatch</dt>
            <dd>The Krux is set to another address type or account than the wallet. Change Script Type or Account in Customize (on the Krux’s home screen, under Wallet).</dd>
          </div>
          <div>
            <dt>The Krux won’t sign, or Crossbill says it didn’t</dt>
            <dd>The Krux holds different seed words or a different passphrase from this wallet. Load the wallet’s own.</dd>
          </div>
          <div>
            <dt>It refuses the transaction straight away</dt>
            <dd>Check the Krux runs Paperclip’s firmware: its start screen names the Bitcoin (XBT) fork. Standard Krux refuses unified signatures.</dd>
          </div>
        </dl>
      </Section>

      <Section title="Keep in mind">
        <ul className="steps">
          <li>Keep your seed words on paper, apart from the Krux. The Krux and its microSD card aren’t a backup, and its encrypted storage isn’t a secure chip.</li>
          <li>The Krux checks Paperclip’s signature on a firmware update itself before installing it. Get updates only from Paperclip’s releases.</li>
          <li>Neither Crossbill nor the Krux firmware has been audited. Start with small amounts.</li>
        </ul>
      </Section>

      {KRUX_LINKS.map((g) => (
        <Section key={g.title} title={g.title}>
          <ul className="list links">
            {g.links.map((l) => (
              <li key={l.url}>
                <button className="row" onClick={() => void openLink(l.url)}>
                  <div className="main">
                    <div className="title">{l.name}</div>
                    <div className="meta wrap">{l.detail}</div>
                  </div>
                  <span className="go" aria-hidden>
                    <Chevron dir="right" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ))}
      <p className="note">
        Paperclip’s Krux firmware is made by Connor’s Lab. It’s an unofficial adaptation of Krux, not an official Krux product. Links open outside this app’s Tor connection.
      </p>
    </Screen>
  );
}
