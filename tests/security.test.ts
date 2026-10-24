// 0.3.0's security pieces on their own: the app PIN's hashing and rules, the encrypted backup file, and spotting
// look-alike addresses.

import { describe, expect, it } from 'vitest';
import { hashPin, pinMatches, pinProblem } from '../src/core/pin';
import { BackupError, decryptBackup, encryptBackup, readBackupHeader } from '../src/core/backup';
import { checkRecipient, looksAlike, sharedEnds, typePrefix, type KnownAddress } from '../src/core/poison';

const FAST = { N: 2 ** 10, r: 8, p: 1 };

describe('app PIN', () => {
  it('refuses PINs that are too short or too easy', () => {
    expect(pinProblem('12345')).toMatch(/6 digits/);
    expect(pinProblem('12a456')).toMatch(/6 digits/);
    expect(pinProblem('777777')).toMatch(/same/);
    expect(pinProblem('123456')).toMatch(/in order/);
    expect(pinProblem('987654')).toMatch(/in order/);
    expect(pinProblem('204816')).toBeNull();
    expect(pinProblem('135792')).toBeNull();
  });

  it('keeps only a salted hash, and checks against it', async () => {
    const h = await hashPin('204816', undefined, 1000);
    expect(JSON.stringify(h)).not.toContain('204816');
    expect(await pinMatches('204816', h)).toBe(true);
    expect(await pinMatches('204817', h)).toBe(false);
    const again = await hashPin('204816', undefined, 1000);
    expect(again.hash).not.toBe(h.hash);
  });
});

describe('backup file', () => {
  const contents = { wallets: [{ name: 'Spending', labels: [{ type: 'tx', ref: 'ab', label: 'Rent' }] }], contacts: [{ name: 'Exchange' }] };

  it('opens with its password and gives back what went in', async () => {
    const text = await encryptBackup(contents, 'correct horse battery', FAST);
    expect(text).not.toContain('Spending');
    expect(text).not.toContain('Rent');
    expect(await decryptBackup(text, 'correct horse battery')).toEqual(contents);
  });

  it('says so when the password is wrong', async () => {
    const text = await encryptBackup(contents, 'correct horse battery', FAST);
    await expect(decryptBackup(text, 'correct horse batterY')).rejects.toMatchObject({ kind: 'wrong-password' });
  });

  it('notices any change to the file, its settings included', async () => {
    const text = await encryptBackup(contents, 'correct horse battery', FAST);
    const f = JSON.parse(text);
    const flipped = { ...f, data: f.data.slice(0, 10) + (f.data[10] === 'A' ? 'B' : 'A') + f.data.slice(11) };
    await expect(decryptBackup(JSON.stringify(flipped), 'correct horse battery')).rejects.toBeInstanceOf(BackupError);
    const redated = { ...f, createdAt: '2020-01-01T00:00:00.000Z' };
    await expect(decryptBackup(JSON.stringify(redated), 'correct horse battery')).rejects.toMatchObject({ kind: 'wrong-password' });
  });

  it('refuses short passwords, other files, newer formats and costs that could exhaust memory', async () => {
    await expect(encryptBackup(contents, 'short', FAST)).rejects.toThrow(/at least 8/);
    expect(() => readBackupHeader('{"labels": []}')).toThrow(/isn’t a Crossbill backup/);
    expect(() => readBackupHeader('not json')).toThrow(/isn’t a Crossbill backup/);
    const text = await encryptBackup(contents, 'correct horse battery', FAST);
    const f = JSON.parse(text);
    expect(() => readBackupHeader(JSON.stringify({ ...f, shrikeBackup: 2 }))).toThrow(/newer version/);
    expect(() => readBackupHeader(JSON.stringify({ ...f, kdf: { ...f.kdf, N: 2 ** 24 } }))).toThrow(/damaged/);
    expect(() => readBackupHeader(JSON.stringify({ ...f, kdf: { ...f.kdf, N: 3000 } }))).toThrow(/damaged/);
    // 1 GiB and more of scrypt memory, or many lanes: refused before any work is done
    expect(() => readBackupHeader(JSON.stringify({ ...f, kdf: { ...f.kdf, N: 2 ** 20, r: 8 } }))).toThrow(/damaged/);
    expect(() => readBackupHeader(JSON.stringify({ ...f, kdf: { ...f.kdf, N: 2 ** 16, r: 32 } }))).toThrow(/damaged/);
    expect(() => readBackupHeader(JSON.stringify({ ...f, kdf: { ...f.kdf, p: 16 } }))).toThrow(/damaged/);
    expect(() => readBackupHeader(JSON.stringify({ ...f, kdf: { ...f.kdf, N: 2 ** 17, r: 16 } }))).not.toThrow();
  });

  it('is made with a cost of 64 MiB by default', async () => {
    const f = readBackupHeader(await encryptBackup({}, 'correct horse battery'));
    expect(f.kdf).toMatchObject({ name: 'scrypt', N: 2 ** 16, r: 8, p: 1 });
  });
});

describe('look-alike addresses', () => {
  const real = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
  // Same first five and last five characters after bc1q, different in the middle
  const fake = 'bc1qar0sxk9t3hy2u7pqzlm4w6d8ce5vn2gtzzwf5mdq'.slice(0, real.length - 5) + 'f5mdq';

  it('knows each kind of address by its start', () => {
    expect(typePrefix(real)).toBe('bc1q');
    expect(typePrefix('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297')).toBe('bc1p');
    expect(typePrefix('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080')).toBe('bcrt1q');
    expect(typePrefix('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe('1');
    expect(typePrefix('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe('3');
  });

  it('counts matching characters at each end, after each address’s own start', () => {
    expect(sharedEnds(real, fake).start).toBeGreaterThanOrEqual(4);
    expect(sharedEnds(real, fake).end).toBeGreaterThanOrEqual(5);
    expect(sharedEnds(real, '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy').start).toBe(0);
  });

  it('flags a look-alike, but not the same address or an unrelated one', () => {
    expect(looksAlike(real, fake)).toBe(true);
    expect(looksAlike(real, real.toUpperCase())).toBe(false);
    expect(looksAlike(real, 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh')).toBe(false);
  });

  it('flags a look-alike of another kind: Taproot made to look like SegWit, or 3 like 1', () => {
    const taproot = 'bc1p' + real.slice(4, 12) + 'x'.repeat(40) + real.slice(-6);
    expect(looksAlike(real, taproot)).toBe(true);
    expect(looksAlike('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', '3BvBMSxxxxxxxxxxxxxxxxxxxxxxxNVN2')).toBe(true);
  });

  it('counts three and five as alike as four and four', () => {
    const threeFive = real.slice(0, 7) + 'zzzzzzzz' + real.slice(15, -5).replace(/./g, 'z') + real.slice(-5);
    expect(sharedEnds(real, threeFive)).toMatchObject({ start: 3, end: 5 });
    expect(looksAlike(real, threeFive)).toBe(true);
  });

  it('treats base58 case as meaningful, and bech32 case as not', () => {
    const known: KnownAddress[] = [{ address: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', kind: 'paid' }];
    expect(checkRecipient('1bvbmseystwetqtfn5au4m4gfg7xjanvn2', known).exact).toBeNull();
    expect(checkRecipient(real.toUpperCase(), [{ address: real, kind: 'paid' }]).exact).not.toBeNull();
  });

  it('names what a recipient matches or resembles', () => {
    const known: KnownAddress[] = [
      { address: real, kind: 'paid', when: 1_760_000_000 },
      { address: real, kind: 'contact', name: 'Exchange deposit' },
      { address: 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', kind: 'own', name: 'Savings' },
    ];
    expect(checkRecipient(real, known).exact).toMatchObject({ kind: 'contact', name: 'Exchange deposit' });
    const c = checkRecipient(fake, known);
    expect(c.exact).toBeNull();
    expect(c.lookalikes).toHaveLength(1);
    expect(c.lookalikes[0]).toMatchObject({ kind: 'contact', name: 'Exchange deposit' });
    expect(checkRecipient('bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3', known)).toEqual({ exact: null, lookalikes: [] });
  });
});
