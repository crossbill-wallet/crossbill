// Appearance: light or dark, the skin, and the font. Applied as attributes on <html> that styles.css reads.

export type Appearance = 'system' | 'light' | 'dark';
export type SkinId = 'shrike' | 'redback' | 'northern' | 'gilded';
export type FontId = 'atkinson' | 'system' | 'plex';

export interface Skin {
  id: SkinId;
  name: string;
  detail: string;
  /** Confirmed mainnet balance, in sats, that opens this skin. Once reached it stays open. */
  minSats: number;
}

/** Each skin is named for a shrike. The band stays dark in all of them, so the status bar reads the same. */
export const SKINS: Skin[] = [
  { id: 'shrike', name: 'Shrike', detail: 'The black mask, ember edges and the cyan eye.', minSats: 0 },
  { id: 'redback', name: 'Red-backed', detail: 'Chestnut and warm amber, after the red-backed shrike.', minSats: 10_000_000 },
  { id: 'northern', name: 'Northern', detail: 'Night blue with an aurora glow, after the northern shrike.', minSats: 100_000_000 },
  { id: 'gilded', name: 'Gilded', detail: 'Black and gold.', minSats: 1_000_000_000 },
];

export interface FontChoice {
  id: FontId;
  name: string;
  detail: string;
}

export const FONTS: FontChoice[] = [
  { id: 'atkinson', name: 'Atkinson Hyperlegible', detail: 'The default. Drawn so similar letters and digits never look alike.' },
  { id: 'system', name: 'San Francisco', detail: 'The iPhone’s own font.' },
  { id: 'plex', name: 'IBM Plex', detail: 'Plex Sans with Plex Mono for amounts and addresses.' },
];

/** How many skins past the first a confirmed balance opens. */
export function tierFor(confirmedSats: number): number {
  let tier = 0;
  for (let i = 1; i < SKINS.length; i++) if (confirmedSats >= SKINS[i].minSats) tier = i;
  return tier;
}

export function skinIndex(id: SkinId): number {
  return Math.max(0, SKINS.findIndex((s) => s.id === id));
}

const THEME_CACHE = 'shrike.theme';

function systemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

export function resolveTheme(a: Appearance): 'light' | 'dark' {
  return a === 'system' ? (systemDark() ? 'dark' : 'light') : a;
}

/** Sets the attributes styles.css reads. Remembers the theme so the next launch paints it before settings load. */
export function applyLook(look: { appearance: Appearance; skin: SkinId; font: FontId }): 'light' | 'dark' {
  const theme = resolveTheme(look.appearance);
  const el = document.documentElement;
  el.dataset.theme = theme;
  el.dataset.skin = look.skin;
  el.dataset.font = look.font;
  el.style.colorScheme = theme;
  try {
    localStorage.setItem(THEME_CACHE, JSON.stringify(look));
  } catch {
    // storage refused: the next launch starts from the iPhone's setting instead
  }
  return theme;
}

/** Before settings are read: the look the app had last time, or the iPhone's light or dark setting. */
export function applyCachedLook(): void {
  let look: { appearance: Appearance; skin: SkinId; font: FontId } = { appearance: 'system', skin: 'shrike', font: 'atkinson' };
  try {
    const v = localStorage.getItem(THEME_CACHE);
    if (v) look = { ...look, ...JSON.parse(v) };
  } catch {
    // no cache
  }
  applyLook(look);
}

/** Calls back when the iPhone switches between light and dark, for the Match iPhone setting. */
export function onSystemThemeChange(cb: () => void): () => void {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!mq) return () => undefined;
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
