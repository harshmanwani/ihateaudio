/**
 * The launch gallery: Product Hunt slides (1270x760), the thumbnail, and the
 * sizes the directories ask for. Each slide is a small HTML page rendered by
 * Playwright at 2x, so the type stays sharp and the real screens stay real.
 *
 *   node marketing/launch/scripts/capture.mjs   # first, for the screens
 *   node marketing/launch/scripts/gallery.mjs
 */
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const assets = join(here, '..', 'assets');
const screens = join(assets, 'screens');
const work = join(assets, '.build');
mkdirSync(work, { recursive: true });

const url = (path) => pathToFileURL(path).href;
const font = url(join(root, 'public', 'fonts', 'instrument-sans-latin.woff2'));
const icon = (slug) => url(join(root, 'public', 'icons3d', `${slug}.png`));
const shot = (name) => url(join(screens, `${name}.png`));

const C = {
  tile: '#0c3524',
  tileDeep: '#08261a',
  bright: '#38e08f',
  ink: '#0f1b16',
  ink2: '#4f5f58',
  brand: '#1d5e47',
  soft: '#eef6f2',
  line: '#dfe7e3',
  amber: '#f0a63a',
  stage: '#111a16',
};

const MARK = `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="32" rx="7" fill="${C.tile}"/><g fill="${C.bright}"><rect x="4" y="12" width="3" height="8" rx="1.5"/><rect x="9" y="8" width="3" height="16" rx="1.5"/><rect x="14" y="1" width="3" height="30" rx="1.5"/><rect x="19" y="9" width="3" height="14" rx="1.5"/><rect x="24" y="12" width="3" height="8" rx="1.5"/></g></svg>`;

const wordmark = (dark) => `
  <div class="brand">
    <span class="brand__mark">${MARK}</span>
    <span class="brand__word" style="color:${dark ? '#fff' : C.ink}">ihate<span style="color:${dark ? C.bright : C.brand}">audio</span></span>
  </div>`;

const BASE_CSS = `
@font-face{font-family:'Instrument Sans';src:url('${font}') format('woff2');font-weight:400 700;font-display:block}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1270px;height:760px;overflow:hidden}
body{font-family:'Instrument Sans',system-ui,sans-serif;-webkit-font-smoothing:antialiased;position:relative}
.brand{display:flex;align-items:center;gap:12px}
.brand__mark svg{width:40px;height:40px;display:block}
.brand__word{font-size:30px;font-weight:700;letter-spacing:-0.035em}
h1{font-weight:650;letter-spacing:-0.035em;line-height:1.02;text-wrap:balance}
.sub{font-size:23px;line-height:1.4;font-weight:450}
.frame{border-radius:16px;overflow:hidden;box-shadow:0 30px 80px -20px rgba(8,38,26,.45),0 0 0 1px rgba(8,38,26,.08)}
.frame img{display:block;width:100%}
.bar{height:34px;background:#f2f5f3;display:flex;align-items:center;gap:7px;padding:0 14px;border-bottom:1px solid ${C.line}}
.bar i{width:11px;height:11px;border-radius:50%;background:#d5dcd8;display:block}
.bar b{margin-left:18px;font-weight:500;font-size:13px;color:${C.ink2};background:#fff;border:1px solid ${C.line};border-radius:7px;padding:3px 14px}
.chip{display:inline-flex;align-items:center;gap:8px;font-size:16px;font-weight:600;padding:7px 14px;border-radius:999px}
`;

const browserFrame = (src, path, style = '') => `
  <div class="frame" style="${style}">
    <div class="bar"><i></i><i></i><i></i><b>ihateaudio.com${path}</b></div>
    <img src="${src}">
  </div>`;

/** Shows a region of a 1440px-wide capture: (x, y) in CSS px, scaled by s. */
const crop = (name, x, y, s) =>
  `<img src="${shot(name)}" style="display:block;width:${1440 * s}px;max-width:none;margin-left:${-x * s}px;margin-top:${-y * s}px">`;

const glow = (x, y, color, size = 900) =>
  `radial-gradient(${size}px ${size * 0.7}px at ${x} ${y}, ${color}, transparent 70%)`;

const SLIDES = [
  {
    file: '01-hero',
    html: `
<body style="background:${glow('85%', '0%', 'rgba(56,224,143,.22)')},${C.tile}">
  <div style="position:absolute;left:72px;top:58px">${wordmark(true)}</div>
  <h1 style="position:absolute;left:72px;top:138px;font-size:76px;color:#fff;width:760px">49 free audio tools.<br><span style="color:${C.bright}">Right in your browser.</span></h1>
  <p class="sub" style="position:absolute;left:74px;top:322px;color:rgba(255,255,255,.72)">No signup. No upload. No watermark.</p>
  ${browserFrame(shot('home'), '', 'position:absolute;left:470px;top:400px;width:900px;transform:rotate(-2deg);transform-origin:left top')}
  <div style="position:absolute;left:72px;bottom:64px;display:flex;flex-direction:column;gap:12px">
    ${['Trim', 'Convert', 'Remove vocals', 'Slowed + reverb', 'Transcribe']
      .map((t) => `<span class="chip" style="background:rgba(56,224,143,.12);color:${C.bright};border:1px solid rgba(56,224,143,.28);width:max-content">${t}</span>`)
      .join('')}
  </div>
</body>`,
  },
  {
    file: '02-drop-a-file',
    html: `
<body style="background:${glow('10%', '100%', 'rgba(56,224,143,.16)', 1100)},#fff">
  <div style="position:absolute;left:72px;top:56px;display:flex;align-items:center;gap:14px">
    <img src="${icon('audio-trimmer')}" style="width:52px;height:52px">
    <span class="chip" style="background:${C.soft};color:${C.brand}">Audio Trimmer</span>
  </div>
  <h1 style="position:absolute;left:72px;top:132px;font-size:64px;color:${C.ink};width:1100px">Drop a file in. Get it back fixed.</h1>
  <p class="sub" style="position:absolute;left:74px;top:214px;color:${C.ink2}">Trim, cut, fade and download. It happens the instant you ask.</p>
  <div class="frame" style="position:absolute;left:72px;top:290px;width:1126px;height:520px;border-radius:18px;background:#fff">
    ${crop('audio-trimmer', 180, 96, 1126 / 1080)}
  </div>
</body>`,
  },
  {
    file: '03-ai-studio',
    html: `
<body style="background:${glow('90%', '10%', 'rgba(240,166,58,.18)', 900)},${glow('0%', '100%', 'rgba(56,224,143,.14)', 900)},${C.stage}">
  <span class="chip" style="position:absolute;left:72px;top:60px;background:rgba(240,166,58,.14);color:${C.amber};border:1px solid rgba(240,166,58,.3)">AI studio · runs on your device</span>
  <h1 style="position:absolute;left:72px;top:122px;font-size:64px;color:#fff;width:1100px">Remove vocals. Split a song into stems.</h1>
  <p class="sub" style="position:absolute;left:74px;top:204px;color:rgba(255,255,255,.7)">Vocal remover, acapella extractor, song splitter, transcriber, subtitles. Free.</p>
  <div style="position:absolute;left:72px;top:288px;display:flex;gap:22px">
    ${[
      ['vocal-remover', 'Vocal Remover'],
      ['acapella-extractor', 'Acapella'],
      ['stem-splitter', 'Song Splitter'],
      ['audio-transcriber', 'Transcriber'],
      ['subtitle-generator', 'Subtitles'],
      ['noise-remover', 'Noise Remover'],
    ]
      .map(
        ([s, n]) => `<div style="display:flex;flex-direction:column;align-items:center;gap:8px;width:96px">
          <img src="${icon(s)}" style="width:64px;height:64px"><span style="color:rgba(255,255,255,.75);font-size:14px;font-weight:500;text-align:center">${n}</span></div>`
      )
      .join('')}
  </div>
  <div class="frame" style="position:absolute;left:560px;top:420px;width:780px;height:420px;background:#fff;padding:22px;box-shadow:0 30px 90px -10px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.08)">
    <div style="overflow:hidden;border-radius:12px">${crop('stem-splitter', 180, 96, 0.72)}</div>
  </div>
</body>`,
  },
  {
    file: '04-effects',
    html: `
<body style="background:${glow('100%', '100%', 'rgba(124,77,176,.14)', 1000)},#fbfaff">
  <div style="position:absolute;left:72px;top:56px;display:flex;gap:10px">
    ${['slowed-reverb', 'nightcore-maker', '8d-audio-maker', 'pitch-shifter', 'bass-booster'].map((s) => `<img src="${icon(s)}" style="width:52px;height:52px">`).join('')}
  </div>
  <h1 style="position:absolute;left:72px;top:136px;font-size:64px;color:${C.ink};width:640px">Slowed + reverb. Nightcore. 8D.</h1>
  <p class="sub" style="position:absolute;left:74px;top:290px;color:${C.ink2};width:520px">The edits everyone wants, without the sketchy sites. One slider, then download.</p>
  <div style="position:absolute;left:72px;top:420px;display:flex;flex-wrap:wrap;gap:10px;width:520px">
    ${['Speed', 'Pitch', 'Tempo', 'Reverb', 'Echo', 'Bass boost', 'Equalizer', 'Voice changer', 'Stereo widener']
      .map((t) => `<span class="chip" style="background:#f1ecfa;color:#5b3b86">${t}</span>`)
      .join('')}
  </div>
  <div class="frame" style="position:absolute;left:640px;top:96px;width:720px;height:720px">
    <img src="${shot('slowed-reverb')}" style="width:1000px;margin-left:-118px;margin-top:-60px">
  </div>
</body>`,
  },
  {
    file: '05-all-tools',
    html: `
<body style="background:#fff">
  <div style="position:absolute;left:72px;top:64px;width:390px">
    <div style="font-size:150px;font-weight:700;letter-spacing:-0.06em;line-height:.9;color:${C.brand}">49</div>
    <h1 style="font-size:46px;color:${C.ink};margin-top:18px">audio tools you keep googling for.</h1>
    <p class="sub" style="color:${C.ink2};margin-top:20px;font-size:20px">Cut and join. Convert. Volume and loudness. Speed and pitch. Effects. Ringtones, BPM, key. AI studio.</p>
    <div style="margin-top:34px">${wordmark(false)}</div>
  </div>
  <div style="position:absolute;right:56px;top:40px;display:grid;grid-template-columns:repeat(7,94px);grid-auto-rows:94px;gap:2px">
    ${JSON.parse(readFileSync(join(here, 'tools.json'), 'utf8'))
      .map(
        ([s, n]) => `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border-radius:14px;background:${C.soft}">
          <img src="${icon(s)}" style="width:46px;height:46px"><span style="font-size:10.5px;font-weight:600;color:${C.ink};text-align:center;line-height:1.15;padding:0 4px">${n}</span></div>`
      )
      .join('')}
  </div>
</body>`,
  },
  {
    file: '06-the-no-list',
    html: `
<body style="background:${glow('50%', '120%', 'rgba(56,224,143,.25)', 1200)},${C.tile}">
  <div style="position:absolute;left:0;right:0;top:70px;text-align:center">${'<div style="display:inline-block">' + wordmark(true) + '</div>'}</div>
  <div style="position:absolute;left:0;right:0;top:170px;display:flex;flex-direction:column;align-items:center;gap:2px">
    ${['No signup.', 'No upload.', 'No watermark.', 'No ads.', 'No limits.']
      .map((t) => `<div style="font-size:66px;font-weight:650;letter-spacing:-0.035em;line-height:1.12;color:#fff">${t}</div>`)
      .join('')}
  </div>
  <div style="position:absolute;left:0;right:0;bottom:62px;text-align:center">
    <span class="chip" style="font-size:22px;padding:12px 26px;background:${C.bright};color:${C.tileDeep}">Free. All 49 tools. ihateaudio.com</span>
  </div>
</body>`,
  },
  {
    file: '07-agents',
    html: `
<body style="background:${glow('100%', '0%', 'rgba(56,224,143,.18)', 900)},#fff">
  <span class="chip" style="position:absolute;left:72px;top:60px;background:${C.soft};color:${C.brand}">For AI agents</span>
  <h1 style="position:absolute;left:72px;top:118px;font-size:62px;color:${C.ink};width:1100px">Your AI agent can use the tools too.</h1>
  <p class="sub" style="position:absolute;left:74px;top:204px;color:${C.ink2};width:1000px">ihateaudio has an MCP server. Add it to ChatGPT and ask for the result you want.</p>
  <div style="position:absolute;left:72px;top:300px;width:1126px;height:330px;border-radius:18px;background:${C.stage};padding:34px 40px;font-family:ui-monospace,Menlo,monospace;font-size:21px;line-height:1.7;color:#cfe3d9">
    <div><span style="color:${C.amber}">MCP server</span>  https://ihateaudio.com/mcp</div>
    <div style="margin-top:22px;color:#fff">› Make this voice note podcast-ready.</div>
    <div style="margin-top:14px"><span style="color:${C.bright}">●</span> audio_trimmer      <span style="color:rgba(207,227,217,.55)">{ startSec, endSec }</span></div>
    <div><span style="color:${C.bright}">●</span> silence_remover    <span style="color:rgba(207,227,217,.55)">{ threshold, minimumGapSec }</span></div>
    <div><span style="color:${C.bright}">●</span> audio_normalizer   <span style="color:rgba(207,227,217,.55)">{ platform: "podcast" }</span></div>
    <div style="margin-top:14px;color:rgba(207,227,217,.55)">+ vocal_remover · audio_transcriber · slowed_reverb · bpm_detector · …</div>
  </div>
</body>`,
  },
];

const browser = await chromium.launch();
const out = join(assets, 'gallery');
mkdirSync(out, { recursive: true });

async function render(file, html, width, height, scale = 2) {
  const path = join(work, `${file}.html`);
  writeFileSync(path, `<!doctype html><html><head><meta charset="utf-8"><style>${BASE_CSS}html,body{width:${width}px;height:${height}px}</style></head>${html}</html>`);
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await page.goto(url(path), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
  const target = join(out, `${file}.png`);
  await page.screenshot({ path: target });
  await page.close();
  return target;
}

for (const slide of SLIDES) {
  const big = await render(slide.file, slide.html, 1270, 760);
  // Product Hunt's own size, as a light JPEG, for upload forms with a size cap.
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', big, '-vf', 'scale=1270:760:flags=lanczos', '-q:v', '2', join(out, `${slide.file}.jpg`)]);
  console.log(slide.file);
}

// ---- Thumbnail: the mark, static and with its bars moving. ----
const thumbDir = join(assets, 'thumbnail');
mkdirSync(thumbDir, { recursive: true });
const thumbHtml = (t) => {
  const bars = [
    [4, 12, 8],
    [9, 8, 16],
    [14, 1, 30],
    [19, 9, 14],
    [24, 12, 8],
  ];
  const rects = bars
    .map(([x, y, h], i) => {
      if (t === null) return `<rect x="${x}" y="${y}" width="3" height="${h}" rx="1.5"/>`;
      const k = 0.55 + 0.45 * Math.abs(Math.sin(t * Math.PI * 2 + i * 1.3));
      const nh = Math.max(4, Math.min(30, h * k * (i === 2 ? 1 : 1.25)));
      return `<rect x="${x}" y="${16 - nh / 2}" width="3" height="${nh}" rx="1.5"/>`;
    })
    .join('');
  return `<body style="background:${C.tile};display:flex;align-items:center;justify-content:center">
    <svg viewBox="0 0 32 32" style="width:180px;height:180px"><g fill="${C.bright}">${rects}</g></svg></body>`;
};
async function renderThumb(file, html, size) {
  const path = join(work, `${file}.html`);
  writeFileSync(path, `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0}html,body{width:240px;height:240px;overflow:hidden}</style></head>${html}</html>`);
  const page = await browser.newPage({ viewport: { width: 240, height: 240 }, deviceScaleFactor: size / 240 });
  await page.goto(url(path));
  const target = join(thumbDir, `${file}.png`);
  await page.screenshot({ path: target });
  await page.close();
  return target;
}
await renderThumb('thumbnail-240', thumbHtml(null), 240);
await renderThumb('logo-512', thumbHtml(null), 512);
await renderThumb('logo-1024', thumbHtml(null), 1024);
const frames = join(work, 'frames');
rmSync(frames, { recursive: true, force: true });
mkdirSync(frames, { recursive: true });
const FRAMES = 24;
for (let i = 0; i < FRAMES; i += 1) {
  const path = join(work, 'thumb-frame.html');
  writeFileSync(path, `<!doctype html><html><head><meta charset="utf-8"><style>*{margin:0}html,body{width:240px;height:240px;overflow:hidden}</style></head>${thumbHtml(i / FRAMES)}</html>`);
  const page = await browser.newPage({ viewport: { width: 240, height: 240 } });
  await page.goto(url(path));
  await page.screenshot({ path: join(frames, `f${String(i).padStart(3, '0')}.png`) });
  await page.close();
}
execFileSync('ffmpeg', [
  '-y', '-loglevel', 'error', '-framerate', '12', '-i', join(frames, 'f%03d.png'),
  '-vf', 'split[a][b];[a]palettegen=max_colors=32[p];[b][p]paletteuse=dither=none',
  '-loop', '0', join(thumbDir, 'thumbnail-240.gif'),
]);
console.log('thumbnail');

await browser.close();
