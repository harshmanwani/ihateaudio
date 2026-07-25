/**
 * SEO audit over the built output.
 *
 * Reads dist/ rather than the source, because what ships is what gets crawled.
 * Reports rather than fixes: every finding is something a human should decide
 * about.
 *
 *   npm run build && node scripts/seo-audit.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

if (!existsSync(dist)) {
  console.error('No dist/. Run `npm run build` first.');
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry === 'index.html') out.push(full);
  }
  return out;
}

const pages = walk(dist).sort();
const findings = [];
const add = (severity, page, issue) => findings.push({ severity, page, issue });

const pick = (html, re) => {
  const m = html.match(re);
  return m ? m[1] : null;
};
const all = (html, re) => [...html.matchAll(re)].map((m) => m[1]);

const titles = new Map();
const descriptions = new Map();
const h1s = new Map();

for (const file of pages) {
  const html = readFileSync(file, 'utf8');
  const url =
    '/' + relative(dist, file).replace(/index\.html$/, '').replace(/\/$/, '');
  const page = url === '/' ? '/' : url;

  // --- title ---
  const title = pick(html, /<title[^>]*>([^<]*)<\/title>/);
  if (!title) add('error', page, 'no <title>');
  else {
    if (title.length > 60) {
      add('warn', page, `title is ${title.length} chars, Google truncates near 60`);
    }
    if (title.length < 20) add('warn', page, `title is only ${title.length} chars`);
    if (titles.has(title)) {
      add('error', page, `duplicate title, also on ${titles.get(title)}`);
    } else titles.set(title, page);
  }

  // --- description ---
  const desc = pick(html, /<meta name="description" content="([^"]*)"/);
  if (!desc) add('error', page, 'no meta description');
  else {
    if (desc.length > 160) {
      add('warn', page, `description is ${desc.length} chars, truncates near 160`);
    }
    if (desc.length < 70) add('warn', page, `description is only ${desc.length} chars`);
    if (descriptions.has(desc)) {
      add('error', page, `duplicate description, also on ${descriptions.get(desc)}`);
    } else descriptions.set(desc, page);
  }

  // --- headings ---
  const heads = all(html, /<h1[^>]*>([\s\S]*?)<\/h1>/g);
  if (heads.length === 0) add('error', page, 'no <h1>');
  if (heads.length > 1) add('error', page, `${heads.length} <h1> elements`);
  const h1 = (heads[0] ?? '').replace(/<[^>]*>/g, '').trim();
  if (h1) {
    if (h1s.has(h1)) add('warn', page, `duplicate h1, also on ${h1s.get(h1)}`);
    else h1s.set(h1, page);
  }

  // --- canonical ---
  const canonical = pick(html, /<link rel="canonical" href="([^"]*)"/);
  if (!canonical) add('error', page, 'no canonical');
  else if (!canonical.startsWith('https://')) {
    add('error', page, 'canonical is not absolute');
  }

  // --- social ---
  const ogImage = pick(html, /<meta property="og:image" content="([^"]*)"/);
  if (!ogImage) add('error', page, 'no og:image');
  const ogType = pick(html, /<meta property="og:type" content="([^"]*)"/);
  if (!ogType) add('warn', page, 'no og:type');
  if (!/twitter:card/.test(html)) add('warn', page, 'no twitter:card');
  if (!/<meta property="og:image:width"/.test(html)) {
    add('warn', page, 'og:image has no declared dimensions');
  }
  if (!/<meta property="og:image:alt"/.test(html)) {
    add('warn', page, 'og:image has no alt text');
  }

  // --- structured data ---
  const blocks = all(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  if (blocks.length === 0) add('error', page, 'no JSON-LD');
  const types = [];
  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block);
      types.push(parsed['@type']);
    } catch {
      add('error', page, 'JSON-LD does not parse');
    }
  }
  if (!types.includes('BreadcrumbList') && page !== '/') {
    add('warn', page, 'no BreadcrumbList');
  }

  // --- images ---
  const imgs = [...html.matchAll(/<img\b([^>]*)>/g)].map((m) => m[1]);
  for (const attrs of imgs) {
    if (!/\balt=/.test(attrs)) add('error', page, 'an <img> has no alt attribute');
    if (!/\bwidth=/.test(attrs) || !/\bheight=/.test(attrs)) {
      add('warn', page, 'an <img> has no width/height, risks layout shift');
    }
  }

  // --- language / viewport ---
  if (!/<html[^>]+lang=/.test(html)) add('error', page, 'no lang on <html>');
  if (!/name="viewport"/.test(html)) add('error', page, 'no viewport meta');

  // --- content depth ---
  const text = html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ');
  const words = text.trim().split(' ').filter(Boolean).length;
  if (words < 350) add('warn', page, `only ~${words} words of content`);

  // --- internal links ---
  const links = all(html, /<a\b[^>]*href="(\/[^"#]*)"/g);
  if (new Set(links).size < 5) {
    add('warn', page, `only ${new Set(links).size} internal links`);
  }
}

// --- sitewide files ---
for (const f of ['sitemap.xml', 'robots.txt', 'og.png', 'manifest.webmanifest']) {
  if (!existsSync(join(dist, f))) add('error', '(site)', `missing ${f}`);
}
if (!existsSync(join(dist, 'llms.txt'))) {
  add('warn', '(site)', 'no llms.txt for LLM and agent discovery');
}
if (existsSync(join(dist, 'robots.txt'))) {
  const robots = readFileSync(join(dist, 'robots.txt'), 'utf8');
  for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended']) {
    if (!robots.includes(bot)) {
      add('warn', '(site)', `robots.txt has no explicit policy for ${bot}`);
    }
  }
}

// --- report ---
const order = { error: 0, warn: 1 };
findings.sort((a, b) => order[a.severity] - order[b.severity] || a.page.localeCompare(b.page));

const errors = findings.filter((f) => f.severity === 'error');
const warns = findings.filter((f) => f.severity === 'warn');

console.log(`\nAudited ${pages.length} pages.\n`);
console.log(`  ${errors.length} error(s), ${warns.length} warning(s)\n`);

const grouped = new Map();
for (const f of findings) {
  const key = `${f.severity}: ${f.issue.replace(/\d+/g, 'N').replace(/, also on .*/, '')}`;
  grouped.set(key, (grouped.get(key) ?? 0) + 1);
}
for (const [issue, count] of [...grouped].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}x  ${issue}`);
}

if (errors.length) {
  console.log('\nErrors in detail:');
  for (const f of errors.slice(0, 40)) console.log(`  ${f.page}: ${f.issue}`);
}

console.log('');
process.exit(errors.length > 0 ? 1 : 0);
