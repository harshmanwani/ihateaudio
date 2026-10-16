/**
 * Records real ihateaudio.com tool sessions for launch video v2.
 *
 * Each take drives the live page with a visible cursor (the page has no cursor of
 * its own in a headless browser), drops a real file on the real drop zone, and
 * records the screen with the DevTools screencast: one JPEG per painted frame with
 * its timestamp. `takes/<name>/frames.txt` is an ffmpeg concat list, and
 * `takes/<name>/events.json` holds the time of every click relative to the first
 * frame, so the sound edit can line up with what the cursor does. Files the page
 * saves (the trimmed memo, the separated music) land in `takes/<name>/`.
 *
 *   node scripts/record-tools.mjs <take> [--base https://ihateaudio.com]
 *   takes: trim, vocals, slowed, ringtone, bpm
 *
 * Then: sh scripts/encode-take.sh takes/<take>
 */
import { chromium } from '@playwright/test';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const take = process.argv[2];
const base = process.argv.includes('--base') ? process.argv[process.argv.indexOf('--base') + 1] : 'https://ihateaudio.com';
const root = new URL('..', import.meta.url).pathname;
const MEMO = join(root, 'assets/audio/demo/voice-memo.mp3');
const SONG = join(root, 'assets/audio/demo/where-you-are-now.mp3');
const out = join(root, 'takes', take);
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'frames'), { recursive: true });

// A model cache that outlives one run, so the vocal remover's 64 MB model downloads once.
const profile = join(root, '.cache/record-profile');
// A 1280x720 page drawn at 1.5x: the screencast then delivers real 1920x1080 frames.
// (Emulated deviceScaleFactor alone still screencasts at 1280x720.)
const ctx = await chromium.launchPersistentContext(profile, {
  viewport: null,
  args: ['--force-device-scale-factor=1.5', '--window-size=1280,720'],
  acceptDownloads: true,
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.route(/posthog/, (r) => r.abort());

// Cursor and a file chip, drawn into the page so they are part of the recording.
await page.addInitScript(() => {
  const css = `
    html { scrollbar-width: none; } ::-webkit-scrollbar { display: none; }
    #rec-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none;
      width: 26px; height: 26px; transform: translate(-100px, -100px); transition: none; }
    #rec-cursor svg { width: 26px; height: 26px; transform-origin: 3px 2px; transition: transform 90ms ease-out; display: block;
      filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.35)); }
    #rec-cursor.down svg { transform: scale(.86); }
    #rec-chip { position: absolute; left: 22px; top: 22px; display: none; align-items: center; gap: 8px; white-space: nowrap;
      padding: 8px 12px 8px 10px; border-radius: 10px; background: #fff; border: 1px solid #DEE3E0;
      box-shadow: 0 10px 24px -8px rgba(15,22,17,.35); font: 500 14px/1 'Instrument Sans', system-ui, sans-serif; color: #0F1611; }
    #rec-chip.on { display: flex; }
    #rec-chip i { width: 18px; height: 22px; border-radius: 3px; background: #006E3D; display: block; }`;
  const mount = () => {
    if (document.getElementById('rec-cursor')) return;
    const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
    const c = document.createElement('div'); c.id = 'rec-cursor';
    c.innerHTML = '<svg viewBox="0 0 26 26"><path d="M3 2 L3 21 L8 16.5 L11.4 24 L14.6 22.6 L11.3 15.2 L18 15.2 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><div id="rec-chip"><i></i><span></span></div>';
    document.body.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`; }, true);
    addEventListener('mousedown', () => c.classList.add('down'), true);
    addEventListener('mouseup', () => c.classList.remove('down'), true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mount); else mount();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let mouse = { x: 1180, y: 640 };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
async function moveTo(x, y, ms = 600) {
  const from = { ...mouse };
  const steps = Math.max(2, Math.round(ms / 16));
  for (let i = 1; i <= steps; i += 1) {
    const k = ease(i / steps);
    await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k);
    await sleep(ms / steps);
  }
  mouse = { x, y };
}
async function centerOf(selector) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`not on screen: ${selector}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
}
async function click(x, y, ms = 550) {
  await moveTo(x, y, ms);
  await sleep(90);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
}
async function scrollBy(dy, ms = 600) {
  await page.evaluate(({ dy, ms }) => new Promise((done) => {
    const y0 = scrollY, t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      scrollTo({ top: y0 + dy * e, behavior: 'instant' }); // the site sets scroll-behavior: smooth
      if (k < 1) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
  }), { dy, ms });
}
async function chip(name) {
  await page.evaluate((name) => {
    const c = document.getElementById('rec-chip');
    c.querySelector('span').textContent = name || '';
    c.classList.toggle('on', !!name);
  }, name);
}
// Drop a real file on the real drop zone, the way a drag from the desktop arrives.
async function dropFile(file, ms = 800) {
  const target = await centerOf('[data-drop]');
  await chip(basename(file));
  await moveTo(target.x, target.y + 20, ms);
  const b64 = readFileSync(file).toString('base64');
  await page.evaluate(({ b64, name, x, y }) => {
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], name, { type: 'audio/mpeg' }));
    const el = document.elementFromPoint(x, y) || document.querySelector('[data-drop]');
    for (const type of ['dragenter', 'dragover']) el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
    window.__recDrop = () => {
      el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
    };
  }, { b64, name: basename(file), x: target.x, y: target.y + 20 });
  await sleep(350);
  await page.evaluate(() => window.__recDrop());
  await chip(null);
  await page.waitForFunction(() => !document.querySelector('[data-workspace]')?.hasAttribute('hidden'), null, { timeout: 60_000 });
}

// Screencast.
const cdp = await ctx.newCDPSession(page);
const frames = [];
const events = [];
let recording = false;
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  if (recording) {
    const file = `frames/${String(frames.length).padStart(5, '0')}.jpg`;
    writeFileSync(join(out, file), Buffer.from(data, 'base64'));
    frames.push({ file, ts: metadata.timestamp });
  }
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});
const mark = (name) => events.push({ name, wall: Date.now() / 1000 });
async function start() {
  recording = true;
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
  await page.mouse.move(mouse.x, mouse.y);
  await sleep(300);
  mark('start');
}
async function stop() {
  mark('end');
  await sleep(200);
  await cdp.send('Page.stopScreencast');
  recording = false;
  const t0 = frames[0].ts;
  const end = events.at(-1).wall;
  const lines = ["ffconcat version 1.0"];
  frames.forEach((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].ts : Math.max(f.ts + 1 / 30, end);
    lines.push(`file '${f.file}'`, `duration ${(next - f.ts).toFixed(5)}`);
  });
  lines.push(`file '${frames.at(-1).file}'`);
  writeFileSync(join(out, 'frames.txt'), lines.join('\n') + '\n');
  writeFileSync(join(out, 'events.json'), JSON.stringify(events.map((e) => ({ name: e.name, t: +(e.wall - t0).toFixed(3) })), null, 2));
  console.log(`${take}: ${frames.length} frames over ${(end - t0).toFixed(2)} s`);
  console.log(events.map((e) => `  ${e.name} @ ${(e.wall - t0).toFixed(2)}`).join('\n'));
}
async function saveNext(trigger) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), trigger()]);
  const file = join(out, dl.suggestedFilename());
  await dl.saveAs(file);
  return file;
}
async function open(slug) {
  await page.goto(`${base}/${slug}`, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await sleep(400);
}

const TAKES = {
  async trim() {
    await open('audio-trimmer');
    await start();
    await sleep(400);
    await dropFile(MEMO);
    mark('drop');
    await sleep(700);
    const handle = await centerOf('[data-handle="start"]');
    const canvas = (await centerOf('[data-canvas]')).box;
    const dur = await page.evaluate(() => { const t = document.querySelector('[data-handle="end"]')?.textContent || '0:13.90'; const [m, s] = t.trim().split(':'); return +m * 60 + +s; });
    await moveTo(handle.x, handle.y, 650);
    await sleep(120);
    await page.mouse.down();
    mark('grab');
    await moveTo(canvas.x + canvas.width * (10.15 / dur), handle.y, 1000);
    await page.mouse.up();
    mark('release');
    await sleep(300);
    const play = await centerOf('[data-play]');
    await click(play.x, play.y, 550);
    mark('play');
    await sleep(3300);
    await scrollBy(300, 550);
    const dl = await centerOf('button[data-download]');
    let saved;
    await moveTo(dl.x, dl.y, 500);
    console.log('download button', JSON.stringify(dl.box), 'mouse', JSON.stringify(mouse), 'cursor', await page.evaluate(() => document.getElementById('rec-cursor').style.transform), 'hit', await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.outerHTML.slice(0, 60), dl));
    saved = await saveNext(async () => { await sleep(80); await page.mouse.down(); await sleep(90); await page.mouse.up(); });
    mark('download');
    await sleep(900);
    await stop();
    console.log('saved', saved);
  },
  async vocals() {
    await open('vocal-remover');
    await start();
    await sleep(400);
    await dropFile(SONG);
    mark('drop');
    await sleep(600);
    const go0 = (await centerOf('[data-runner] [data-analyze]')).box;
    await scrollBy(Math.max(0, go0.y - 360), 650);
    const go = await centerOf('[data-runner] [data-analyze]');
    await click(go.x, go.y, 600);
    mark('separate');
    await page.waitForFunction(() => document.querySelector('[data-runner]')?.getAttribute('data-state') === 'done', null, { timeout: 15 * 60_000, polling: 250 });
    mark('done');
    await sleep(500);
    const panel = (await centerOf('[data-stem-panel]')).box;
    await scrollBy(panel.y - 150, 500);
    await sleep(500);
    const playAll = await centerOf('[data-stem-play]');
    await click(playAll.x, playAll.y, 600);
    mark('mixplay');
    await sleep(1700);
    const mute = await centerOf('[aria-label="Mute Vocal"]');
    await click(mute.x, mute.y, 650);
    mark('mute');
    await sleep(3400);
    await stop();
    // The page's own separated halves of this exact clip, for the sound edit.
    await page.selectOption('[data-stem-format]', 'wav').catch(() => page.selectOption('[data-stem-format]', { label: 'WAV' }));
    for (const name of ['Music', 'Vocal']) console.log('saved', await saveNext(() => page.click(`[aria-label="Download ${name}"]`)));
  },
  async slowed() {
    await open('slowed-reverb');
    await page.setInputFiles('[data-file-input]', SONG);
    await page.waitForFunction(() => !document.querySelector('[data-workspace]')?.hasAttribute('hidden'), null, { timeout: 60_000 });
    await sleep(1500);
    await start();
    const play = await centerOf('[data-play]');
    await click(play.x, play.y, 500);
    mark('play');
    await sleep(2600);
    await stop();
    const dl = page.locator('button[data-download]').first();
    if (await dl.count()) console.log('saved', await saveNext(() => dl.click()));
  },
  async ringtone() {
    await open('ringtone-maker');
    await page.setInputFiles('[data-file-input]', SONG);
    await page.waitForFunction(() => !document.querySelector('[data-workspace]')?.hasAttribute('hidden'), null, { timeout: 60_000 });
    await sleep(1500);
    await start();
    const play = await centerOf('[data-play]');
    await click(play.x, play.y, 500);
    mark('play');
    await sleep(2600);
    await stop();
  },
  async bpm() {
    await open('bpm-detector');
    await start();
    await sleep(300);
    await dropFile(SONG, 600);
    mark('drop');
    await page.waitForFunction(() => { const b = document.querySelector('[data-bpm]')?.textContent?.trim(); return b && b !== '···'; }, null, { timeout: 60_000 });
    mark('bpm');
    await sleep(500);
    await scrollBy(340, 600);
    await sleep(1400);
    await stop();
  },
};

if (!TAKES[take]) throw new Error(`unknown take: ${take} (${Object.keys(TAKES).join(', ')})`);
await TAKES[take]();
await ctx.close();
