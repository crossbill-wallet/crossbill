// The app model's two-factor checks, with the browser stand-ins for the Keychain (memory) and files
// (localStorage, shimmed here). Covers what the checks guard, codes being used up at once, recovery codes,
// the lockout, and the Keychain record deciding whether two-factor is on.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
};

const { AppModel } = await import('../src/app/model');
const { ShrikeNative } = await import('../src/app/native');
const { encodeSecret, newTotpSecret, totp } = await import('../src/core/totp');

let now = 1_760_000_000_000;
let mono = 1_000;

async function fresh() {
  const m = new AppModel();
  await m.init();
  return m;
}

async function withTwoFactor() {
  const m = await fresh();
  const secret = encodeSecret(newTotpSecret());
  const { decodeSecret } = await import('../src/core/totp');
  const codes = await m.enableTwoFactor(secret, totp(decodeSecret(secret), now / 1000));
  return { m, key: decodeSecret(secret), codes };
}

beforeEach(async () => {
  store.clear();
  await ShrikeNative.vaultDelete({ key: 'two-factor' });
  now = 1_760_000_000_000;
  mono = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(performance, 'now').mockImplementation(() => mono);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('two-factor in the model', () => {
  it('does nothing while off', async () => {
    const m = await fresh();
    await expect(m.checkSecondFactor(undefined)).resolves.toBeUndefined();
  });

  it('needs a code once on, and shows the recovery codes until confirmed', async () => {
    const { m, codes } = await withTwoFactor();
    expect(m.settings.twoFactor).toBe(true);
    expect(codes).toHaveLength(8);
    expect(m.pendingRecoveryCodes).toEqual(codes);
    m.acknowledgeRecoveryCodes();
    expect(m.pendingRecoveryCodes).toBeNull();
    await expect(m.checkSecondFactor(undefined)).rejects.toThrow(/Enter the code/);
    await expect(m.checkSecondFactor('')).rejects.toThrow(/Enter the code/);
  });

  it('refuses the setup code a second time, and takes the next one once', async () => {
    const { m, key } = await withTwoFactor();
    await expect(m.checkSecondFactor(totp(key, now / 1000))).rejects.toThrow(/used already/);
    const next = totp(key, now / 1000 + 30);
    await expect(m.checkSecondFactor(next)).resolves.toBeUndefined();
    // Used up as soon as it was accepted, whatever happened after
    await expect(m.checkSecondFactor(next)).rejects.toThrow(/used already/);
  });

  it('lets two checks at once share no code', async () => {
    const { m, key } = await withTwoFactor();
    const next = totp(key, now / 1000 + 30);
    const results = await Promise.allSettled([m.checkSecondFactor(next), m.checkSecondFactor(next)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('takes each recovery code once, however it is typed', async () => {
    const { m, codes } = await withTwoFactor();
    await m.checkSecondFactor(codes[2].toLowerCase());
    expect(m.recoveryLeft).toBe(7);
    await expect(m.checkSecondFactor(codes[2])).rejects.toThrow(/recovery code/);
  });

  it('locks out after five wrong codes, counting down on the monotonic clock, not the wall clock', async () => {
    const { m, key } = await withTwoFactor();
    for (let i = 0; i < 5; i++) await expect(m.checkSecondFactor('000000')).rejects.toThrow(/doesn’t match/);
    expect(m.twoFactorWait()).toBe(30);
    // Setting the iPhone's date forward doesn't help
    now += 3_600_000;
    const good = totp(key, now / 1000);
    await expect(m.checkSecondFactor(good)).rejects.toThrow(/Too many wrong codes/);
    mono += 31_000;
    await expect(m.checkSecondFactor(good)).resolves.toBeUndefined();
    expect(m.twoFactorWait()).toBe(0);
  });

  it('keeps the lockout across a relaunch', async () => {
    const { m } = await withTwoFactor();
    for (let i = 0; i < 10; i++) {
      mono += 31_000;
      await m.checkSecondFactor('000000').catch(() => undefined);
    }
    expect(m.twoFactorWait()).toBe(300);
    const again = await fresh();
    expect(again.twoFactorWait()).toBe(300);
  });

  it('turns off only with a code, and is off after', async () => {
    const { m, key } = await withTwoFactor();
    await expect(m.disableTwoFactor('123456')).rejects.toThrow();
    expect(m.settings.twoFactor).toBe(true);
    await m.disableTwoFactor(totp(key, now / 1000 + 30));
    expect(m.settings.twoFactor).toBe(false);
    await expect(m.checkSecondFactor(undefined)).resolves.toBeUndefined();
  });

  it('stays on when the settings file is lost but the wallets and the Keychain record are not', async () => {
    await withTwoFactor();
    store.set('shrike/wallets.json', '[]');
    store.delete('shrike/settings.json');
    const m = await fresh();
    expect(m.settings.twoFactor).toBe(true);
    await expect(m.checkSecondFactor(undefined)).rejects.toThrow(/Enter the code/);
  });

  it('clears a record left from an earlier install on a fresh one', async () => {
    await withTwoFactor();
    store.clear();
    const m = await fresh();
    expect(m.settings.twoFactor).toBe(false);
    expect((await ShrikeNative.vaultGet({ key: 'two-factor', prompt: '' })).value).toBeNull();
  });

  it('guards showing seed words and opening them with a passphrase', async () => {
    const { m } = await withTwoFactor();
    await ShrikeNative.vaultSet({ key: 'seed:abc', value: JSON.stringify({ mnemonic: 'x', passphrase: '' }), requireAuth: true });
    await expect(m.revealSeed('abc')).rejects.toThrow(/Enter the code/);
    await expect(m.seedForPassphraseWallet('abc')).rejects.toThrow(/Enter the code/);
  });

  it('makes new recovery codes only with a code, and the old ones stop working', async () => {
    const { m, key, codes } = await withTwoFactor();
    m.acknowledgeRecoveryCodes();
    const fresh8 = await m.replaceRecoveryCodes(totp(key, now / 1000 + 30));
    expect(m.pendingRecoveryCodes).toEqual(fresh8);
    await expect(m.checkSecondFactor(codes[0])).rejects.toThrow(/recovery code/);
    await expect(m.checkSecondFactor(fresh8[0])).resolves.toBeUndefined();
  });
});
