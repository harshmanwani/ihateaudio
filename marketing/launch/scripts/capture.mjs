/**
 * Real screens of the live site, for the launch gallery and the directory listings.
 *
 * Every tool shot has audio loaded, because an empty dropzone sells nothing. The
 * audio is generated in memory and handed to the page's own file input, exactly
 * as scripts/shoot.mjs does it, so nothing is uploaded anywhere.
 *
 *   node marketing/launch/scripts/capture.mjs [baseUrl]
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'assets', 'screens');
const base = process.argv[2] ?? 'https://ihateaudio.com';
mkdirSync(out, { recursive: true });

/** A track-shaped signal: verses, a quiet break, a loud chorus, so the waveform has a shape. */
function track(seconds) {
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
    const bar = Math.floor(t / 2);
    const section = t < 8 ? 0.55 : t < 12 ? 0.22 : t < 24 ? 1 : 0.6;
    const swell = 0.75 + 0.25 * Math.sin(t * 0.9);
    const beat = t % 0.5;
    const kick = Math.exp(-beat * 26) * Math.sin(t * 52 * 2 * Math.PI) * 0.85;
    const snare = (beat > 0.25 && beat < 0.32 ? (Math.random() * 2 - 1) * Math.exp(-(beat - 0.25) * 40) : 0) * 0.45;
    const note = [220, 262, 196, 247][bar % 4];
    const pad = (Math.sin(t * note * 2 * Math.PI) * 0.35 + Math.sin(t * note * 3 * Math.PI) * 0.12) * swell;
    const v = (pad + kick + snare) * section * 0.78;
    for (let c = 0; c < ch; c += 1) {
      const s = Math.max(-1, Math.min(1, v * (c ? 0.9 : 1)));
      dv.setInt16(o, s < 0 ? s * 32768 : s * 32767, true);
      o += 2;
    }
  }
  return Buffer.from(bytes).toString('base64');
}

const audio = track(32);

async function feed(page, name) {
  await page.evaluate(
    ({ b64, name }) => {
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
      const input = document.querySelector('[data-file-input]');
      const dt = new DataTransfer();
      dt.items.add(new File([buf], name, { type: 'audio/wav' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { b64: audio, name }
  );
  await page.waitForSelector('[data-workspace]:not([hidden])');
  await page.waitForTimeout(900);
}

async function select(page, from, to) {
  const wrap = page.locator('[data-canvas-wrap]');
  if (!(await wrap.count())) return;
  const box = await wrap.boundingBox();
  await page.mouse.move(box.x + box.width * from, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);
}

const browser = await chromium.launch();
const viewport = { width: 1440, height: 900 };

async function open(path) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  // Hide the cross-promo strip and any install prompt; they are not the product.
  await page.addStyleTag({
    content: '.crosspromo,[data-install-prompt],astro-dev-toolbar{display:none!important}',
  });
  await page.waitForTimeout(400);
  return page;
}

async function save(page, file, opts = {}) {
  await page.screenshot({ path: join(out, file), ...opts });
  console.log(file);
}

// Homepage: the hero, then the tool grid.
{
  const page = await open('/');
  await save(page, 'home.png');
  await page.evaluate(() => document.querySelector('.hero')?.nextElementSibling?.scrollIntoView());
  await page.waitForTimeout(500);
  await save(page, 'home-grid.png');
  await save(page, 'home-full.png', { fullPage: true });
  await page.close();
}

// Tools with audio loaded. The scroll puts the dark stage near the top of the frame.
const TOOLS = [
  { slug: 'audio-trimmer', name: 'late-night-mix.wav', sel: [0.22, 0.64] },
  { slug: 'slowed-reverb', name: 'summer-song.wav' },
  { slug: 'vocal-remover', name: 'summer-song.wav' },
  { slug: 'stem-splitter', name: 'summer-song.wav' },
  { slug: 'audio-transcriber', name: 'interview-take-2.wav' },
  { slug: 'audio-converter', name: 'voice-memo.wav' },
  { slug: 'ringtone-maker', name: 'summer-song.wav', sel: [0.3, 0.52] },
  { slug: 'bpm-detector', name: 'late-night-mix.wav', wait: 2500 },
  { slug: 'equalizer', name: 'late-night-mix.wav' },
  { slug: 'audio-normalizer', name: 'podcast-ep-14.wav' },
  { slug: 'nightcore-maker', name: 'summer-song.wav' },
  { slug: 'bass-booster', name: 'late-night-mix.wav' },
];

for (const tool of TOOLS) {
  try {
    const page = await open(`/${tool.slug}`);
    await feed(page, tool.name);
    if (tool.sel) await select(page, ...tool.sel);
    if (tool.wait) await page.waitForTimeout(tool.wait);
    await page.evaluate(() => {
      const ws = document.querySelector('[data-workspace]');
      if (ws) window.scrollTo(0, Math.max(0, ws.getBoundingClientRect().top + window.scrollY - 96));
    });
    await page.waitForTimeout(400);
    await save(page, `${tool.slug}.png`);
    await page.close();
  } catch (error) {
    console.error(`${tool.slug}: ${error.message}`);
  }
}

await browser.close();
