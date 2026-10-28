// Turning notifications on and off in the app model, and a background check: what the native plugin is asked to
// do. The rules for which notifications a check gives are in notices.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => {
  const state = {
    granted: true,
    failBackground: false,
    vault: new Map<string, string>(),
    sets: [] as { key: string; afterFirstUnlock?: boolean; whenPasscodeSet?: boolean }[],
    checks: [] as boolean[],
    done: [] as { id: string; ok: boolean }[],
    listeners: new Map<string, (e: unknown) => void>(),
  };
  const native = {
    torStart: async () => undefined,
    torStatus: async () => ({ state: 'ready', progress: 100 }),
    torCheck: async () => ({ state: 'ready', controller: true, socks: true, circuit: true, port: 39050 }),
    torRepair: async () => ({ ok: true }),
    httpRequest: async () => ({ status: 500, body: '' }),
    vaultGet: async ({ key }: { key: string }) => ({ value: state.vault.get(key) ?? null }),
    vaultSet: async (o: { key: string; value: string; afterFirstUnlock?: boolean; whenPasscodeSet?: boolean }) => {
      if (o.afterFirstUnlock && state.failBackground) throw new Error('The Keychain refused to save this');
      state.vault.set(o.key, o.value);
      state.sets.push({ key: o.key, afterFirstUnlock: o.afterFirstUnlock, whenPasscodeSet: o.whenPasscodeSet });
    },
    vaultDelete: async () => undefined,
    authenticate: async () => ({ ok: true }),
    widgetsUpdate: async () => ({ ok: true }),
    widgetsInstalled: async () => ({ ok: true, widgets: [] }),
    notifyPermission: async () => ({ granted: state.granted }),
    notifyStatus: async () => ({ status: state.granted ? 'granted' : 'denied' }),
    notify: async () => undefined,
    backgroundChecks: async ({ on }: { on: boolean }) => void state.checks.push(on),
    backgroundCheckDone: async (o: { id: string; ok: boolean }) => void state.done.push(o),
    addListener: async (name: string, fn: (e: unknown) => void) => {
      state.listeners.set(name, fn);
      return { remove: async () => undefined };
    },
  };
  return { state, native };
});

vi.mock('../src/app/native', async () => {
  const actual = await vi.importActual<typeof import('../src/app/native')>('../src/app/native');
  return { ...actual, ShrikeNative: fake.native };
});

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

async function model() {
  const m = new AppModel();
  await m.init();
  return m;
}

beforeEach(() => {
  store.clear();
  fake.state.granted = true;
  fake.state.failBackground = false;
  fake.state.vault.clear();
  fake.state.sets = [];
  fake.state.checks = [];
  fake.state.done = [];
  fake.state.listeners.clear();
});

describe('notifications', () => {
  it('are off until turned on', async () => {
    const m = await model();
    expect(m.settings.notify.on).toBe(false);
    expect(fake.state.checks).toEqual([]);
  });

  it('turning on asks iOS, makes the node password readable while locked and asks for background checks', async () => {
    const m = await model();
    m.settings.node = { host: 'node.local', port: 8332, user: 'u', useTor: false, tls: false };
    fake.state.vault.set('rpc-password', 'secret');
    await m.setNotifications(true);
    expect(m.settings.notify.on).toBe(true);
    expect(fake.state.sets).toEqual([{ key: 'rpc-password', afterFirstUnlock: true, whenPasscodeSet: undefined }]);
    expect(fake.state.vault.get('rpc-password')).toBe('secret');
    expect(fake.state.checks).toEqual([true]);
  });

  it('turning off puts the password back as it was and stops the checks', async () => {
    const m = await model();
    m.settings.node = { host: 'node.local', port: 8332, user: 'u', useTor: false, tls: false };
    fake.state.vault.set('rpc-password', 'secret');
    await m.setNotifications(true);
    await m.setNotifications(false);
    expect(fake.state.sets[1]).toEqual({ key: 'rpc-password', afterFirstUnlock: false, whenPasscodeSet: undefined });
    expect(fake.state.checks).toEqual([true, false]);
    expect(m.settings.notify.on).toBe(false);
  });

  it('stay off when iOS says no, with the way to fix it', async () => {
    const m = await model();
    fake.state.granted = false;
    await expect(m.setNotifications(true)).rejects.toThrow(/iPhone’s Settings/);
    expect(m.settings.notify.on).toBe(false);
    expect(fake.state.checks).toEqual([]);
  });

  it('asks for background checks again at launch while on', async () => {
    const m = await model();
    await m.setNotifications(true);
    fake.state.checks = [];
    await model();
    expect(fake.state.checks).toEqual([true]);
  });

  it('a background check always tells iOS it finished', async () => {
    const m = await model();
    await m.setNotifications(true);
    fake.state.listeners.get('backgroundCheck')!({ id: 'task-1' });
    await vi.waitFor(() => expect(fake.state.done).toHaveLength(1));
    expect(fake.state.done[0].id).toBe('task-1');
  });

  it('stay off, with the password as it was, when the Keychain refuses', async () => {
    const m = await model();
    m.settings.node = { host: 'node.local', port: 8332, user: 'u', useTor: false, tls: false };
    fake.state.vault.set('rpc-password', 'secret');
    fake.state.failBackground = true;
    await expect(m.setNotifications(true)).rejects.toThrow(/refused/);
    expect(m.settings.notify.on).toBe(false);
    expect(fake.state.sets.at(-1)).toEqual({ key: 'rpc-password', afterFirstUnlock: false, whenPasscodeSet: undefined });
    expect(fake.state.checks).toEqual([]);
  });
});
