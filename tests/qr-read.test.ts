// The StartOS build's QR reader (src/app/qr-read.ts), on codes drawn the way a screen shows them: a Lightning Fork
// pairing link, the same code light on dark, and a Krux-style BBQr series read part by part.

import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import { fitWithin, pastedCodes, readQr, type Pixels } from '../src/app/qr-read';
import { bbqrEncode, QrAssembler } from '../src/core/qrtransfer';
import { parsePairingCode } from '../src/core/lfapi';

/** A code as pixels: `scale` pixels a module, a quiet zone of four modules, on a larger canvas when `canvas` is set. */
function draw(text: string, opts: { scale?: number; inverted?: boolean; canvas?: number } = {}): Pixels {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'L' });
  const { size, data } = qr.modules;
  const scale = opts.scale ?? 4;
  const codeSide = (size + 8) * scale;
  const side = Math.max(codeSide, opts.canvas ?? 0);
  const offset = Math.floor((side - codeSide) / 2) + 4 * scale;
  const px = new Uint8ClampedArray(side * side * 4);
  const dark = opts.inverted ? 255 : 0;
  const light = 255 - dark;
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const mx = Math.floor((x - offset) / scale);
      const my = Math.floor((y - offset) / scale);
      const on = mx >= 0 && my >= 0 && mx < size && my < size && x >= offset && y >= offset && data[my * size + mx] === 1;
      const v = on ? dark : light;
      const i = (y * side + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = v;
      px[i + 3] = 255;
    }
  }
  return { data: px, width: side, height: side };
}

const PAIRING_JSON = JSON.stringify({ lf: 1, code: 'e_0123456789abcdef', exp: 1767225600, onion: 'http://abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion' });
const PAIRING_LINK = `lightningfork://pair?c=${Buffer.from(PAIRING_JSON).toString('base64url')}`;

describe('reading QR codes from pixels', () => {
  it('reads a Lightning Fork pairing link that Crossbill then accepts', () => {
    const value = readQr(draw(PAIRING_LINK));
    expect(value).toBe(PAIRING_LINK);
    expect(parsePairingCode(value!)?.code).toBe('e_0123456789abcdef');
  });

  it('reads a code shown light on dark, as on a dark dashboard', () => {
    expect(readQr(draw(PAIRING_LINK, { inverted: true }))).toBe(PAIRING_LINK);
  });

  it('reads a small code in a larger picture, as in a screenshot', () => {
    expect(readQr(draw(PAIRING_LINK, { scale: 3, canvas: 900 }))).toBe(PAIRING_LINK);
  });

  it('answers null when there is no code', () => {
    const blank = new Uint8ClampedArray(200 * 200 * 4).fill(255);
    expect(readQr({ data: blank, width: 200, height: 200 })).toBeNull();
  });

  it('reads a BBQr series part by part into the data it carries', () => {
    const data = new Uint8Array(1800).map((_, i) => (i * 37 + 11) % 256);
    const parts = bbqrEncode(data, { version: 10 });
    expect(parts.length).toBeGreaterThan(1);
    const asm = new QrAssembler();
    let result = null;
    for (const part of parts) {
      const read = readQr(draw(part, { scale: 3 }));
      expect(read).toBe(part);
      result = asm.add(read!) ?? result;
    }
    expect(result).not.toBeNull();
  });
});

describe('sizes and pasted codes', () => {
  it('shrinks a large picture to fit and never enlarges a small one', () => {
    expect(fitWithin(4032, 3024, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(640, 480, 1600)).toEqual({ width: 640, height: 480 });
  });

  it('takes one code a line, leaving out blank lines and spaces around them', () => {
    expect(pastedCodes('  B$ZP0200abc \r\n\n B$ZP0201def\n')).toEqual(['B$ZP0200abc', 'B$ZP0201def']);
  });
});
