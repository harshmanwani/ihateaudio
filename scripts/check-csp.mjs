/**
 * Fails the build if the shipped HTML contains a script the shipped CSP forbids.
 *
 * This guards a failure that is invisible in development and silent in
 * production. `astro dev` does not apply public/_headers, so the Content
 * Security Policy is not enforced locally; Astro inlines small hoisted scripts
 * by default; and `script-src` here deliberately has no 'unsafe-inline'. The
 * result was four blocked scripts on the live site, which killed the dropzone's
 * "Choose file" button and the service worker registration without a single
 * visible error anywhere in the normal workflow.
 *
 * Cheap to run, and it reads the two files that actually ship rather than
 * trusting a config.
 *
 *   node scripts/check-csp.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const headersFile = join(root, 'public', '_headers');

if (!existsSync(dist)) {
  console.error('dist/ missing. Run the build first.');
  process.exit(1);
}
if (!existsSync(headersFile)) {
  console.error('public/_headers missing, so nothing can be checked.');
  process.exit(1);
}

const csp =
  readFileSync(headersFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().startsWith('content-security-policy:')) ?? '';

const scriptSrc =
  csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('script-src')) ?? '';

const allowsInline = scriptSrc.includes("'unsafe-inline'");

/** Every .html file under dist. */
function pages(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...pages(full));
    else if (entry.endsWith('.html')) out.push(full);
  }
  return out;
}

/**
 * Inline scripts that would actually execute.
 *
 * A `type` the browser does not treat as JavaScript is data, not code, so
 * `application/ld+json` is exempt: it is how the structured data ships and no
 * browser evaluates it.
 */
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const DATA_TYPES = /type\s*=\s*["']?(application\/ld\+json|application\/json|text\/template)/i;

const offenders = [];

for (const file of pages(dist)) {
  const html = readFileSync(file, 'utf8');
  for (const match of html.matchAll(SCRIPT)) {
    const attrs = match[1] ?? '';
    const body = (match[2] ?? '').trim();
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (DATA_TYPES.test(attrs)) continue;
    if (body.length === 0) continue;
    offenders.push({
      page: file.replace(`${dist}/`, ''),
      head: body.replace(/\s+/g, ' ').slice(0, 90),
    });
  }
}

if (!allowsInline && offenders.length > 0) {
  console.error(
    `\n${offenders.length} inline script(s) will be blocked by the shipped CSP.\n`
  );
  console.error(`script-src is: ${scriptSrc}\n`);
  const seen = new Set();
  for (const o of offenders) {
    if (seen.has(o.head)) continue;
    seen.add(o.head);
    console.error(`  ${o.page}\n    ${o.head}\n`);
  }
  console.error(
    'Either set vite.build.assetsInlineLimit to 0 so Astro emits them as\n' +
      'files, or move the code into a real module. Do not add\n' +
      "'unsafe-inline' to script-src: the whole reason /analytics.js is an\n" +
      'external file is to avoid needing it.\n'
  );
  process.exit(1);
}

const pageCount = pages(dist).length;
if (allowsInline) {
  console.log(
    `CSP allows inline scripts, so nothing to enforce (${pageCount} pages).`
  );
} else {
  console.log(`CSP check passed: no inline scripts across ${pageCount} pages.`);
}
