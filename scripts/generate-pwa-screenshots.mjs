/**
 * The two screenshots Chrome shows in its richer install dialog.
 *
 * Needs a running server, so this is not part of `npm run build`; the output is
 * committed, like the tool art. Re-run it when the tool UI changes shape:
 *
 *   npm run dev
 *   node scripts/generate-pwa-screenshots.mjs [baseUrl]
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'screenshots');
const base = process.argv[2] ?? 'http://localhost:4321';
mkdirSync(out, { recursive: true });

/** A short phrase of tone, so the shot shows a real waveform and not an empty stage. */
function wav(seconds) {
  const rate = 44100;
  const frames = rate * seconds;
  const bytes = new ArrayBuffer(44 + frames * 2);
  const dv = new DataView(bytes);
  const a = (o, s) => {
    for (let i = 0; i < s.length; i += 1) dv.setUint8(o + i, s.charCodeAt(i));
  };
  a(0, 'RIFF');
  dv.setUint32(4, 36 + frames * 2, true);
  a(8, 'WAVE');
  a(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  a(36, 'data');
  dv.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i += 1) {
    const t = i / rate;
    const env = Math.min(1, (t % 3) * 5) * Math.exp(-(t % 3) * 0.5);
    const kick = Math.exp(-((t % 0.5) * 20)) * 0.6;
    const v = (Math.sin(t * 220 * 2 * Math.PI) * 0.55 + kick) * env * 0.85;
    dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 32000, true);
  }
  return Buffer.from(bytes).toString('base64');
}

const audio = wav(21);
const browser = await chromium.launch();

for (const shot of [
  { file: 'desktop.png', width: 1280, height: 800, zoom: 3 },
  { file: 'mobile.png', width: 390, height: 844, zoom: 0, mobile: true },
]) {
  const page = await browser.newPage({
    viewport: { width: shot.width, height: shot.height },
    isMobile: Boolean(shot.mobile),
    hasTouch: Boolean(shot.mobile),
  });
  await page.goto(`${base}/audio-trimmer`);
  await page.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  await page.evaluate((b64) => {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
    const input = document.querySelector('[data-file-input]');
    const dt = new DataTransfer();
    dt.items.add(new File([buf], 'interview-take-2.wav', { type: 'audio/wav' }));
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, audio);
  await page.waitForSelector('[data-workspace]:not([hidden])');
  await page.waitForTimeout(600);

  // A selection, so the shot shows the tool mid-use rather than idle.
  const box = await page.locator('[data-canvas-wrap]').boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.66, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  for (let i = 0; i < shot.zoom; i += 1) await page.click('[data-zoom-in]');
  await page.waitForTimeout(600);

  await page.screenshot({ path: join(out, shot.file) });
  console.log(`${shot.file} ${shot.width}x${shot.height}`);
  await page.close();
}

await browser.close();
