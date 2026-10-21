import { useRef, useState } from 'react';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { BACKUP_MIN_PASSWORD } from '../core/backup';
import { friendlyError, type RestoreSummary } from '../app/model';
import { isNative } from '../app/native';
import { Field, Screen, useApp, useNav } from './kit';

function day(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

async function saveFile(fileName: string, text: string): Promise<void> {
  if (isNative) {
    const res = await Filesystem.writeFile({ path: fileName, data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
    try {
      await Share.share({ title: 'Shrike backup', url: res.uri });
    } finally {
      // The share sheet has made its copy; don't leave one in the app's cache
      await Filesystem.deleteFile({ path: fileName, directory: Directory.Cache }).catch(() => undefined);
    }
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = fileName;
    a.click();
  }
}

/** Settings, Backup: saving a backup file, and restoring from one. */
export function BackupScreen() {
  const app = useApp();
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const short = password.length > 0 && password.length < BACKUP_MIN_PASSWORD;
  const differ = password2.length > 0 && password !== password2;
  const ready = password.length >= BACKUP_MIN_PASSWORD && password === password2;
  const wallets = app.networkWallets().length;
  const labels = app.networkWallets().reduce((n, w) => n + w.labels.all().length, 0);
  const contacts = app.networkContacts().length;

  return (
    <Screen title="Backup">
      <p style={{ marginTop: 0 }}>
        One file with everything Shrike keeps besides secrets: your wallets’ names and details, labels and frozen coins, saved contacts, settings and your node’s address. If this iPhone is lost, restore it on
        the new one, then enter each wallet’s seed words.
      </p>
      <dl className="facts">
        <div>
          <dt>In it now</dt>
          <dd>
            {wallets} wallet{wallets === 1 ? '' : 's'}, {labels} label{labels === 1 ? '' : 's'}, {contacts} contact{contacts === 1 ? '' : 's'}
          </dd>
        </div>
        <div>
          <dt>Never in it</dt>
          <dd>Seed words, your node’s password, the two-factor key, the app PIN</dd>
        </div>
        <div>
          <dt>Last saved</dt>
          <dd>{app.settings.lastBackupAt ? day(app.settings.lastBackupAt) : 'Not yet'}</dd>
        </div>
      </dl>

      <div className="section-title">Save a backup</div>
      <Field label="Backup password" htmlFor="bpw" error={short ? `At least ${BACKUP_MIN_PASSWORD} characters` : undefined} hint="Needed to open the file. Write it with your seed words: it can’t be reset.">
        <input id="bpw" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </Field>
      <Field label="The same password again" htmlFor="bpw2" error={differ ? 'The two don’t match' : undefined}>
        <input id="bpw2" className="input" type="password" value={password2} onChange={(e) => setPassword2(e.target.value)} autoComplete="new-password" />
      </Field>
      {error && <div className="banner error">{error}</div>}
      {saved && <div className="banner on-banner">Backup made. Keep the file somewhere other than this iPhone, such as iCloud Drive or a computer.</div>}
      <button
        className="btn primary"
        disabled={!ready || busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          setSaved(false);
          try {
            const { text, fileName } = await app.makeBackup(password);
            await saveFile(fileName, text);
            setSaved(true);
            setPassword('');
            setPassword2('');
          } catch (e) {
            setError(friendlyError(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? 'Sealing the backup' : 'Save backup'}
      </button>
      <p className="note">The file is encrypted with the password (scrypt and XChaCha20-Poly1305). Anyone with both could see your balances and history, but not spend: that takes the seed words.</p>

      <div className="section-title">Restore from a backup</div>
      <RestoreBackup />
    </Screen>
  );
}

/**
 * Picks a backup file, asks for its password and restores it. Used in Settings, and on the welcome screen of a
 * new install, where `onRestored` moves setup along.
 */
export function RestoreBackup({ onRestored }: { onRestored?: (s: RestoreSummary) => void }) {
  const app = useApp();
  const nav = useNav();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ text: string; madeAt: Date } | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<RestoreSummary | null>(null);

  const picker = (
    <input
      ref={fileRef}
      type="file"
      accept=".json,application/json,text/plain"
      hidden
      onChange={async (e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (!f) return;
        setError(null);
        setSummary(null);
        try {
          const text = await f.text();
          setFile({ text, madeAt: app.backupMadeAt(text) });
        } catch (err) {
          setError(friendlyError(err));
        }
      }}
    />
  );

  if (summary) {
    return (
      <div>
        <div className="banner on-banner">
          Restored.
          {summary.settings ? ' Settings and your node’s address are back.' : ''}
          {summary.contacts ? ` ${summary.contacts} contact${summary.contacts === 1 ? '' : 's'} added.` : ''}
          {summary.labels ? ` ${summary.labels} label${summary.labels === 1 ? '' : 's'} added to wallets on this phone.` : ''}
          {summary.waiting.length ? ` Waiting for seed words: ${summary.waiting.join(', ')}.` : ''}
          {!summary.settings && !summary.contacts && !summary.labels && !summary.waiting.length ? ' Everything in it was already on this phone.' : ''}
        </div>
        {summary.waiting.length > 0 && !onRestored && (
          <button className="btn secondary" onClick={() => nav.push({ name: 'add-wallet' })}>
            Enter seed words
          </button>
        )}
      </div>
    );
  }

  if (!file) {
    return (
      <>
        {picker}
        {error && <div className="banner error">{error}</div>}
        <button className="btn secondary" onClick={() => fileRef.current?.click()}>
          Restore from a backup
        </button>
      </>
    );
  }

  return (
    <div>
      {picker}
      <p className="note" style={{ marginTop: 0 }}>
        Backup made {day(file.madeAt.getTime())}.
      </p>
      <Field label="Backup password" htmlFor="rpw">
        <input id="rpw" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </Field>
      {error && <div className="banner error">{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
        <button
          className="btn secondary"
          disabled={busy}
          onClick={() => {
            setFile(null);
            setPassword('');
            setError(null);
          }}
        >
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={!password || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const contents = await app.openBackup(file.text, password);
              const s = await app.restoreBackup(contents);
              setPassword('');
              setFile(null);
              setSummary(s);
              onRestored?.(s);
            } catch (e) {
              setError(friendlyError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Opening' : 'Restore'}
        </button>
      </div>
    </div>
  );
}
