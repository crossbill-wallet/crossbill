import { useRef, useState } from 'react';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { SCRIPT_TYPE_INFO } from '../core/script';
import { DEFAULT_EXPLORER, normalizeExplorer } from '../core/explorer';
import { DECISION_TEXT, decisionSummary } from '../core/replay';
import { friendlyError } from '../app/model';
import { isNative } from '../app/native';
import { FONTS, SKINS } from '../app/look';
import { APP_REPO, DONATION_ADDRESS } from '../app/links';
import {
  Address,
  Amount,
  Choice,
  Field,
  Qr,
  ReplayStatus,
  Row,
  Screen,
  ScreenshotWarning,
  SecondFactorField,
  Sheet,
  Toggle,
  codeReady,
  copyText,
  openLink,
  useApp,
  useNav,
  useScreenshotAlert,
} from './kit';

export function Settings() {
  const app = useApp();
  const nav = useNav();
  const node = app.settings.node;
  const decision = app.replayDecision();
  const skin = SKINS.find((x) => x.id === app.skin)!;
  const font = FONTS.find((x) => x.id === app.settings.font)!;
  const explorer = app.settings.explorer;
  return (
    <Screen title="Settings" back={false}>
      <div className="section-title" style={{ marginTop: 4 }}>
        Wallets
      </div>
      {app.networkWallets().map((w) => (
        <button key={w.config.id} className="row setting" onClick={() => nav.push({ name: 'wallet-info', id: w.config.id })}>
          <div className="main">
            <div className="title">{w.config.name}</div>
            <div className="meta">{SCRIPT_TYPE_INFO[w.config.scriptType].label}</div>
          </div>
          <div className="amt">
            <Amount sats={(w.snapshot?.balance.confirmed ?? 0) + (w.snapshot?.balance.unconfirmed ?? 0)} unit={app.settings.unit} />
          </div>
        </button>
      ))}
      <button className="btn quiet" onClick={() => nav.push({ name: 'add-wallet' })}>
        Add a wallet
      </button>

      <div className="section-title">Security</div>
      <Row title="Two-factor" meta={app.settings.twoFactor ? 'A code is needed to send and to show seed words' : 'Off. Sends need Face ID only'} end={app.settings.twoFactor ? 'On' : 'Off'} onClick={() => nav.push({ name: 'two-factor' })} />
      <Toggle label="Ask for Face ID to open" detail="And again after a minute away. Signing always asks." checked={app.settings.lockOnOpen} onChange={(v) => void app.updateSettings({ lockOnOpen: v })} />

      <div className="section-title">Look</div>
      <Row
        title="Appearance"
        meta={`${app.settings.appearance === 'system' ? 'Matches iPhone' : app.settings.appearance === 'dark' ? 'Dark' : 'Light'}, ${skin.name} skin, ${font.name}`}
        onClick={() => nav.push({ name: 'appearance' })}
      />
      <div className="field" style={{ margin: '14px 0 0' }}>
        <span className="label">Amounts in</span>
        <div className="segmented" role="group" aria-label="Amounts in">
          <button aria-pressed={app.settings.unit === 'BTC'} onClick={() => void app.updateSettings({ unit: 'BTC' })}>
            BTC
          </button>
          <button aria-pressed={app.settings.unit === 'sats'} onClick={() => void app.updateSettings({ unit: 'sats' })}>
            sats
          </button>
        </div>
      </div>
      <Toggle
        label="XBT price"
        detail="From Neoxa Exchange, for the Market tab and the dollar balance. Asks for the price only, never for anything about your wallets."
        checked={app.settings.prices}
        onChange={(v) => void app.updateSettings({ prices: v, ...(v ? {} : { balanceView: 'coin' as const }) })}
      />
      {app.settings.prices && (
        <Toggle
          label="Get the price through Tor"
          detail="So the exchange doesn’t see this iPhone’s IP address. Turn off if the price won’t load through Tor."
          checked={app.settings.pricesOverTor}
          onChange={(v) => void app.updateSettings({ pricesOverTor: v })}
        />
      )}

      <Row
        title="Widgets"
        meta={`XBT price and balance${app.widgets.installed.length ? `, ${app.widgets.installed.length} on your screens` : ' for the Home Screen and Lock Screen'}`}
        onClick={() => nav.push({ name: 'widgets' })}
      />

      <div className="section-title">Node</div>
      <Row
        title={<span className="mono" style={{ fontWeight: 400, fontSize: 'var(--t-sm)' }}>{node ? `${node.host.length > 26 ? node.host.slice(0, 14) + '…' + node.host.slice(-10) : node.host}:${node.port}` : 'Not set up'}</span>}
        meta={
          <>
            {app.settings.network === 'mainnet' ? 'Mainnet' : app.settings.network === 'testnet4' ? 'Testnet4' : 'Regtest'}
            {node?.useTor ? ', through Tor' : ''}
            {app.node ? `, ${app.node.subversion.replace(/^\/|\/$/g, '')}` : ''}
          </>
        }
        onClick={() => nav.push({ name: 'node' })}
      />
      <Row title="Block explorer" meta={explorer == null ? 'None' : explorer === DEFAULT_EXPLORER ? 'mempool.guide' : explorer.replace(/^https?:\/\//, '')} onClick={() => nav.push({ name: 'explorer' })} />
      <Row title="Replay protection" meta={decisionSummary(decision)} onClick={() => nav.push({ name: 'replay' })} />

      <div className="section-title">Spending</div>
      <Toggle
        label="Spend whole addresses together"
        detail="When an address holds several coins, they are spent at once so the address is never left partly spent."
        checked={app.settings.groupByAddress}
        onChange={(v) => void app.updateSettings({ groupByAddress: v })}
      />

      {DONATION_ADDRESS && (
        <>
          <div className="section-title">Support this app</div>
          <Row title="Donate XBT" meta="Help keep Shrike for iPhone going" onClick={() => nav.push({ name: 'donate' })} />
        </>
      )}

      <p className="note" style={{ marginTop: 28 }}>
        Shrike for iPhone {__APP_VERSION__}. A personal build of the Shrike wallet, an unofficial fork of Sparrow. Not audited. Apache 2.0.
      </p>
      <button className="btn quiet" onClick={() => void openLink(APP_REPO)}>
        Code and releases on GitHub
      </button>
    </Screen>
  );
}

/** Light or dark, the skin, and the font. */
export function Appearance() {
  const app = useApp();
  const held = app.totalConfirmed();
  const mainnet = app.settings.network === 'mainnet';
  const unit = app.settings.unit;
  const threshold = (sats: number) => (unit === 'sats' ? `${sats.toLocaleString('en-US')} sats` : `${sats / 1e8} BTC`);
  return (
    <Screen title="Appearance">
      <div className="field">
        <span className="label">Light or dark</span>
        <div className="segmented" role="group" aria-label="Light or dark">
          {(
            [
              ['light', 'Light'],
              ['dark', 'Dark'],
              ['system', 'Match iPhone'],
            ] as const
          ).map(([v, label]) => (
            <button key={v} aria-pressed={app.settings.appearance === v} onClick={() => void app.updateSettings({ appearance: v })}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="section-title">Skin</div>
      <p className="note" style={{ marginTop: 0 }}>
        {mainnet
          ? 'More skins open as the wallets on this phone hold more, counting confirmed coins. Once open, a skin stays open.'
          : 'On a test network every skin is open to try. On mainnet they open as your confirmed balance grows.'}
      </p>
      {SKINS.map((k) => {
        const open = app.skinOpen(k.id);
        const progress = Math.min(1, held / (k.minSats || 1));
        return (
          <button key={k.id} type="button" className="choice skin-choice" role="radio" aria-checked={app.skin === k.id} aria-disabled={!open} disabled={!open} onClick={() => void app.updateSettings({ skin: k.id })}>
            <span className="swatch" data-skin={k.id} aria-hidden>
              <span className="glow" />
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span className="what">{k.name}</span>
              <div className="why">{open ? k.detail : `Opens at ${threshold(k.minSats)}`}</div>
              {!open && (
                <span className="meter" aria-label={`${Math.floor(progress * 100)}% of the way`}>
                  <span style={{ width: `${progress * 100}%` }} />
                </span>
              )}
            </span>
            {!open && <LockGlyph />}
          </button>
        );
      })}
      <p className="note">A skin hints at what you hold to anyone who sees your screen.</p>

      <div className="section-title">Font</div>
      {FONTS.map((f) => (
        <Choice
          key={f.id}
          checked={app.settings.font === f.id}
          onSelect={() => void app.updateSettings({ font: f.id })}
          title={f.name}
          detail={
            <span className="font-sample" data-font={f.id}>
              <span className="sans">{f.detail}</span>
              <span className="mono">0.12 345 678 BTC</span>
            </span>
          }
        />
      ))}
    </Screen>
  );
}

function LockGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden style={{ flex: 'none', color: 'var(--slate)', marginTop: 2 }}>
      <rect x="5" y="10.5" width="14" height="10" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M8.5 10.5V7.8a3.5 3.5 0 0 1 7 0v2.7" fill="none" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}

export function ExplorerScreen() {
  return (
    <Screen title="Block explorer">
      <ExplorerSetting />
    </Screen>
  );
}

export function ReplayScreen() {
  const app = useApp();
  const decision = app.replayDecision();
  return (
    <Screen title="Replay protection">
      <ReplayStatus decision={decision} />
      <dl className="facts">
        <div>
          <dt>Activation height in this app</dt>
          <dd className={app.net.blake2bHeight ? 'mono' : ''}>{app.net.blake2bHeight?.toLocaleString('en-US') ?? 'Set by the node'}</dd>
        </div>
        <div>
          <dt>Activation height your node reports</dt>
          <dd className={app.node?.nodeActivationHeight ? 'mono' : ''}>{app.node ? (app.node.nodeActivationHeight?.toLocaleString('en-US') ?? 'None') : 'Not connected'}</dd>
        </div>
        <div>
          <dt>Chain tip</dt>
          <dd>{app.node ? <><span className="mono">{app.node.blocks.toLocaleString('en-US')}</span>, {app.node.tip.isV2 ? 'BLAKE2b header' : 'SHA256d header'}</> : 'Not connected'}</dd>
        </div>
      </dl>
      {!DECISION_TEXT[decision].reason && <p className="note">{decisionSummary(decision)} whenever this wallet signs, with no setting to change.</p>}
    </Screen>
  );
}

/** Settings, Support this app. Only listed when the build has a donation address. */
export function Donate() {
  const app = useApp();
  const nav = useNav();
  const [copied, setCopied] = useState(false);
  const mainnet = app.settings.network === 'mainnet';
  return (
    <Screen title="Donate">
      <p style={{ marginTop: 0 }}>Shrike for iPhone is free and built in spare time. If it’s useful to you, a donation in XBT helps keep it going. Thank you.</p>
      <Qr text={`bitcoin:${DONATION_ADDRESS}`} />
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <Address value={DONATION_ADDRESS} />
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        <button className="btn primary" disabled={!mainnet} onClick={() => nav.push({ name: 'send', address: DONATION_ADDRESS, label: 'Donation to Shrike for iPhone' })}>
          Send from {app.active?.config.name ?? 'this wallet'}
        </button>
        <button
          className="btn secondary"
          onClick={async () => {
            setCopied(await copyText(DONATION_ADDRESS));
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? 'Copied' : 'Copy address'}
        </button>
      </div>
      {!mainnet && <p className="note">Switch to your mainnet node to donate. This address is on mainnet.</p>}
      <p className="note">Donations are voluntary and buy nothing: the app is the same with or without one.</p>
    </Screen>
  );
}

/** Where "View on …" links on a transaction go. The same three choices as desktop Shrike's Block Explorer setting. */
function ExplorerSetting() {
  const app = useApp();
  const current = app.settings.explorer;
  const kind = current == null ? 'none' : current === DEFAULT_EXPLORER ? 'default' : 'custom';
  const [custom, setCustom] = useState(kind === 'custom' ? (current ?? '') : '');
  const [picked, setPicked] = useState<'default' | 'custom' | 'none'>(kind);
  const [error, setError] = useState<string | null>(null);

  const saveCustom = (text: string) => {
    if (!text.trim()) return;
    const url = normalizeExplorer(text);
    if (!url) {
      setError('That isn’t a web address. It should look like https://explorer.example or http://abc…xyz.onion');
      return;
    }
    setError(null);
    setCustom(url);
    void app.updateSettings({ explorer: url });
  };

  return (
    <>
      <Choice
        checked={picked === 'default'}
        onSelect={() => {
          setPicked('default');
          setError(null);
          void app.updateSettings({ explorer: DEFAULT_EXPLORER });
        }}
        title="mempool.guide"
        detail="The explorer desktop Shrike uses. It follows the BLAKE2b chain."
      />
      <Choice checked={picked === 'custom'} onSelect={() => setPicked('custom')} title="Your own" detail="A mempool instance on your server, or any explorer’s address." />
      {picked === 'custom' && (
        <Field label="Explorer address" htmlFor="explorer" error={error} hint="{0} stands for the transaction ID, as in desktop Shrike. Without it, /tx/ and the ID are added. Onion addresses open in Onion Browser.">
          <input
            id="explorer"
            className="input mono"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onBlur={(e) => saveCustom(e.target.value)}
            placeholder="http://abc…xyz.onion"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode="url"
          />
        </Field>
      )}
      <Choice
        checked={picked === 'none'}
        onSelect={() => {
          setPicked('none');
          setError(null);
          void app.updateSettings({ explorer: null });
        }}
        title="None"
        detail="No explorer button on transactions."
      />
      <p className="note">
        Explorer links open in Safari, outside this app’s Tor connection, so the explorer sees your IP address next to the transaction you look up. An onion address opened in Onion Browser stays on Tor.
      </p>
    </>
  );
}

export function WalletInfo({ id }: { id: string }) {
  const app = useApp();
  const nav = useNav();
  const w = app.wallets.find((x) => x.config.id === id);
  const [name, setName] = useState(w?.config.name ?? '');
  const [seed, setSeed] = useState<{ mnemonic: string; passphrase: string } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [asking, setAsking] = useState(false);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const shot = useScreenshotAlert(seed != null);
  if (!w) return <Screen title="Wallet">{null}</Screen>;

  const exportLabels = async () => {
    const text = app.exportLabels(w);
    const fileName = `${w.config.name.replace(/[^\w-]+/g, '_')}-labels.jsonl`;
    if (isNative) {
      const res = await Filesystem.writeFile({ path: fileName, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
      await Share.share({ title: 'Wallet labels', url: res.uri });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'application/jsonl' }));
      a.download = fileName;
      a.click();
    }
  };

  return (
    <Screen title={w.config.name}>
      <Field label="Name" htmlFor="wname">
        <input id="wname" className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => void app.renameWallet(id, name)} />
      </Field>
      <dl className="facts">
        <div>
          <dt>Address type</dt>
          <dd>{SCRIPT_TYPE_INFO[w.config.scriptType].label}</dd>
        </div>
        <div>
          <dt>Master fingerprint</dt>
          <dd className="mono">{w.config.fingerprint}</dd>
        </div>
        <div>
          <dt>Derivation</dt>
          <dd className="mono">{w.config.derivation}</dd>
        </div>
        <div>
          <dt>Passphrase</dt>
          <dd>{w.config.hasPassphrase ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt>Range on your node</dt>
          <dd className="mono">{w.importedRange != null ? `0 to ${w.importedRange}` : 'Unknown'}</dd>
        </div>
      </dl>

      <div className="section-title">Output descriptor</div>
      <div className="txid" style={{ marginBottom: 8 }}>
        {app.outputDescriptor(w, 0)}
      </div>
      <button className="btn secondary small" onClick={async () => setMsg((await copyText(app.outputDescriptor(w, 0))) ? 'Descriptor copied' : null)}>
        Copy descriptor
      </button>

      <div className="section-title">Labels</div>
      <p className="note" style={{ marginTop: 0 }}>
        BIP329 files, the same format as Export Labels and Import Labels in Shrike on your computer. Frozen coins travel with them.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <button className="btn secondary" onClick={() => void exportLabels().catch((e) => setError(friendlyError(e)))}>
          Export
        </button>
        <button className="btn secondary" onClick={() => fileRef.current?.click()}>
          Import
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept=".jsonl,.json,.txt,application/json,text/plain"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try {
            const n = await app.importLabels(w, await f.text());
            setMsg(`Imported ${n} label${n === 1 ? '' : 's'}`);
          } catch (err) {
            setError(friendlyError(err));
          }
          e.target.value = '';
        }}
      />

      <div className="section-title">Seed words</div>
      {seed ? (
        <>
          {shot && <ScreenshotWarning />}
          <ol className="words">
            {seed.mnemonic.split(' ').map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ol>
          {seed.passphrase && <p className="note">Plus the passphrase you set.</p>}
          <button className="btn secondary" style={{ width: '100%' }} onClick={() => setSeed(null)}>
            Hide
          </button>
        </>
      ) : (
        <button
          className="btn secondary"
          style={{ width: '100%' }}
          onClick={async () => {
            if (app.settings.twoFactor) {
              setCode('');
              setCodeError(null);
              setAsking(true);
              return;
            }
            try {
              setSeed(await app.revealSeed(id));
            } catch (e) {
              setError(friendlyError(e));
            }
          }}
        >
          Show seed words
        </button>
      )}
      {asking && (
        <Sheet title="Show seed words" onClose={() => setAsking(false)}>
          <p className="note" style={{ marginTop: 0 }}>
            Two-factor is on, so showing the seed words needs a code first, then Face ID.
          </p>
          <SecondFactorField value={code} onChange={setCode} id="otp-seed" autoFocus />
          {codeError && <div className="banner error">{codeError}</div>}
          <button
            className="btn primary"
            disabled={busy || !codeReady(code)}
            onClick={async () => {
              setBusy(true);
              setCodeError(null);
              try {
                const s = await app.revealSeed(id, code);
                setAsking(false);
                setSeed(s);
              } catch (e) {
                setCodeError(friendlyError(e));
                setCode('');
              } finally {
                setBusy(false);
              }
            }}
          >
            Continue
          </button>
        </Sheet>
      )}

      <div className="section-title">Passphrase</div>
      <p className="note" style={{ marginTop: 0 }}>
        A passphrase can’t be added to this wallet or changed on it. It’s mixed into the keys, so a different passphrase is a different wallet with different addresses, and the coins would stay
        here. Instead, open these seed words with a passphrase as a second wallet, then send the coins across with <strong>My wallets</strong> on the Send screen.
      </p>
      <button className="btn secondary" style={{ width: '100%' }} onClick={() => nav.push({ name: 'add-wallet', seedFrom: id })}>
        {w.config.hasPassphrase ? 'Open with a different passphrase' : 'Open with a passphrase'}
      </button>

      {msg && <p className="note">{msg}</p>}
      {error && <div className="banner error" style={{ marginTop: 14 }}>{error}</div>}

      <div className="section-title">Remove</div>
      {confirmRemove ? (
        <>
          <p>This deletes the seed words and history from this phone. Your node and Shrike on your computer keep everything. You’ll need the seed words to add it again.</p>
          <div style={{ display: 'grid', gap: 10 }}>
            <button
              className="btn danger"
              onClick={async () => {
                await app.removeWallet(id);
                nav.reset();
              }}
            >
              Remove from this phone
            </button>
            <button className="btn secondary" onClick={() => setConfirmRemove(false)}>
              Keep it
            </button>
          </div>
        </>
      ) : (
        <button className="btn danger" onClick={() => setConfirmRemove(true)}>
          Remove from this phone
        </button>
      )}
    </Screen>
  );
}
