/**
 * Fails the build if dist/ contains an asset Cloudflare will refuse to upload,
 * or is missing one the site cannot run without.
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
 * The opposite failure is quieter and turned out to be worse. public/lib/ and
 * public/ort/ hold the Whisper and separation runtimes, both are gitignored, and
 * both are regenerated from node_modules by scripts. When those scripts do not
 * run, nothing complains — Astro has no opinion about a directory that is not
 * there — and what deploys is a site whose transcriber 404s on its own runtime.
 * That is exactly how it shipped: every file came back "Something went wrong
 * processing that file", because the worker's dynamic import of transformers.js
 * fetched the HTML 404 page and threw. So presence is checked here too.
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

const isIgnored = (rel) =>
  ignored.some((prefix) => (prefix.endsWith('/') ? rel.startsWith(prefix) : rel === prefix));

/**
 * Reads a generated version constant out of the module the app imports it from.
 *
 * Parsed rather than restated here for the same reason .assetsignore is parsed:
 * a check that keeps its own copy of the thing it checks stops checking it the
 * first time the two disagree. These constants are written by the same scripts
 * that populate the directories, so reading them means a version bump with no
 * re-sync is caught as a missing file rather than sailing through.
 */
function constantFrom(file, name) {
  const source = readFileSync(join(root, 'src', 'lib', 'ai', file), 'utf8');
  const match = source.match(new RegExp(`export const ${name} = '([^']+)'`));
  if (!match) {
    console.error(`Could not read ${name} from src/lib/ai/${file}.`);
    process.exit(1);
  }
  return match[1];
}

const transformersVersion = constantFrom('transformers-version.ts', 'TRANSFORMERS_VERSION');
const ortVersion = constantFrom('ort-version.ts', 'ORT_VERSION');

/**
 * The iOS launch images, read from the generated markup that references them.
 *
 * Listing them here by hand would be a second copy of a list that already exists
 * in two places — the SPLASH table in generate-app-icons.mjs and the links it
 * writes — and the copy that goes stale is always the one nobody looks at. The
 * links file is the right source because it is what the pages actually ship: if a
 * <link> points at it, it has to be there.
 */
const splashLinks = readFileSync(join(root, 'src', 'assets', 'splash-links.html'), 'utf8');
const splash = [...splashLinks.matchAll(/href="\/([^"]+)"/g)].map((match) => match[1]);

/**
 * Files something fetches at runtime, whose absence is invisible until it is not.
 *
 * Each carries the command that puts it back, because the two groups here fail for
 * different reasons and the wrong remedy wastes the time this check exists to save.
 */
const REQUIRED = [
  // Whisper's library, imported by URL from public/workers/whisper.worker.js.
  { rel: `lib/transformers/${transformersVersion}/transformers.min.js`, fix: 'npm run sync' },
  // Both runtime builds: v2 picks one by capability at load time, so a browser
  // without SIMD needs the plain one to be there rather than 404.
  { rel: `lib/transformers/${transformersVersion}/ort-wasm-simd.wasm`, fix: 'npm run sync' },
  { rel: `lib/transformers/${transformersVersion}/ort-wasm.wasm`, fix: 'npm run sync' },
  // The separation tools' runtime. The loader and the binary it loads must both
  // be present, and from the same version.
  { rel: `ort/${ortVersion}/ort-wasm-simd-threaded.mjs`, fix: 'npm run sync' },
  { rel: `ort/${ortVersion}/ort-wasm-simd-threaded.wasm`, fix: 'npm run sync' },
  // Committed rather than generated, so it should always be here — but if it ever
  // stops being copied the failure looks identical and is just as quiet.
  { rel: 'workers/whisper.worker.js', fix: 'restore it from git' },
  // Committed too, for the same reason. A missing launch image breaks nothing a
  // visitor can name; it just makes an installed PWA open on a white rectangle.
  ...splash.map((rel) => ({ rel, fix: 'npm run appicons' })),
];

const missing = [];
for (const { rel, fix } of REQUIRED) {
  if (!existsSync(join(dist, ...rel.split('/')))) missing.push({ rel, fix, why: 'not in dist/' });
  // In dist but ignored is the same 404 to a visitor, and harder to spot.
  else if (isIgnored(rel)) missing.push({ rel, fix, why: 'excluded by .assetsignore' });
}

if (missing.length > 0) {
  console.error(`\n${missing.length} required asset(s) will not be served:\n`);
  for (const { rel, why, fix } of missing) console.error(`  ${rel}\n      ${why} — ${fix}`);
  console.error(
    '\nDeploying without the transformers or ort files leaves the transcriber and\n' +
      'the separation tools failing on every file, with an error that blames the\n' +
      'file. Both directories are generated from node_modules and are not in git.\n'
  );
  process.exit(1);
}

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
  if (isIgnored(rel)) {
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
  `Asset check passed: ${REQUIRED.length} required asset(s) present, ` +
    `nothing over ${LIMIT / 1048576} MiB ` +
    `(${ignoredCount} file(s) served from R2 instead).`
);
