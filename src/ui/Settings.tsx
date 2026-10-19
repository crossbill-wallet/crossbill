import { useRef, useState } from 'react';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { SCRIPT_TYPE_INFO } from '../core/script';
import { DEFAULT_EXPLORER, normalizeExplorer } from '../core/explorer';
import { DECISION_TEXT, decisionSummary } from '../core/replay';
import { friendlyError } from '../app/model';
import { isNative } from '../app/native';
import { Amount, Choice, Field, ReplayStatus, Screen, ScreenshotWarning, Toggle, copyText, useApp, useNav, useScreenshotAlert } from './kit';

export function Settings() {
  const app = useApp();
  const nav = useNav();
  const node = app.settings.node;
  const decision = app.replayDecision();
  return (
    <Screen title="Settings">
      <div className="section-title" style={{ marginTop: 4 }}>
        Node
      </div>
      <button className="row" style={{ padding: '12px 0' }} onClick={() => nav.push({ name: 'node' })}>
        <div className="main">
          <div className="title mono" style={{ fontWeight: 400, fontSize: 'var(--t-sm)' }}>
            {node ? `${node.host.length > 26 ? node.host.slice(0, 14) + '…' + node.host.slice(-10) : node.host}:${node.port}` : 'Not set up'}
          </div>
          <div className="meta">
            {app.settings.network === 'mainnet' ? 'Mainnet' : app.settings.network === 'testnet4' ? 'Testnet4' : 'Regtest'}
            {node?.useTor ? ', through Tor' : ''}
            {app.node ? `, ${app.node.subversion.replace(/^\/|\/$/g, '')}` : ''}
          </div>
        </div>
        <span className="note">Change</span>
      </button>

      <ExplorerSetting />

      <div className="section-title">Wallets</div>
      {app.networkWallets().map((w) => (
        <button key={w.config.id} className="row" style={{ padding: '12px 0' }} onClick={() => nav.push({ name: 'wallet-info', id: w.config.id })}>
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

      <div className="section-title">Replay protection</div>
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

      <div className="section-title">Display</div>
      <div className="segmented" role="group" aria-label="Amounts in">
        <button aria-pressed={app.settings.unit === 'BTC'} onClick={() => void app.updateSettings({ unit: 'BTC' })}>
          BTC
        </button>
        <button aria-pressed={app.settings.unit === 'sats'} onClick={() => void app.updateSettings({ unit: 'sats' })}>
          sats
        </button>
      </div>

      <div className="section-title">Security and spending</div>
      <Toggle label="Ask for Face ID to open" detail="And again after a minute away. Signing always asks." checked={app.settings.lockOnOpen} onChange={(v) => void app.updateSettings({ lockOnOpen: v })} />
      <Toggle
        label="Spend whole addresses together"
        detail="When an address holds several coins, they are spent at once so the address is never left partly spent."
        checked={app.settings.groupByAddress}
        onChange={(v) => void app.updateSettings({ groupByAddress: v })}
      />

      <p className="note" style={{ marginTop: 28 }}>
        Shrike for iPhone {__APP_VERSION__}. A personal build of the Shrike wallet, an unofficial fork of Sparrow. Not audited. Apache 2.0.
      </p>
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
      <div className="section-title">Block explorer</div>
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
