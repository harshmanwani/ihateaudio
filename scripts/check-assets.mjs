/**
 * Fails the build if dist/ contains an asset Cloudflare will refuse to upload.
 *
 * Cloudflare Workers caps a single static asset at 25 MiB, and going over it does not
 * degrade anything — it aborts the whole deploy with one line about one file. This
 * project has three binaries that are individually larger than that: the ffmpeg core
 * at 31 MB and two separation models at 64 MB and 28 MB. All of them are served from
 * R2 by worker/ instead, and all of them also live under public/ so that `astro dev`
 * and the verification harness can serve them locally.
 *
 * Which means Astro copies them into dist/ on every build, and the only thing keeping
 * the deploy alive is public/.assetsignore. That file is generated, easy to forget,
 * and its absence is invisible until a deploy fails several minutes in — which is
 * exactly what happened when the models were added.
 *
 * So the check runs at build time instead: the same rule wrangler applies, applied
 * where it is cheap to fix.
 *
 *   node scripts/check-assets.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

/** Cloudflare's per-asset ceiling. */
const LIMIT = 25 * 1024 * 1024;

if (!existsSync(dist)) {
  console.error('dist/ missing. Run the build first.');
  process.exit(1);
}

/**
 * Prefixes wrangler will skip, read from the file it actually reads.
 *
 * Parsed rather than hardcoded, so this cannot drift from the real thing — the whole
 * point is to check the rule as it will be applied, not as it was once written down.
 */
const ignoreFile = join(dist, '.assetsignore');
const ignored = existsSync(ignoreFile)
  ? readFileSync(ignoreFile, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  : [];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const offenders = [];
let ignoredCount = 0;

for (const file of walk(dist)) {
  const rel = relative(dist, file).split(/[\\/]/).join('/');
  const skipped = ignored.some((prefix) =>
    prefix.endsWith('/') ? rel.startsWith(prefix) : rel === prefix
  );
  if (skipped) {
    ignoredCount += 1;
    continue;
  }
  const size = statSync(file).size;
  if (size > LIMIT) offenders.push({ rel, size });
}

if (offenders.length > 0) {
  console.error(
    `\n${offenders.length} asset(s) exceed Cloudflare's ${LIMIT / 1048576} MiB limit ` +
      'and will abort the deploy:\n'
  );
  for (const { rel, size } of offenders.sort((a, b) => b.size - a.size)) {
    console.error(`  ${rel}  ${(size / 1048576).toFixed(1)} MB`);
  }
  console.error(
    '\nEither serve it from R2 through worker/index.ts and add its directory to\n' +
      'public/.assetsignore, or make it smaller. Do not raise the limit: it is\n' +
      "Cloudflare's, not ours.\n"
  );
  process.exit(1);
}

console.log(
  `Asset check passed: nothing over ${LIMIT / 1048576} MiB ` +
    `(${ignoredCount} file(s) served from R2 instead).`
);
