import { useState } from 'react';
import { Share } from '@capacitor/share';
import { isNative } from '../app/native';
import { signerOf } from '../app/model';
import { Address, Field, Qr, Screen, copyText, useApp } from './kit';

export function Receive() {
  const app = useApp();
  const w = app.active!;
  const fresh = app.freshReceive(w);
  const [offset, setOffset] = useState(0);
  const index = fresh.index + offset;
  const address = app.addressAt(w, 0, index);
  const [label, setLabel] = useState(w.labels.get('addr', address) ?? '');
  const [copied, setCopied] = useState(false);
  // Bech32 is shown in upper case inside the QR code, which encodes more compactly, as Sparrow does
  const qrText = /^(bc|tb|bcrt)1/.test(address) ? `bitcoin:${address.toUpperCase()}` : `bitcoin:${address}`;

  const nextAddress = () => {
    void app.setLabel(w, 'addr', address, label);
    setOffset(offset + 1);
    setLabel('');
    setCopied(false);
  };

  return (
    <Screen title="Receive">
      <Qr text={qrText} />
      <div style={{ textAlign: 'center', marginBottom: 6 }}>
        <Address value={address} size="lg" />
      </div>
      <p className="note" style={{ textAlign: 'center', marginTop: 0 }}>
        {w.config.name}, address m/0/{index}
        {offset > 0 ? `, ${offset} past the next unused one` : ''}
      </p>
      {signerOf(w.config) !== 'phone' && (
        <p className="note" style={{ textAlign: 'center' }}>
          To check it on your Krux: <strong>Address</strong>, <strong>Scan Address</strong>, and point it at this code.
        </p>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, margin: '18px 0 22px' }}>
        <button
          className="btn secondary"
          onClick={async () => {
            setCopied(await copyText(address));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          className="btn secondary"
          onClick={async () => {
            if (isNative) await Share.share({ text: address });
            else setCopied(await copyText(address));
          }}
        >
          Share
        </button>
      </div>

      <Field label="Label" htmlFor="recv-label" hint="Saved with the address and shown on the payment when it arrives.">
        <input id="recv-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => void app.setLabel(w, 'addr', address, label)} placeholder="Who is paying, or what for" />
      </Field>

      <button className="btn quiet" onClick={nextAddress} disabled={offset >= w.config.gapLimit - 1}>
        Use a different address
      </button>
      {offset >= w.config.gapLimit - 1 && <p className="note">This is as far ahead as the wallet looks for payments. Use one of these addresses first.</p>}
    </Screen>
  );
}
