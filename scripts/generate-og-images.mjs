/**
 * Renders a distinct social card for every page.
 *
 * One shared og.png across 44 pages means every share of every tool looks
 * identical, which wastes the single most visible surface a link has. Each card
 * here carries its own tool name, its own summary and its own icon, so a shared
 * link to the ringtone maker looks like the ringtone maker.
 *
 * Reads dist/tools.json, so the registry stays the single source of truth.
 *
 *   npm run build && node scripts/generate-og-images.mjs
 */
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'public', 'og');
const dist = join(root, 'dist');
mkdirSync(out, { recursive: true });

const registryPath = join(dist, 'tools.json');
if (!existsSync(registryPath)) {
  console.error('dist/tools.json missing. Run `npm run build` first.');
  process.exit(1);
}
const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

// Same hues as --cat-* in tokens.css, resolved to sRGB for the standalone page.
const CAT = {
  cut: ['#1f6b52', '#e8f5ef'],
  convert: ['#1f5a8f', '#e8f0f8'],
  volume: ['#8a5a13', '#faf0e0'],
  speed: ['#6b3f8f', '#f2ebf8'],
  effects: ['#8f2f5e', '#faeaf1'],
  utility: ['#1f5f7a', '#e8f2f7'],
};

const iconSvg = (name) => {
  try {
    const file = require.resolve(
      `@phosphor-icons/core/assets/duotone/${name}-duotone.svg`
    );
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const fontPath = join(root, 'public', 'fonts', 'instrument-sans-latin.woff2');

/** Deterministic bar heights: Math.random would rewrite every card each run. */
function bars(count, seed) {
  const heights = [];
  let value = seed;
  for (let i = 0; i < count; i += 1) {
    value = (value * 1103515245 + 12345) % 2147483648;
    const norm = value / 2147483648;
    const envelope = Math.sin((i / count) * Math.PI) * 0.65 + 0.35;
    heights.push(Math.max(0.1, norm * envelope));
  }
  return heights;
}

function card({ eyebrow, title, summary, art, accent, soft, seed }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face{font-family:'Instrument Sans';src:url('file://${fontPath}') format('woff2-variations');font-weight:400 700}
  *{margin:0;box-sizing:border-box}
  body{width:1200px;height:630px;background:#fff;font-family:'Instrument Sans',system-ui,sans-serif;
       color:#141d19;display:flex;flex-direction:column;justify-content:space-between;padding:64px 68px;position:relative;overflow:hidden}
  .top{display:flex;align-items:center;justify-content:space-between;gap:24px}
  .mark{display:flex;align-items:center;gap:11px;font-size:25px;font-weight:700;letter-spacing:-.02em}
  .mark em{font-style:normal;color:#1c4437}
  .eyebrow{font-size:19px;font-weight:600;color:${accent};background:${soft};
           padding:8px 16px;border-radius:999px;white-space:nowrap}
  .body{display:flex;align-items:center;gap:52px}
  .text{flex:1;min-width:0}
  h1{font-size:${title.length > 26 ? 62 : 74}px;font-weight:700;letter-spacing:-.03em;line-height:1.03}
  p{font-size:28px;color:#5c6862;margin-top:20px;line-height:1.35;max-width:22ch}
  .art{width:224px;height:224px;flex:none;display:flex;align-items:center;justify-content:center;
       background:${soft};border-radius:34px}
  .art img{width:196px;height:196px;filter:drop-shadow(0 8px 14px rgba(20,29,25,.18))}
  .art svg{width:132px;height:132px;color:${accent}}
  .stage{height:96px;background:#121a16;border-radius:16px;display:flex;align-items:center;
         gap:5px;padding:0 26px;overflow:hidden}
  .stage i{flex:1;background:#7fd3ae;border-radius:3px;display:block}
  </style></head><body>
    <div class="top">
      <div class="mark">
        <svg width="30" height="30" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#1c4437"/>
          <g fill="#7fd3ae"><rect x="6" y="14" width="2.6" height="4" rx="1.3"/><rect x="10.7" y="9" width="2.6" height="14" rx="1.3"/>
          <rect x="15.4" y="5" width="2.6" height="22" rx="1.3"/><rect x="20.1" y="11" width="2.6" height="10" rx="1.3"/>
          <rect x="24.8" y="14" width="2.6" height="4" rx="1.3"/></g></svg>
        <span>i<em>hate</em>audio</span>
      </div>
      <div class="eyebrow">${eyebrow}</div>
    </div>
    <div class="body">
      <div class="text"><h1>${title}</h1><p>${summary}</p></div>
      <div class="art">${art}</div>
    </div>
    <div class="stage">${bars(76, seed).map((h) => `<i style="height:${(h * 100).toFixed(1)}%"></i>`).join('')}</div>
  </body></html>`;
}

const escape = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const seedOf = (s) => {
  let h = 17;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 2147483647;
  return h;
};

const jobs = [];

// Homepage.
jobs.push({
  file: 'home.png',
  eyebrow: `${registry.tools.length} free tools`,
  title: 'Audio editing is miserable. We make it less so.',
  summary: 'Runs in your browser. Nothing uploaded, no signup.',
  art: `<svg viewBox="0 0 256 256" fill="currentColor"><path d="M56,96v64a8,8,0,0,1-16,0V96a8,8,0,0,1,16,0ZM88,24a8,8,0,0,0-8,8V224a8,8,0,0,0,16,0V32A8,8,0,0,0,88,24Zm40,32a8,8,0,0,0-8,8V192a8,8,0,0,0,16,0V64A8,8,0,0,0,128,56Zm40,32a8,8,0,0,0-8,8v64a8,8,0,0,0,16,0V96A8,8,0,0,0,168,88Zm40-16a8,8,0,0,0-8,8v96a8,8,0,0,0,16,0V80A8,8,0,0,0,208,72Z"/></svg>`,
  accent: '#1c4437',
  soft: '#e8f5ef',
  seed: seedOf('home'),
});

// Every tool.
for (const tool of registry.tools) {
  const [accent, soft] = CAT[tool.category] ?? CAT.cut;
  const local3d = join(root, 'public', 'icons3d', `${tool.slug}.png`);
  // Inlined as a data URI: Chromium refuses file:// images on a setContent
  // page, so a plain src silently renders a broken-image box.
  const art = existsSync(local3d)
    ? `<img src="data:image/png;base64,${readFileSync(local3d).toString('base64')}" alt="">`
    : iconSvg(registryIcon(tool.slug));

  jobs.push({
    file: `${tool.slug}.png`,
    eyebrow:
      registry.categories.find((c) => c.id === tool.category)?.name ?? 'Tool',
    title: escape(tool.name),
    summary: escape(tool.summary),
    art,
    accent,
    soft,
    seed: seedOf(tool.slug),
  });
}

// Reference pages get their own cards too, since they are the link magnets.
for (const page of [
  {
    slug: 'loudness-targets',
    title: 'Loudness targets by platform',
    summary: 'Every LUFS and true peak target in one table.',
    icon: 'gauge',
    cat: 'volume',
  },
  {
    slug: 'audio-formats',
    title: 'Which audio format should you use?',
    summary: 'MP3, AAC, Opus, FLAC and WAV compared honestly.',
    icon: 'swap',
    cat: 'convert',
  },
]) {
  const [accent, soft] = CAT[page.cat];
  jobs.push({
    file: `${page.slug}.png`,
    eyebrow: 'Reference',
    title: page.title,
    summary: page.summary,
    art: iconSvg(page.icon),
    accent,
    soft,
    seed: seedOf(page.slug),
  });
}

/** The registry JSON does not carry the icon name, so read it from source. */
function registryIcon(slug) {
  const src = readFileSync(join(root, 'src', 'data', 'tools.ts'), 'utf8');
  const block = new RegExp(`slug: '${slug}',[\\s\\S]*?icon: '([a-z-]+)'`).exec(src);
  return block ? block[1] : 'waveform';
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });

let made = 0;
for (const job of jobs) {
  await page.setContent(card(job), { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(out, job.file) });
  made += 1;
  if (made % 10 === 0) process.stdout.write(`${made} `);
}

await browser.close();
console.log(`\n${made} social cards written to public/og`);
