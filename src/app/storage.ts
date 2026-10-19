// Non-secret app data (settings, wallet public keys, history cache, labels) as JSON files in the app's
// Library/NoCloud folder, which iCloud backups leave out. Secrets never go here: they live in the Keychain through the native plugin.

import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { isNative } from './native';

const DIR = 'shrike';

export async function readJson<T>(name: string): Promise<T | null> {
  if (!isNative) {
    const v = localStorage.getItem(`${DIR}/${name}`);
    return v ? (JSON.parse(v) as T) : null;
  }
  try {
    const res = await Filesystem.readFile({ path: `${DIR}/${name}`, directory: Directory.LibraryNoCloud, encoding: Encoding.UTF8 });
    return JSON.parse(res.data as string) as T;
  } catch {
    return null;
  }
}

export async function writeJson(name: string, value: unknown): Promise<void> {
  const data = JSON.stringify(value);
  if (!isNative) {
    localStorage.setItem(`${DIR}/${name}`, data);
    return;
  }
  await Filesystem.writeFile({ path: `${DIR}/${name}`, directory: Directory.LibraryNoCloud, encoding: Encoding.UTF8, data, recursive: true });
}

export async function removeJson(name: string): Promise<void> {
  if (!isNative) {
    localStorage.removeItem(`${DIR}/${name}`);
    return;
  }
  try {
    await Filesystem.deleteFile({ path: `${DIR}/${name}`, directory: Directory.LibraryNoCloud });
  } catch {
    // already gone
  }
}
