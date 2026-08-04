/**
 * Rasterizes the app icons and the iOS launch images from src/assets/logo.svg.
 *
 * One source of truth: the same file the header inlines and the favicon serves.
 *
 * Run by hand, with `npm run appicons`, and its output committed — it is not part
 * of the build. Rasterizing needs a real browser, and a Chromium launch on the
 * critical path of every deploy buys nothing here: the mark changes about never,
 * and every file below is a pure function of one SVG that is already in git.
 *
 * This comment used to claim the build ran it. It did not, and because the launch
 * images were also gitignored, a deploy from a clean checkout shipped a PWA with
 * no launch images and nothing anywhere said so. Both halves of that are fixed —
 * they are committed now — and scripts/check-assets.mjs fails the build if any of
 * them go missing again.
 *
 *   node scripts/generate-app-icons.mjs
 */
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');
const splashDir = join(pub, 'splash');
mkdirSync(splashDir, { recursive: true });

const logo = readFileSync(join(root, 'src', 'assets', 'logo.svg'), 'utf8');

// The favicon is a straight copy, so the served file can never drift from source.
writeFileSync(join(pub, 'favicon.svg'), logo);

const STAGE = '#0A110C';
const WAVE = '#31D685';
const fontPath = join(pub, 'fonts', 'instrument-sans-latin.woff2');

/**
 * `radius` is the corner rounding as a percentage, and `inset` the share of the
 * canvas left as padding.
 *
 * Maskable icons get a large inset because the platform crops them to whatever
 * shape it likes: anything outside the middle 80% can be cut off, so the mark
 * has to sit well inside that and the background has to run to the edge.
 */
function iconPage({ size, radius, inset, background }) {
  const markSize = Math.round(size * (1 - inset * 2));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0}
    body{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center;
         background:${background};border-radius:${radius}%;overflow:hidden}
    svg{width:${markSize}px;height:${markSize}px;display:block}
  </style></head><body>${
    // The mark's own rounded background is dropped when it sits on a filled
    // canvas, otherwise there are two rounded squares nested inside each other.
    background === 'transparent'
      ? logo
      : logo.replace(/<rect width="32" height="32"[^>]*>/, '')
  }</body></html>`;
}

/** iOS launch image: the mark and the wordmark, centred on the brand surface. */
function splashPage({ width, height }) {
  const scale = Math.min(width, height);
  const mark = Math.round(scale * 0.22);
  const type = Math.round(scale * 0.062);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @font-face{font-family:'Instrument Sans';src:url('file://${fontPath}') format('woff2-variations');font-weight:400 700}
    *{margin:0;padding:0;box-sizing:border-box}
    body{width:${width}px;height:${height}px;background:#fff;display:flex;flex-direction:column;
         align-items:center;justify-content:center;gap:${Math.round(scale * 0.05)}px;
         font-family:'Instrument Sans',system-ui,sans-serif}
    svg{width:${mark}px;height:${mark}px;display:block;border-radius:${Math.round(mark * 0.22)}px}
    .word{font-size:${type}px;font-weight:700;letter-spacing:-0.03em;color:#141d19}
    .word em{font-style:normal;color:${'#007038'}}
    .tag{font-size:${Math.round(type * 0.42)}px;color:#5c6862;margin-top:${Math.round(scale * -0.02)}px}
  </style></head><body>
    ${logo}
    <div class="word">i<em>hate</em>audio</div>
    <div class="tag">Audio tools that just work</div>
  </body></html>`;
}

const ICONS = [
  { file: 'icon-192.png', size: 192, radius: 22, inset: 0.14, background: STAGE },
  { file: 'icon-512.png', size: 512, radius: 22, inset: 0.14, background: STAGE },
  // Full bleed, mark well inside the safe circle.
  { file: 'icon-maskable-512.png', size: 512, radius: 0, inset: 0.26, background: STAGE },
  // Apple applies its own mask and rejects transparency, so this is square.
  { file: 'apple-touch-icon.png', size: 180, radius: 0, inset: 0.16, background: STAGE },
];

/**
 * Portrait launch images for the devices actually in use. iOS matches these by
 * exact pixel size, so there is no graceful fallback: a size that is missing
 * simply shows a white screen on launch.
 */
const SPLASH = [
  { width: 1290, height: 2796, device: [430, 932], ratio: 3 },
  { width: 1179, height: 2556, device: [393, 852], ratio: 3 },
  { width: 1284, height: 2778, device: [428, 926], ratio: 3 },
  { width: 1170, height: 2532, device: [390, 844], ratio: 3 },
  { width: 1242, height: 2688, device: [414, 896], ratio: 3 },
  { width: 1125, height: 2436, device: [375, 812], ratio: 3 },
  { width: 828, height: 1792, device: [414, 896], ratio: 2 },
  { width: 750, height: 1334, device: [375, 667], ratio: 2 },
  { width: 1536, height: 2048, device: [768, 1024], ratio: 2 },
  { width: 1668, height: 2388, device: [834, 1194], ratio: 2 },
  { width: 2048, height: 2732, device: [1024, 1366], ratio: 2 },
];

const browser = await chromium.launch();

for (const icon of ICONS) {
  const page = await browser.newPage({
    viewport: { width: icon.size, height: icon.size },
  });
  await page.setContent(iconPage(icon), { waitUntil: 'load' });
  await page.screenshot({
    path: join(pub, icon.file),
    omitBackground: icon.background === 'transparent',
  });
  await page.close();
  console.log(`icon  ${icon.file} (${icon.size}px)`);
}

for (const shot of SPLASH) {
  const page = await browser.newPage({
    viewport: { width: shot.width, height: shot.height },
  });
  await page.setContent(splashPage(shot), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(splashDir, `${shot.width}x${shot.height}.png`) });
  await page.close();
  console.log(`splash ${shot.width}x${shot.height}`);
}

await browser.close();

// The <link> set is generated rather than hand-written: eleven media queries
// that have to match the filenames exactly is not something to maintain by eye.
const links = SPLASH.map(
  (s) =>
    `<link rel="apple-touch-startup-image" href="/splash/${s.width}x${s.height}.png" ` +
    `media="(device-width: ${s.device[0]}px) and (device-height: ${s.device[1]}px) ` +
    `and (-webkit-device-pixel-ratio: ${s.ratio}) and (orientation: portrait)" />`
).join('\n');

writeFileSync(join(root, 'src', 'assets', 'splash-links.html'), `${links}\n`);
console.log(`\n${ICONS.length} icons, ${SPLASH.length} launch images, splash-links.html`);
console.log(`wave ${WAVE} on ${STAGE}`);
