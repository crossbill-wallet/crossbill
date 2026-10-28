import { useState } from 'react';
import { friendlyError } from '../app/model';
import { ShrikeNative } from '../app/native';
import { Address, Chevron, Field, Screen, copyText, parsePaymentText, shortAddress, useApp, useNav } from './kit';
import { isServer } from '../app/target';

/** The Contacts tab: addresses saved to send to again, such as exchange deposit addresses. */
export function Contacts() {
  const app = useApp();
  const nav = useNav();
  const list = app.networkContacts();
  return (
    <Screen
      title="Contacts"
      back={false}
      end={
        <button onClick={() => nav.push({ name: 'contact' })} aria-label="Add a contact">
          Add
        </button>
      }
    >
      {list.length === 0 ? (
        <div className="empty" style={{ padding: '24px 0' }}>
          <strong>No saved addresses yet</strong>
          Save an exchange deposit address or a friend’s address once, then pick it from Saved on the Send screen. After you send to a new address, the app offers to save it.
          <div style={{ marginTop: 18 }}>
            <button className="btn primary" onClick={() => nav.push({ name: 'contact' })}>
              Add an address
            </button>
          </div>
        </div>
      ) : (
        <ul className="list flush">
          {list.map((c) => (
            <li key={c.id}>
              <button className="row" onClick={() => nav.push({ name: 'contact', id: c.id })}>
                <div className="main">
                  <div className="title">{c.name}</div>
                  <div className="meta">
                    <span className="mono">{shortAddress(c.address)}</span>
                    {c.lastUsed ? `, paid ${new Date(c.lastUsed).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : c.note ? `, ${c.note}` : ''}
                  </div>
                </div>
                <span className="go" aria-hidden>
                  <Chevron dir="right" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="note" style={{ marginTop: 18 }}>
        Exchanges sometimes change deposit addresses. Before sending a large amount, check in the exchange that it still uses the address saved here.
      </p>
    </Screen>
  );
}

/** Adds a saved address, or shows and edits one. */
export function ContactEdit({ id, address, label }: { id?: string; address?: string; label?: string }) {
  const app = useApp();
  const nav = useNav();
  const existing = id ? app.contactById(id) : undefined;
  const [name, setName] = useState(existing?.name ?? label ?? '');
  const [addr, setAddr] = useState(existing?.address ?? address ?? '');
  const [note, setNote] = useState(existing?.note ?? '');
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copied, setCopied] = useState(false);
  const changed = !existing || name !== existing.name || addr !== existing.address || note !== (existing.note ?? '');

  const fill = (text: string) => {
    const v = parsePaymentText(text);
    setAddr(v.address);
    if (v.label && !name) setName(v.label);
  };

  return (
    <Screen title={existing ? existing.name : 'New contact'}>
      {existing && (
        <>
          <div className="contact-card">
            <Address value={existing.address} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 8 }}>
            <button className="btn primary" onClick={() => nav.push({ name: 'send', address: existing.address, label: existing.name })}>
              Send
            </button>
            <button
              className="btn secondary"
              onClick={async () => {
                setCopied(await copyText(existing.address));
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="section-title">Edit</div>
        </>
      )}
      <Field label="Name" htmlFor="c-name">
        <input id="c-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Such as Kraken deposit" />
      </Field>
      <Field label="Address" htmlFor="c-addr">
        <textarea
          id="c-addr"
          className="input mono"
          rows={2}
          style={{ minHeight: 64 }}
          value={addr}
          onChange={(e) => fill(e.target.value)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="Address"
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button
            className="btn secondary small"
            onClick={async () => {
              const r = await ShrikeNative.scanQr().catch(() => ({ value: null }));
              if (r.value) fill(r.value);
            }}
          >
            Scan QR code
          </button>
          <button
            className="btn secondary small"
            onClick={async () => {
              try {
                fill(await navigator.clipboard.readText());
              } catch {
                // clipboard read refused
              }
            }}
          >
            Paste
          </button>
        </div>
      </Field>
      <Field label="Note" htmlFor="c-note" hint={`Optional. Only on this ${isServer ? 'server' : 'phone'}.`}>
        <input id="c-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Such as checked 18 Oct" />
      </Field>
      {error && <div className="banner error">{error}</div>}
      <button
        className={existing ? 'btn secondary' : 'btn primary'}
        style={{ width: '100%' }}
        disabled={!changed || !name.trim() || !addr.trim()}
        onClick={async () => {
          setError(null);
          try {
            await app.saveContact({ id, name, address: addr, note });
            nav.pop();
          } catch (e) {
            setError(friendlyError(e));
          }
        }}
      >
        {existing ? 'Save changes' : 'Save'}
      </button>
      {existing && (
        <>
          <div className="section-title">Delete</div>
          {confirmDelete ? (
            <div style={{ display: 'grid', gap: 10 }}>
              <button
                className="btn danger"
                onClick={async () => {
                  await app.deleteContact(existing.id);
                  nav.pop();
                }}
              >
                Delete {existing.name}
              </button>
              <button className="btn secondary" onClick={() => setConfirmDelete(false)}>
                Keep it
              </button>
            </div>
          ) : (
            <button className="btn danger" onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
        </>
      )}
    </Screen>
  );
}
