import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { ripemd160 as nobleRipemd160 } from '@noble/hashes/legacy.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { concat, type Bytes } from './bytes';

const utf8 = new TextEncoder();

export function sha256(b: Bytes): Bytes {
  return nobleSha256(b);
}

export function sha256d(b: Bytes): Bytes {
  return nobleSha256(nobleSha256(b));
}

export function hash160(b: Bytes): Bytes {
  return nobleRipemd160(nobleSha256(b));
}

/** Unkeyed BLAKE2b-256 (RFC 7693), as drongo's Blake2b256 wraps BouncyCastle. */
export function blake2b256(b: Bytes): Bytes {
  return blake2b(b, { dkLen: 32 });
}

const tagCache = new Map<string, Bytes>();

/** BIP340 tagged hash: sha256(sha256(tag) || sha256(tag) || msg). */
export function taggedHash(tag: string, ...msgs: Bytes[]): Bytes {
  let prefix = tagCache.get(tag);
  if (!prefix) {
    const t = nobleSha256(utf8.encode(tag));
    prefix = concat(t, t);
    tagCache.set(tag, prefix);
  }
  return nobleSha256(concat(prefix, ...msgs));
}
