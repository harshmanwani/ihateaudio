/**
 * Captures real ihateaudio.com tool pages with a generated WAV loaded, so the
 * dark waveform stage shows a real waveform. Nothing is uploaded: the file is
 * built in memory and set on the page's own file input, which decodes it
 * locally in the browser.
 *
 *   node scripts/capture-tools.mjs [outDir] [baseUrl]
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const out = process.argv[2] ?? 'captures/tools';
const base = process.argv[3] ?? 'https://ihateaudio.com';
mkdirSync(out, { recursive: true });

// Generated test signals, one character per tool, so each montage shot shows
// a different real waveform instead of the same one eight times.
const VARIANTS = {
  default: { bpm: 120, kick: 0.75, snare: 1, hat: 1, bass: 0.35, pad: 0, speech: 0, decay: 1, dyn: [0.55, 0.9, 0.35, 1.0] },
  'audio-converter': { bpm: 128, kick: 0.6, snare: 0.8, hat: 1.2, bass: 0.45, pad: 0.35, speech: 0, decay: 1, dyn: [0.8, 1.0, 0.9, 1.0] },
  'vocal-remover': { bpm: 100, kick: 0.5, snare: 0.6, hat: 0.6, bass: 0.25, pad: 0.1, speech: 0.7, decay: 1, dyn: [0.7, 1.0, 0.6, 0.95] },
  'slowed-reverb': { bpm: 80, kick: 0.55, snare: 0.7, hat: 0.3, bass: 0.3, pad: 0.45, speech: 0, decay: 0.25, dyn: [0.5, 0.8, 1.0, 0.7] },
  'audio-transcriber': { bpm: 90, kick: 0, snare: 0, hat: 0, bass: 0, pad: 0, speech: 1, decay: 1, dyn: [1, 1, 1, 1] },
  'ringtone-maker': { bpm: 140, kick: 0.7, snare: 0.9, hat: 1.4, bass: 0.3, pad: 0.15, speech: 0, decay: 1.2, dyn: [0.9, 0.6, 1.0, 0.8] },
  'bpm-detector': { bpm: 120, kick: 0.95, snare: 0.7, hat: 0.6, bass: 0.2, pad: 0, speech: 0, decay: 1.4, dyn: [0.9, 1, 0.9, 1] },
  'bass-booster': { bpm: 110, kick: 0.95, snare: 0.6, hat: 0.5, bass: 0.6, pad: 0.1, speech: 0, decay: 0.7, dyn: [0.7, 1.0, 0.85, 1.0] },
};

function wav(seconds, slug) {
  const V = VARIANTS[slug] ?? VARIANTS.default;
  const rate = 44100, ch = 2, frames = rate * seconds;
  const bytes = new ArrayBuffer(44 + frames * ch * 2);
  const dv = new DataView(bytes);
  const a = (o, s) => { for (let i = 0; i < s.length; i += 1) dv.setUint8(o + i, s.charCodeAt(i)); };
  a(0, 'RIFF'); dv.setUint32(4, 36 + frames * ch * 2, true); a(8, 'WAVE'); a(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * ch * 2, true);
  dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true); a(36, 'data');
  dv.setUint32(40, frames * ch * 2, true);
  let o = 44;
  let seed = 7 + slug.length * 13;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const beat = 60 / V.bpm;
  for (let i = 0; i < frames; i += 1) {
    const t = i / rate;
    const bar = Math.floor(t / (beat * 4));
    const phrase = Math.floor(t / (beat * 16));
    const beatT = t % beat;
    const kick = Math.exp(-beatT * 20 * V.decay) * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-beatT * 30)) * t);
    const snT = (t + beat) % (beat * 2);
    const snare = (snT < beat * 0.5 ? Math.exp(-snT * 18 * V.decay) : 0) * rnd() * 0.55;
    const hatT = t % (beat / 4);
    const hat = Math.exp(-hatT * 90) * rnd() * 0.18;
    const note = [55, 55, 65.4, 49][bar % 4];
    const bass = Math.sin(2 * Math.PI * note * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 2 * t));
    const pad = (Math.sin(2 * Math.PI * note * 4 * t) + Math.sin(2 * Math.PI * note * 5.04 * t) * 0.7) * 0.5;
    // Speech-like: syllables of 120-260 ms with short gaps and phrase pauses.
    const syl = Math.floor(t / 0.19);
    const sylT = (t % 0.19) / 0.19;
    const pauseP = (t % 3.7) > 3.0;
    const sylAmp = pauseP ? 0 : (0.45 + 0.55 * Math.abs(Math.sin(syl * 12.9898) * 43758.5453 % 1)) * Math.sin(Math.PI * sylT) ** 1.5;
    const speech = sylAmp * (Math.sin(2 * Math.PI * 180 * t) * 0.6 + rnd() * 0.25 + Math.sin(2 * Math.PI * 540 * t) * 0.3);
    const lead = Math.sin(2 * Math.PI * note * 8 * t) * 0.12 * (t % (beat / 2) < beat * 0.36 ? 1 : 0);
    const dyn = V.dyn[phrase % 4] * (0.75 + 0.25 * Math.sin(t * 0.9));
    let v = (kick * V.kick + snare * V.snare + hat * V.hat + bass * V.bass + pad * V.pad + speech * V.speech + lead * (V.speech ? 0 : 1)) * dyn * 0.85;
    for (let c = 0; c < ch; c += 1) {
      const s = Math.max(-1, Math.min(1, v * (c ? 0.9 : 1)));
      dv.setInt16(o, s < 0 ? s * 32768 : s * 32767, true);
      o += 2;
    }
  }
  return Buffer.from(bytes).toString('base64');
}



async function feed(page, name, slug) {
  const b64 = wav(32, slug);
  await page.evaluate(({ b64, name }) => {
    const bin = atob(b64);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
    const file = new File([buf], name, { type: 'audio/wav' });
    const input = document.querySelector('[data-file-input]');
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { b64, name });
  await page.waitForSelector('[data-workspace]:not([hidden])', { timeout: 20000 });
  await page.waitForTimeout(1200);
}

const tools = (process.env.TOOLS ?? 'audio-trimmer,audio-converter,vocal-remover,slowed-reverb,audio-transcriber,ringtone-maker,bpm-detector,bass-booster,key-finder,audio-joiner,pitch-shifter,equalizer').split(',');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
// Block analytics so captures stay clean; nothing is sent anywhere.
await ctx.route(/posthog|google-analytics|googletagmanager|plausible|clarity/, (r) => r.abort());

for (const slug of tools) {
  const page = await ctx.newPage();
  try {
    await page.goto(`${base}/${slug}`, { waitUntil: 'networkidle', timeout: 45000 });
    await page.addStyleTag({ content: '*{caret-color:transparent!important} [data-cookie],[class*=cookie]{display:none!important}' });
    await page.screenshot({ path: join(out, `${slug}-empty.jpg`), type: 'jpeg', quality: 92 });
    await feed(page, 'my-track.wav', slug);
    if (slug === 'audio-trimmer' || slug === 'ringtone-maker') {
      const box = await page.locator('[data-canvas-wrap]').first().boundingBox();
      if (box) {
        const [x0, x1] = slug === 'audio-trimmer' ? [0.22, 0.61] : [0.34, 0.8];
        await page.mouse.move(box.x + box.width * x0, box.y + box.height / 2);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * x1, box.y + box.height / 2, { steps: 12 });
        await page.mouse.up();
        await page.mouse.move(5, 5);
        await page.waitForTimeout(500);
      }
    }
    // Put the workspace in view.
    await page.evaluate(() => document.querySelector('[data-workspace]')?.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(out, `${slug}-loaded.jpg`), type: 'jpeg', quality: 92 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(out, `${slug}-top.jpg`), type: 'jpeg', quality: 92 });
    const stage = page.locator('[data-stage]').first();
    if (await stage.count()) {
      await stage.screenshot({ path: join(out, `${slug}-stage.png`) });
    }
    const ws = page.locator('[data-workspace]').first();
    if (await ws.count()) {
      await ws.screenshot({ path: join(out, `${slug}-workspace.png`) });
    }
    console.log('ok', slug);
  } catch (e) {
    console.log('FAIL', slug, e.message.split('\n')[0]);
  }
  await page.close();
}
await browser.close();
