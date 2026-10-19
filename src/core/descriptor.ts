// Output descriptors in the two forms that matter here: the one Cormorant (Shrike's Bitcoin Knots backend)
// imports into the node's "cormorant" wallet, which carries no key origin, and the full form with origin.
// Matching Cormorant's form exactly means a wallet already synced by the desktop app is found on the node
// as is, with no import and no rescan.

import { SCRIPT_TYPE_INFO, type ScriptType } from './script';

const INPUT_CHARSET = "0123456789()[],'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#\"\\ ";
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];

function polymod(c: bigint, val: number): bigint {
  const c0 = c >> 35n;
  c = ((c & 0x7ffffffffn) << 5n) ^ BigInt(val);
  for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= GENERATOR[i];
  return c;
}

/** BIP380 descriptor checksum. */
export function descriptorChecksum(desc: string): string {
  let c = 1n;
  let cls = 0;
  let clscount = 0;
  for (const ch of desc) {
    const pos = INPUT_CHARSET.indexOf(ch);
    if (pos === -1) throw new Error(`Invalid character in descriptor: ${ch}`);
    c = polymod(c, pos & 31);
    cls = cls * 3 + (pos >> 5);
    if (++clscount === 3) {
      c = polymod(c, cls);
      cls = 0;
      clscount = 0;
    }
  }
  if (clscount > 0) c = polymod(c, cls);
  for (let i = 0; i < 8; i++) c = polymod(c, 0);
  c ^= 1n;
  let out = '';
  for (let i = 0; i < 8; i++) out += CHECKSUM_CHARSET[Number((c >> (5n * BigInt(7 - i))) & 31n)];
  return out;
}

/** As drongo's OutputDescriptor.normalize: hardened markers as h, then a fresh checksum. */
export function normalizeDescriptor(desc: string): string {
  let d = desc.replace(/'/g, 'h');
  const hash = d.lastIndexOf('#');
  if (hash > -1) d = d.slice(0, hash);
  return `${d}#${descriptorChecksum(d)}`;
}

export function stripChecksum(desc: string): string {
  const hash = desc.lastIndexOf('#');
  return hash > -1 ? desc.slice(0, hash) : desc;
}

export interface DescriptorSource {
  scriptType: ScriptType;
  xpub: string;
  fingerprint: string;
  derivation: string;
}

/** The form Cormorant imports: no key origin, no checksum (normalizeDescriptor adds one). */
export function cormorantDescriptor(src: DescriptorSource, chain: 0 | 1): string {
  return SCRIPT_TYPE_INFO[src.scriptType].descriptorWrap(`${src.xpub}/${chain}/*`);
}

/** The full form, with key origin and checksum, as Sparrow exports it. */
export function originDescriptor(src: DescriptorSource, chain: 0 | 1): string {
  const path = src.derivation.replace(/^m\/?/, '').replace(/'/g, 'h');
  const key = `[${src.fingerprint}${path ? '/' + path : ''}]${src.xpub}/${chain}/*`;
  const body = SCRIPT_TYPE_INFO[src.scriptType].descriptorWrap(key);
  return `${body}#${descriptorChecksum(body)}`;
}
