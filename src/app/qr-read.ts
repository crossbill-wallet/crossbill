// Reading a QR code out of pixels, for the StartOS build's scanner (src/app/server-scanner.ts). The iPhone reads
// codes with Apple's VisionKit; in a browser the page does it itself, from camera frames and from pictures.

import jsQR from 'jsqr';

export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** The text of the QR code in the picture, or null. Light codes on a dark background are read too. */
export function readQr(p: Pixels): string | null {
  const code = jsQR(p.data, p.width, p.height, { inversionAttempts: 'attemptBoth' });
  return code?.data || null;
}

/** The size to draw a picture at so that its longest side is at most `max`, never enlarging it. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** The codes in what was pasted, for a series of codes: one per line, blank lines left out. */
export function pastedCodes(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}
