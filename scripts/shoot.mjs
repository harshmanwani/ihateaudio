/**
 * Visual check harness. Loads a tool page, feeds it generated audio, drives the
 * waveform, and writes screenshots so states that need a real file in them can
 * actually be looked at.
 *
 *   node scripts/shoot.mjs <outDir> [baseUrl]
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? '/tmp/shots';
const base = process.argv[3] ?? 'http://localhost:4321';
mkdirSync(out, { recursive: true });

const FEED = (seconds) => {
  const rate = 44100;
  const ch = 2;
  const frames = rate * seconds;
  const bytes = new ArrayBuffer(44 + frames * ch * 2);
  const dv = new DataView(bytes);
  const a = (o, s) => {
    for (let i = 0; i < s.length; i += 1) dv.setUint8(o + i, s.charCodeAt(i));
  };
  a(0, 'RIFF');
  dv.setUint32(4, 36 + frames * ch * 2, true);
  a(8, 'WAVE');
  a(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, ch, true);
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * ch * 2, true);
  dv.setUint16(32, ch * 2, true);
  dv.setUint16(34, 16, true);
  a(36, 'data');
  dv.setUint32(40, frames * ch * 2, true);

  let o = 44;
  for (let i = 0; i < frames; i += 1) {
    const t = i / rate;
    const phrase = Math.floor(t / 6);
    const local = t % 6;
    const env = local > 5.1 ? 0 : Math.min(1, local * 6) * Math.exp(-local * 0.25);
    const kick = Math.exp(-((t % 0.5) * 22)) * 0.7;
    const note = [220, 277, 330, 165][phrase % 4];
    const quiet = phrase === 2 ? 0.18 : 1;
    let v =
      (Math.sin(t * note * 2 * Math.PI) * 0.5 +
        Math.sin(t * note * 4 * Math.PI) * 0.18) *
      env;
    v = (v + kick * Math.sin(t * 55 * 2 * Math.PI)) * quiet * 0.8;
    for (let c = 0; c < ch; c += 1) {
      const s = Math.max(-1, Math.min(1, v * (c ? 0.82 : 1)));
      dv.setInt16(o, s < 0 ? s * 32768 : s * 32767, true);
      o += 2;
    }
  }
  return Buffer.from(bytes).toString('base64');
};

const audio24 = FEED(24);

async function feed(page, b64, name = 'demo-track.wav') {
  await page.evaluate(
    ({ b64, name }) => {
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
      const file = new File([buf], name, { type: 'audio/wav' });
      const input = document.querySelector('[data-file-input]');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { b64, name }
  );
  await page.waitForSelector('[data-workspace]:not([hidden])');
  await page.waitForTimeout(450);
}

const browser = await chromium.launch();

async function shot(page, file, selector) {
  // The Astro dev toolbar floats over the bottom of every page in dev.
  await page.addStyleTag({ content: 'astro-dev-toolbar{display:none!important}' });
  const target = selector ? page.locator(selector) : page;
  await target.screenshot({ path: join(out, file) });
  console.log(`  ${file}`);
}

// ---- splitter: default, zoomed, sample view ----
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${base}/audio-splitter`);
  await feed(page, audio24);
  console.log('audio-splitter');
  await shot(page, 'splitter-full.png');
  await shot(page, 'splitter-stage.png', '[data-stage]');

  // Zoom in eight steps from the middle.
  for (let i = 0; i < 4; i += 1) await page.click('[data-zoom-in]');
  await page.waitForTimeout(500);
  await shot(page, 'splitter-zoom.png', '[data-stage]');

  // All the way in, to the individual-sample view. Stops when the button
  // disables itself at the zoom floor.
  const zoomIn = page.locator('[data-zoom-in]');
  for (let i = 0; i < 30; i += 1) {
    if (await zoomIn.isDisabled()) break;
    await zoomIn.click();
  }
  await page.waitForTimeout(360);
  await shot(page, 'splitter-samples.png', '[data-stage]');
  await page.close();
}

// ---- trimmer: selection handles plus zoom-to-selection ----
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${base}/audio-trimmer`);
  await feed(page, audio24);
  console.log('audio-trimmer');
  const box = await page.locator('[data-canvas-wrap]').boundingBox();
  await page.mouse.move(box.x + box.width * 0.24, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);
  await shot(page, 'trimmer-selection.png', '[data-stage]');
  await shot(page, 'trimmer-full.png');

  await page.click('[data-zoom-selection]');
  await page.waitForTimeout(500);
  await shot(page, 'trimmer-zoomsel.png', '[data-stage]');
  await page.close();
}

// ---- a controls-heavy page, and mobile ----
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${base}/equalizer`);
  await feed(page, audio24);
  console.log('equalizer');
  await shot(page, 'equalizer-full.png');
  await page.close();
}
{
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  await page.goto(`${base}/audio-splitter`);
  await feed(page, audio24);
  console.log('mobile');
  await shot(page, 'mobile-splitter.png');
  await page.close();
}

// ---- homepage, for the icons and the new green ----
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(`${base}/`);
  await page.waitForTimeout(700);
  console.log('home');
  await shot(page, 'home.png');
  await page.evaluate(() => window.scrollTo(0, 1500));
  await page.waitForTimeout(500);
  await shot(page, 'home-grid.png');
  await page.close();
}


// ---- the all-tools menu, and the reading half of a tool page ----
{
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${base}/audio-trimmer`);
  await page.waitForTimeout(400);
  console.log('nav + reading');
  await page.click('[data-meganav] summary');
  await page.waitForTimeout(400);
  await shot(page, 'meganav.png');

  await page.keyboard.press('Escape');
  await page.evaluate(() => document.querySelector('.toolread')?.scrollIntoView());
  await page.waitForTimeout(400);
  await shot(page, 'reading.png');
  await page.close();
}
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await page.goto(`${base}/audio-trimmer`);
  await page.waitForTimeout(300);
  await page.click('[data-meganav] summary');
  await page.waitForTimeout(400);
  await shot(page, 'meganav-mobile.png');
  await page.close();
}

await browser.close();
console.log(`\nwritten to ${out}`);
