// The iPhone widgets: the snapshot the app hands them, the short amounts for the round Lock Screen widget, the
// widget's colors against the stylesheet, and the script that adds the widget target to the Xcode project.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWidgetSnapshot, compactAmount, compactPrice, thin, WIDGET_TIME_STEP_MS, type WidgetInput } from '../src/app/widgets';
// @ts-expect-error plain JavaScript script without types
import { setUpWidgets, withGroup } from '../scripts/ios-widgets.mjs';

const T0 = Date.UTC(2026, 9, 20, 15, 42);

function input(over: Partial<WidgetInput> = {}): WidgetInput {
  return {
    appearance: 'system',
    skin: 'shrike',
    unit: 'BTC',
    network: 'mainnet',
    prices: true,
    showBalance: true,
    ticker: { last: 570.25, changePercent: 1.5 },
    priceAt: T0,
    chart: null,
    wallet: { id: 'w1', name: 'Spending', confirmed: 12_345_678, unconfirmed: 0 },
    syncedAt: T0,
    now: T0,
    ...over,
  };
}

describe('widget snapshot', () => {
  it('words the price and the balance as the app does', () => {
    const s = buildWidgetSnapshot(input(), null);
    expect(s.price).toMatchObject({ price: '$570.25', compact: '$570', change: '+1.50%', direction: 'up', at: T0, last: 570.25 });
    expect(s.balance).toMatchObject({ wallet: 'Spending', amount: '0.12 345 678', unit: 'BTC', compact: '0.123', usd: '$70.40', pending: null, network: null, at: T0 });
    expect(s.look).toEqual({ appearance: 'system', skin: 'shrike' });
  });

  it('uses sats when the app does, and says what is unconfirmed', () => {
    const s = buildWidgetSnapshot(input({ unit: 'sats', wallet: { id: 'w1', name: 'Spending', confirmed: 12_345_678, unconfirmed: -50_000 } }), null);
    expect(s.balance).toMatchObject({ amount: '12,345,678', unit: 'sats', compact: '12M', pending: '-50,000 sats unconfirmed' });
  });

  it('gives no dollar value off mainnet, and names the network', () => {
    const s = buildWidgetSnapshot(input({ network: 'testnet4' }), null);
    expect(s.balance?.usd).toBeNull();
    expect(s.balance?.network).toBe('Testnet4');
  });

  it('hands over no balance at all when it is hidden', () => {
    const s = buildWidgetSnapshot(input({ showBalance: false }), null);
    expect(s.showBalance).toBe(false);
    expect(s.balance).toBeNull();
    expect(JSON.stringify(s)).not.toContain('12 345 678');
  });

  it('hands over no price when prices are off, even one it had', () => {
    const before = buildWidgetSnapshot(input(), null);
    const s = buildWidgetSnapshot(input({ prices: false, ticker: null, priceAt: 0 }), before);
    expect(s.prices).toBe(false);
    expect(s.price).toBeNull();
    expect(s.balance?.usd).toBeNull();
  });

  it('keeps the last price across a restart, until a new one comes', () => {
    const before = buildWidgetSnapshot(input(), null);
    const s = buildWidgetSnapshot(input({ ticker: null, priceAt: 0, now: T0 + 3_600_000, syncedAt: null }), before);
    expect(s.price).toEqual(before.price);
    expect(s.balance?.at).toBe(T0);
  });

  it('moves the times forward only every few minutes while nothing shown changes', () => {
    const first = buildWidgetSnapshot(input(), null);
    const soon = buildWidgetSnapshot(input({ priceAt: T0 + 60_000, syncedAt: T0 + 60_000, now: T0 + 60_000 }), first);
    expect(JSON.stringify(soon)).toBe(JSON.stringify(first));
    const later = buildWidgetSnapshot(input({ priceAt: T0 + WIDGET_TIME_STEP_MS, syncedAt: T0 + WIDGET_TIME_STEP_MS, now: T0 + WIDGET_TIME_STEP_MS }), soon);
    expect(later.price?.at).toBe(T0 + WIDGET_TIME_STEP_MS);
    expect(later.balance?.at).toBe(T0 + WIDGET_TIME_STEP_MS);
    // A new price or balance is handed over at once, with its own time
    const moved = buildWidgetSnapshot(input({ ticker: { last: 571, changePercent: 1.6 }, priceAt: T0 + 60_000 }), first);
    expect(moved.price).toMatchObject({ price: '$571.00', at: T0 + 60_000 });
  });

  it('dates a balance that changed on the phone, between syncs, to now', () => {
    const first = buildWidgetSnapshot(input(), null);
    const s = buildWidgetSnapshot(input({ syncedAt: null, now: T0 + 30_000, wallet: { id: 'w1', name: 'Spending', confirmed: 2_345_678, unconfirmed: 0 } }), first);
    expect(s.balance?.at).toBe(T0 + 30_000);
  });

  it('draws the day as up to 48 points ending at the price, and leaves out a chart from hours before', () => {
    const closes = Array.from({ length: 96 }, (_, i) => 500 + i);
    const s = buildWidgetSnapshot(input({ chart: { closes, at: T0 - 60_000 } }), null);
    expect(s.price?.points).toHaveLength(48);
    expect(s.price?.points?.[0]).toBe(500);
    expect(s.price?.points?.[47]).toBe(570.25);
    const old = buildWidgetSnapshot(input({ chart: { closes, at: T0 - 3 * 3_600_000 } }), null);
    expect(old.price?.points).toBeNull();
  });

  it('calls a change under half a hundredth of a percent flat', () => {
    expect(buildWidgetSnapshot(input({ ticker: { last: 1, changePercent: 0.004 } }), null).price?.direction).toBe('flat');
    expect(buildWidgetSnapshot(input({ ticker: { last: 1, changePercent: -0.2 } }), null).price?.direction).toBe('down');
    expect(buildWidgetSnapshot(input({ ticker: { last: 1, changePercent: null } }), null).price).toMatchObject({ change: null, direction: null });
  });
});

describe('short amounts for the round Lock Screen widget', () => {
  it('cuts BTC to a few places and never rounds up', () => {
    const btc = (sats: number) => compactAmount(sats, 'BTC');
    expect(btc(0)).toBe('0');
    expect(btc(500)).toBe('0.000005');
    expect(btc(99_999)).toBe('0.00099999');
    expect(btc(12_399_999)).toBe('0.123');
    expect(btc(199_999_999)).toBe('1.99');
    expect(btc(1_299_999_999)).toBe('12.9');
    expect(btc(123_456_789_000)).toBe('1,234');
  });

  it('puts sats in thousands and millions', () => {
    const sats = (n: number) => compactAmount(n, 'sats');
    expect(sats(999)).toBe('999');
    expect(sats(1_999)).toBe('1.9K');
    expect(sats(999_999)).toBe('999K');
    expect(sats(9_999_999)).toBe('9.9M');
    expect(sats(123_456_789)).toBe('123M');
    expect(sats(2_100_000_000)).toBe('2.1B');
  });

  it('shortens prices', () => {
    expect(compactPrice(57.2)).toBe('$57.20');
    expect(compactPrice(570.25)).toBe('$570');
    expect(compactPrice(5702.4)).toBe('$5,702');
    expect(compactPrice(57_040)).toBe('$57.0K');
    expect(compactPrice(210_001.42)).toBe('$210K');
  });

  it('thins evenly and keeps both ends', () => {
    expect(thin([1, 2, 3], 48)).toEqual([1, 2, 3]);
    const t = thin(Array.from({ length: 96 }, (_, i) => i), 5);
    expect(t).toEqual([0, 24, 48, 71, 95]);
  });
});

describe('widget colors', () => {
  const css = readFileSync(join(__dirname, '../src/ui/styles.css'), 'utf8');
  const swift = readFileSync(join(__dirname, '../ios/App/ShrikeWidgets/Look.swift'), 'utf8').toLowerCase();
  const block = (selector: string) => {
    const i = css.indexOf(`${selector} {`);
    return css.slice(i, css.indexOf('}', i));
  };
  const v = (b: string, name: string) => new RegExp(`--${name}: (#[0-9a-f]{6})`).exec(b)?.[1];

  it('match the stylesheet’s paper and ink, light and dark', () => {
    for (const sel of [':root', ":root[data-theme='dark']"]) {
      const b = block(sel);
      for (const name of ['paper', 'ink', 'slate', 'eye']) expect(swift, `${sel} --${name}`).toContain(`0x${v(b, name)!.slice(1)}`);
    }
  });

  it('match each skin’s band', () => {
    for (const skin of ['shrike', 'redback', 'northern', 'gilded']) {
      const b = block(`[data-skin='${skin}']`);
      for (const name of ['on-mask', 'on-mask-dim', 'eye-glow']) expect(swift, `${skin} --${name}`).toContain(`0x${v(b, name)!.slice(1)}`);
      // Every color in the band's background, gradients included
      const bg = /--band-bg: ([^;]+);/.exec(b)![1];
      for (const hex of bg.match(/#[0-9a-f]{6}(?![0-9a-f])/g) ?? []) expect(swift, `${skin} band ${hex}`).toContain(`0x${hex.slice(1)}`);
    }
  });
});

describe('the Xcode project script', () => {
  const projectFile = join(__dirname, '../ios/App/App.xcodeproj/project.pbxproj');
  /** The project as 0.2.1 had it, before the widgets */
  const before = readFileSync(join(__dirname, 'vectors/project-before-widgets.pbxproj'), 'utf8');

  function copy(pbx: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'crossbill-ios-'));
    mkdirSync(join(dir, 'App.xcodeproj'));
    mkdirSync(join(dir, 'App'));
    mkdirSync(join(dir, 'ShrikeWidgets'));
    writeFileSync(join(dir, 'App.xcodeproj', 'project.pbxproj'), pbx);
    return dir;
  }

  function referencesResolve(pbx: string) {
    const defined = new Set([...pbx.matchAll(/^\t\t([0-9A-F]{24})\b/gm)].map((m) => m[1]));
    const used = new Set(pbx.match(/\b[0-9A-F]{24}\b/g));
    return [...used].filter((x) => !defined.has(x));
  }

  it('is already applied to the project in the repository, and changes nothing there', () => {
    const dir = copy(readFileSync(projectFile, 'utf8'));
    copyFileSync(join(__dirname, '../ios/App/App/App.entitlements'), join(dir, 'App', 'App.entitlements'));
    copyFileSync(join(__dirname, '../ios/App/ShrikeWidgets/ShrikeWidgets.entitlements'), join(dir, 'ShrikeWidgets', 'ShrikeWidgets.entitlements'));
    const r = setUpWidgets(dir);
    expect(r.changes).toEqual([]);
    expect(r.group).toBe('group.io.github.crossbill-wallet.app');
    expect(referencesResolve(r.text)).toEqual([]);
  });

  it('adds the target to a project with someone’s own bundle ID and team, keeping every line it had', () => {
    // An install from before the widgets, signed with someone's own team and bundle ID
    const original = before.replace(
      /PRODUCT_BUNDLE_IDENTIFIER = "io\.github\.crossbill-wallet\.app";/g,
      'DEVELOPMENT_TEAM = ABCDE12345;\n\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = "com.example.my-crossbill";',
    );
    const dir = copy(original);
    const r = setUpWidgets(dir);
    expect(r.changes.join('\n')).toMatch(/added the ShrikeWidgets target/);
    const out = readFileSync(join(dir, 'App.xcodeproj', 'project.pbxproj'), 'utf8');
    // Every line still there, in order
    const lines = out.split('\n');
    let j = 0;
    for (const line of original.split('\n')) {
      while (j < lines.length && lines[j] !== line) j++;
      expect(j, `kept: ${line}`).toBeLessThan(lines.length);
      j++;
    }
    expect(out).toContain('PRODUCT_BUNDLE_IDENTIFIER = "com.example.my-crossbill.widgets";');
    expect(out.match(/DEVELOPMENT_TEAM = ABCDE12345;/g)).toHaveLength(4);
    expect(referencesResolve(out)).toEqual([]);
    // The app copies the widgets in before the CocoaPods phase at the end
    const phases = /buildPhases = \(\n([\s\S]*?)\);/.exec(out.slice(out.indexOf('/* App */ = {\n\t\t\tisa = PBXNativeTarget;')))![1];
    expect(phases.indexOf('Embed Foundation Extensions')).toBeGreaterThan(phases.indexOf('/* Resources */'));
    expect(phases.indexOf('Embed Foundation Extensions')).toBeLessThan(phases.indexOf('[CP] Embed Pods Frameworks'));
    for (const f of ['App/App.entitlements', 'ShrikeWidgets/ShrikeWidgets.entitlements']) {
      expect(readFileSync(join(dir, f), 'utf8')).toContain('<string>group.com.example.my-crossbill</string>');
    }
    // A second run changes nothing
    expect(setUpWidgets(dir).changes).toEqual([]);
  });

  it('follows the app when its bundle ID or version changes later', () => {
    const dir = copy(readFileSync(projectFile, 'utf8'));
    setUpWidgets(dir);
    const pbx = join(dir, 'App.xcodeproj', 'project.pbxproj');
    const moved = readFileSync(pbx, 'utf8')
      .replace(/PRODUCT_BUNDLE_IDENTIFIER = "io\.github\.crossbill-wallet\.app";/g, 'PRODUCT_BUNDLE_IDENTIFIER = com.example.other;')
      .replace(/(isa = XCBuildConfiguration;\n\t\t\tbaseConfigurationReference = [^\n]+\n\t\t\tbuildSettings = \{\n[\s\S]*?)MARKETING_VERSION = [\d.]+;/g, '$1MARKETING_VERSION = 9.9.9;');
    writeFileSync(pbx, moved);
    const r = setUpWidgets(dir);
    expect(r.changes.join('\n')).toMatch(/matched the ShrikeWidgets/);
    const out = readFileSync(pbx, 'utf8');
    expect(out).toContain('PRODUCT_BUNDLE_IDENTIFIER = com.example.other.widgets;');
    expect(out).not.toContain('io.github.crossbill-wallet.app');
    expect(out.match(/MARKETING_VERSION = 9\.9\.9;/g)).toHaveLength(4);
    expect(readFileSync(join(dir, 'ShrikeWidgets/ShrikeWidgets.entitlements'), 'utf8')).toContain('group.com.example.other');
  });

  it('keeps what else an entitlements file holds', () => {
    const other = `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n\t<key>aps-environment</key>\n\t<string>development</string>\n</dict>\n</plist>\n`;
    const out = withGroup(other, 'group.x');
    expect(out).toContain('<key>aps-environment</key>');
    expect(out).toContain('<string>group.x</string>');
    expect(withGroup(out, 'group.y')).not.toContain('group.x');
  });
});
