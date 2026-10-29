// The StartOS build's QR scanner: what the iPhone's VisionKit scanner is to the iPhone app (src/app/native.ts,
// scanQr). It covers the page with the camera of whatever device has Crossbill open, a phone or a computer, and
// reads codes from its frames. Two other ways in sit under it: a picture of a code (a screenshot, when the code
// is on this same screen, or a photo), and pasting the code's text.
//
// As on the iPhone: in the usual mode the first code read closes it and is the answer. In parts mode, for a
// hardware wallet's animated codes, each new code is handed on and it stays open until finish() or Cancel.
// Cancel answers null either way.
//
// A browser lets a page use the camera only from a secure address: https, an onion in Tor Browser, or localhost.

import { fitWithin, pastedCodes, readQr, type Pixels } from './qr-read';

export interface ScannerOptions {
  parts: boolean;
  title: string;
  /** A new code read in parts mode */
  onPart: (value: string) => void;
}

export interface Scanner {
  /** The code read, "finished" when a series was finished, or null when cancelled */
  done: Promise<string | null>;
  /** Shows how far along a series is; reset forgets the codes already handed on, so they're handed on again */
  progress(text: string, reset: boolean): void;
  /** Closes the scanner with this answer */
  finish(value: string | null): void;
}

/** Longest side of a camera frame as it's read: smaller reads faster, and codes on a screen stay readable */
const FRAME_MAX = 960;
/** How often a frame is read, in ms */
const READ_EVERY_MS = 120;
/** Pictures are read at this size first, then at the larger one if no code turned up */
const PICTURE_SIZES = [1600, 3200];

type CameraTrouble = 'insecure' | 'denied' | 'none' | 'other';

function cameraMessage(trouble: CameraTrouble, detail?: string): string {
  switch (trouble) {
    case 'insecure':
      return 'The browser allows the camera only on Crossbill’s https:// address. Open Crossbill there to scan, or use a picture or paste below.';
    case 'denied':
      return 'The camera is blocked for this page. Allow it in the browser’s settings for this site, or use a picture or paste below.';
    case 'none':
      return 'No camera found on this device. Use a picture or paste below.';
    case 'other':
      return `The camera couldn’t start${detail ? ` (${detail})` : ''}. Use a picture or paste below.`;
  }
}

function troubleOf(e: unknown): CameraTrouble {
  const name = e instanceof DOMException || e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') return 'none';
  return 'other';
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

async function picturePixels(file: File, max: number): Promise<Pixels> {
  let source: CanvasImageSource;
  let width: number;
  let height: number;
  let release = () => {};
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    source = bitmap;
    width = bitmap.width;
    height = bitmap.height;
    release = () => bitmap.close();
  } else {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
    } finally {
      URL.revokeObjectURL(url);
    }
    source = img;
    width = img.naturalWidth;
    height = img.naturalHeight;
  }
  try {
    const size = fitWithin(width, height, max);
    const canvas = el('canvas', { width: size.width, height: size.height });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('This browser can’t read pictures');
    ctx.drawImage(source, 0, 0, size.width, size.height);
    return ctx.getImageData(0, 0, size.width, size.height);
  } finally {
    release();
  }
}

/** The code in a picture, or null if none could be read. */
export async function readPicture(file: File): Promise<string | null> {
  for (const max of PICTURE_SIZES) {
    const pixels = await picturePixels(file, max);
    const value = readQr(pixels);
    if (value) return value;
    // The picture was read whole at this size: a larger try reads nothing new
    if (pixels.width < max && pixels.height < max) return null;
  }
  return null;
}

export function openScanner(opts: ScannerOptions): Scanner {
  let resolveDone: (v: string | null) => void = () => {};
  const done = new Promise<string | null>((r) => (resolveDone = r));
  const seen = new Set<string>();
  let closed = false;
  let stream: MediaStream | null = null;
  let timer: number | undefined;
  let cameras: MediaDeviceInfo[] = [];
  let cameraIndex = -1;
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  // ------------------------------------------------------------------ the page

  const cancel = el('button', { type: 'button', className: 'scanner-cancel', textContent: 'Cancel' });
  const switchCamera = el('button', { type: 'button', className: 'scanner-switch', textContent: 'Switch camera', hidden: true });
  const heading = el('h2', { id: 'scanner-title', textContent: opts.title });
  const progressLine = el('p', { className: 'scanner-progress', hidden: true });
  const top = el('header', { className: 'scanner-top' }, cancel, el('div', { className: 'scanner-heading' }, heading, progressLine), switchCamera);

  const video = el('video', { muted: true, autoplay: true, playsInline: true });
  video.setAttribute('aria-hidden', 'true');
  const frame = el('div', { className: 'scanner-frame' });
  const cameraNote = el('p', { className: 'scanner-camera-note', textContent: 'Starting the camera…' });
  const view = el('div', { className: 'scanner-view' }, video, frame, cameraNote);

  const status = el('p', { className: 'scanner-status', hidden: true });
  status.setAttribute('role', 'status');
  const fileInput = el('input', { type: 'file', accept: 'image/*', multiple: opts.parts, hidden: true });
  const openPicture = el('button', { type: 'button', className: 'btn secondary', textContent: opts.parts ? 'Open pictures of the codes' : 'Open a picture of the code' });
  const openPaste = el('button', { type: 'button', className: 'btn secondary', textContent: opts.parts ? 'Paste the codes’ text' : 'Paste the code’s text' });
  const hint = el('p', {
    className: 'scanner-hint',
    textContent: opts.parts
      ? 'Pictures and pasted codes count too: open several pictures at once, or paste one code per line.'
      : 'Is the code on this same screen? Take a screenshot of it, then open the screenshot as a picture.',
  });
  const actions = el('div', { className: 'scanner-actions' }, el('div', { className: 'scanner-buttons' }, openPicture, openPaste), hint, fileInput);

  const pasteBox = el('textarea', { className: 'input mono', rows: 4, spellcheck: false, placeholder: opts.parts ? 'One code per line' : 'The code’s text' });
  pasteBox.setAttribute('autocapitalize', 'none');
  pasteBox.setAttribute('autocorrect', 'off');
  pasteBox.setAttribute('aria-label', 'The code’s text');
  const pasteBack = el('button', { type: 'button', className: 'btn secondary', textContent: 'Back' });
  const pasteUse = el('button', { type: 'submit', className: 'btn primary', textContent: opts.parts ? 'Add' : 'Use this code' });
  const paste = el('form', { className: 'scanner-paste', hidden: true }, pasteBox, el('div', { className: 'scanner-buttons' }, pasteBack, pasteUse));

  const root = el('div', { className: 'scanner' }, top, view, el('div', { className: 'scanner-bottom' }, status, actions, paste));
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'scanner-title');

  const say = (text: string) => {
    status.textContent = text;
    status.hidden = text === '';
  };

  // ------------------------------------------------------------------ reading

  /** A code from any of the three ways in. In parts mode, true when it was new */
  const take = (value: string): boolean => {
    if (closed) return false;
    if (!opts.parts) {
      finish(value);
      return true;
    }
    if (seen.has(value)) return false;
    seen.add(value);
    opts.onPart(value);
    return true;
  };

  const canvas = el('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const readFrame = () => {
    timer = undefined;
    if (closed || !stream) return;
    if (ctx && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
      const size = fitWithin(video.videoWidth, video.videoHeight, FRAME_MAX);
      if (canvas.width !== size.width) canvas.width = size.width;
      if (canvas.height !== size.height) canvas.height = size.height;
      ctx.drawImage(video, 0, 0, size.width, size.height);
      const value = readQr(ctx.getImageData(0, 0, size.width, size.height));
      if (value) take(value);
    }
    if (!closed) timer = window.setTimeout(readFrame, READ_EVERY_MS);
  };

  const stopCamera = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  };

  const startCamera = async () => {
    stopCamera();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      cameraNote.textContent = cameraMessage('insecure');
      return;
    }
    cameraNote.textContent = 'Starting the camera…';
    cameraNote.hidden = false;
    const chosen = cameras[cameraIndex];
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: chosen ? { deviceId: { exact: chosen.deviceId } } : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
    };
    let s: MediaStream;
    try {
      s = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      cameraNote.textContent = cameraMessage(troubleOf(e), e instanceof Error ? e.message : undefined);
      return;
    }
    if (closed) {
      s.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = s;
    const facing = s.getVideoTracks()[0]?.getSettings().facingMode;
    // A camera facing the person (a laptop's, say) is shown as a mirror, as people expect; reading isn't affected
    video.classList.toggle('mirrored', facing !== 'environment');
    video.srcObject = s;
    try {
      await video.play();
    } catch {
      // Autoplay of a muted video is allowed; a refusal here still leaves frames to read once it plays
    }
    cameraNote.hidden = true;
    say(opts.parts ? 'Hold the codes inside the square. Each one is read as it shows.' : 'Hold the code inside the square.');
    if (cameras.length === 0) {
      // Device labels and the full list are available only once the camera is allowed
      try {
        cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      } catch {
        cameras = [];
      }
      const current = s.getVideoTracks()[0]?.getSettings().deviceId;
      cameraIndex = Math.max(0, cameras.findIndex((c) => c.deviceId === current));
      switchCamera.hidden = cameras.length < 2;
    }
    readFrame();
  };

  // ------------------------------------------------------------------ the other ways in

  openPicture.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    if (files.length === 0) return;
    say(files.length > 1 ? `Reading ${files.length} pictures…` : 'Reading the picture…');
    let found = 0;
    let fresh = 0;
    for (const file of files) {
      let value: string | null = null;
      try {
        value = await readPicture(file);
      } catch {
        value = null;
      }
      if (closed) return;
      if (value) {
        found++;
        if (take(value)) fresh++;
        if (closed) return;
      }
    }
    if (found === 0) say(files.length > 1 ? 'No QR code found in those pictures. Try pictures where the code fills more of the frame.' : 'No QR code found in that picture. Try one where the code fills more of the frame.');
    else if (opts.parts) say(`${fresh} new ${fresh === 1 ? 'code' : 'codes'} read from ${files.length === 1 ? 'the picture' : `${files.length} pictures`}.`);
  });

  const showPaste = (on: boolean) => {
    paste.hidden = !on;
    actions.hidden = on;
    if (on) pasteBox.focus();
    else openPaste.focus();
  };
  openPaste.addEventListener('click', () => showPaste(true));
  pasteBack.addEventListener('click', () => showPaste(false));
  paste.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = pasteBox.value.trim();
    if (!text) return;
    if (!opts.parts) {
      take(text);
      return;
    }
    let fresh = 0;
    for (const code of pastedCodes(text)) {
      if (take(code)) fresh++;
      if (closed) return;
    }
    pasteBox.value = '';
    say(fresh ? `${fresh} new ${fresh === 1 ? 'code' : 'codes'} added.` : 'Those codes were already read.');
    pasteBox.focus();
  });

  // ------------------------------------------------------------------ opening and closing

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      finish(null);
    }
  };

  function finish(value: string | null) {
    if (closed) return;
    closed = true;
    stopCamera();
    document.removeEventListener('keydown', onKey, true);
    root.remove();
    previousFocus?.focus();
    resolveDone(value);
  }

  cancel.addEventListener('click', () => finish(null));
  switchCamera.addEventListener('click', () => {
    if (cameras.length < 2) return;
    cameraIndex = (cameraIndex + 1) % cameras.length;
    void startCamera();
  });
  document.addEventListener('keydown', onKey, true);
  document.body.append(root);
  cancel.focus();
  void startCamera();

  return {
    done,
    progress(text, reset) {
      if (reset) seen.clear();
      progressLine.textContent = text;
      progressLine.hidden = text === '';
    },
    finish,
  };
}
