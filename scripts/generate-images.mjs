/**
 * Renders the social card and app icons with Playwright.
 *
 * Keeping these generated rather than checked in means the brand colours live
 * in exactly one place — change a token and re-run this.
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public');
mkdirSync(out, { recursive: true });

const BRAND = '#1c4437';
const WAVE = '#7fd3ae';
const INK = '#141d19';

/** Deterministic bar heights — Math.random would change the card every build. */
function bars(count, seed = 7) {
  const heights = [];
  let value = seed;
  for (let i = 0; i < count; i += 1) {
    value = (value * 1103515245 + 12345) % 2147483648;
    const norm = value / 2147483648;
    // Envelope so the shape reads as audio rather than noise.
    const envelope = Math.sin((i / count) * Math.PI) * 0.7 + 0.3;
    heights.push(Math.max(0.08, norm * envelope));
  }
  return heights;
}

const ogHtml = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @font-face {
    font-family: 'Instrument Sans';
    src: url('file://${join(out, 'fonts/instrument-sans-latin.woff2')}') format('woff2-variations');
    font-weight: 400 700;
  }
  * { margin: 0; box-sizing: border-box; }
  body {
    width: 1200px; height: 630px; background: #fff;
    font-family: 'Instrument Sans', system-ui, sans-serif; color: ${INK};
    display: flex; flex-direction: column; justify-content: space-between;
    padding: 72px 76px;
  }
  .mark { display: flex; align-items: center; gap: 14px; }
  .mark svg { display: block; }
  .mark span { font-size: 30px; font-weight: 700; letter-spacing: -0.02em; }
  .mark em { font-style: normal; color: ${BRAND}; }
  h1 { font-size: 76px; font-weight: 700; letter-spacing: -0.03em; line-height: 1.04; max-width: 17ch; }
  p { font-size: 27px; color: #5c6862; margin-top: 22px; max-width: 30ch; line-height: 1.4; }
  .stage {
    height: 132px; background: #121a16; border-radius: 14px;
    display: flex; align-items: center; gap: 4px; padding: 0 22px; overflow: hidden;
  }
  .stage i { flex: 1; background: ${WAVE}; border-radius: 3px; display: block; }
</style></head><body>
  <div class="mark">
    <svg width="34" height="34" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${BRAND}"/>
      <g fill="${WAVE}">
        <rect x="6" y="14" width="2.6" height="4" rx="1.3"/><rect x="10.7" y="9" width="2.6" height="14" rx="1.3"/>
        <rect x="15.4" y="5" width="2.6" height="22" rx="1.3"/><rect x="20.1" y="11" width="2.6" height="10" rx="1.3"/>
        <rect x="24.8" y="14" width="2.6" height="4" rx="1.3"/>
      </g></svg>
    <span>i<em>hate</em>audio</span>
  </div>
  <div>
    <h1>Audio editing is miserable. These make it less so.</h1>
    <p>39 free tools that run in your browser. Nothing uploaded, no account, no ads.</p>
  </div>
  <div class="stage">
    ${bars(92).map((h) => `<i style="height:${(h * 100).toFixed(1)}%"></i>`).join('')}
  </div>
</body></html>`;

const iconHtml = (size) => `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; }
  body { width: ${size}px; height: ${size}px; }
  svg { display: block; }
</style></head><body>
  <svg width="${size}" height="${size}" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
    <rect width="32" height="32" rx="7" fill="${BRAND}"/>
    <g fill="${WAVE}">
      <rect x="6" y="14" width="2.6" height="4" rx="1.3"/><rect x="10.7" y="9" width="2.6" height="14" rx="1.3"/>
      <rect x="15.4" y="5" width="2.6" height="22" rx="1.3"/><rect x="20.1" y="11" width="2.6" height="10" rx="1.3"/>
      <rect x="24.8" y="14" width="2.6" height="4" rx="1.3"/>
    </g>
  </svg>
</body></html>`;

const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(ogHtml, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(out, 'og.png') });
  console.log('[images] og.png');

  for (const size of [180, 192, 512]) {
    const iconPage = await browser.newPage({ viewport: { width: size, height: size } });
    await iconPage.setContent(iconHtml(size), { waitUntil: 'load' });
    const name = size === 180 ? 'apple-touch-icon.png' : `icon-${size}.png`;
    await iconPage.screenshot({ path: join(out, name), omitBackground: true });
    await iconPage.close();
    console.log(`[images] ${name}`);
  }
} finally {
  await browser.close();
}
