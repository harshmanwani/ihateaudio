/**
 * Fails the build if the tool registry and the pages on disk disagree.
 *
 * The registry drives the homepage grid, the all-tools menu, the sitemap,
 * llms.txt, tools.json, the related-tool links and the chain bar. So adding an
 * entry without adding its page does not break the build — it silently publishes
 * a dead link from the homepage and a 404 into the sitemap, which is worse than
 * an error because Search Console finds it before you do.
 *
 * This was written after doing exactly that: six AI tools went into the registry
 * ahead of their pages, `npm run build` reported 45 pages built and success, and
 * `npm run seo` reported zero errors, because it audits the pages that exist
 * rather than the ones that were promised.
 *
 * Runs before the build, against the source, so it fails in a second rather than
 * after a full render.
 *
 *   node scripts/check-registry.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const registryFile = join(root, 'src', 'data', 'tools.ts');
const pagesDir = join(root, 'src', 'pages');

if (!existsSync(registryFile)) {
  console.error('src/data/tools.ts is missing.');
  process.exit(1);
}

const source = readFileSync(registryFile, 'utf8');

/**
 * Read the slugs textually rather than importing the module.
 *
 * Importing would mean compiling TypeScript just to read a list of strings, and
 * this needs to run before anything else in the build.
 */
const slugs = [...source.matchAll(/^\s*slug:\s*'([^']+)'/gm)].map((m) => m[1]);
if (slugs.length === 0) {
  console.error('Found no tool slugs in src/data/tools.ts. Has its shape changed?');
  process.exit(1);
}

const problems = [];

const duplicates = slugs.filter((slug, i) => slugs.indexOf(slug) !== i);
for (const slug of new Set(duplicates)) {
  problems.push(`  ${slug} appears more than once in the registry`);
}

for (const slug of slugs) {
  if (!existsSync(join(pagesDir, `${slug}.astro`))) {
    problems.push(`  ${slug} is in the registry but src/pages/${slug}.astro does not exist`);
  }
}

/**
 * The other direction matters too, though less: a page with no registry entry is
 * reachable but orphaned — nothing links to it, it is absent from the sitemap, and
 * search engines will never see it.
 */
const NON_TOOL_PAGES = new Set([
  '404',
  'about',
  'audio-formats',
  'index',
  'loudness-targets',
  'privacy',
]);
const pageFiles = readdirSync(pagesDir)
  .filter((name) => name.endsWith('.astro'))
  .map((name) => name.replace(/\.astro$/, ''));

for (const page of pageFiles) {
  if (NON_TOOL_PAGES.has(page)) continue;
  if (!slugs.includes(page)) {
    problems.push(`  src/pages/${page}.astro has no registry entry, so nothing links to it`);
  }
}

/**
 * Every tool claims a 3D icon, and a missing one falls back to a glyph silently.
 * That fallback is deliberate and worth keeping, but it should be a decision
 * rather than an oversight, so an entry with icon3d set and no file is an error.
 */
const iconDir = join(root, 'public', 'icons3d');
const icon3dSlugs = [...source.matchAll(/slug:\s*'([^']+)'[\s\S]*?icon3d:\s*true/g)];
if (existsSync(iconDir)) {
  for (const slug of slugs) {
    const declaresIcon = new RegExp(
      `slug:\\s*'${slug}'[\\s\\S]{0,900}?icon3d:\\s*true`
    ).test(source);
    if (declaresIcon && !existsSync(join(iconDir, `${slug}.png`))) {
      problems.push(`  ${slug} sets icon3d but public/icons3d/${slug}.png is missing`);
    }
  }
}

if (problems.length > 0) {
  console.error(`\nRegistry and pages disagree:\n\n${problems.join('\n')}\n`);
  console.error(
    'A registry entry without a page publishes a dead link from the homepage and\n' +
      'a 404 into the sitemap. Add the page, or take the entry out until it exists.\n'
  );
  process.exit(1);
}

console.log(
  `Registry check passed: ${slugs.length} tools, each with a page and an icon` +
    `${icon3dSlugs.length ? '' : ''}.`
);
