/**
 * Copies the ffmpeg.wasm core into public/ so it is served from our own origin.
 *
 * Self-hosting rather than pulling from a CDN keeps the "nothing leaves your
 * device" claim literally true — there is no third-party request at any point —
 * and means the converter still works if a CDN is blocked or down.
 *
 * The core is ~31 MB uncompressed, so it is gitignored and regenerated on
 * install and before every build.
 */
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'public', 'ffmpeg');

const FILES = ['ffmpeg-core.js', 'ffmpeg-core.wasm'];

/**
 * The ESM core, not the UMD one.
 *
 * @ffmpeg/ffmpeg's ESM build always spawns its worker with { type: 'module' },
 * and a module worker has no importScripts — so the worker loads the core with
 * `(await import(coreURL)).default`. Only the ESM core has that default export.
 * Shipping the UMD build makes every Tier 2 conversion fail with
 * "failed to import ffmpeg-core.js".
 *
 * The exports map hides package.json, so resolve the entry and step sideways.
 */
let sourceDir;
try {
  sourceDir = join(dirname(dirname(require.resolve('@ffmpeg/core'))), 'esm');
} catch {
  console.warn(
    '[ffmpeg] @ffmpeg/core not installed — skipping core sync. ' +
      'Tier 2 conversions will be unavailable until you run npm install.'
  );
  process.exit(0);
}

mkdirSync(target, { recursive: true });

let copied = 0;
for (const file of FILES) {
  const from = join(sourceDir, file);
  const to = join(target, file);

  if (!existsSync(from)) {
    console.warn(`[ffmpeg] missing ${file} in @ffmpeg/core — skipping.`);
    continue;
  }

  // Skip identical copies so repeat builds don't rewrite 31 MB every time.
  if (existsSync(to) && statSync(to).size === statSync(from).size) continue;

  copyFileSync(from, to);
  copied += 1;
}

if (copied > 0) console.log(`[ffmpeg] synced ${copied} core file(s) to public/ffmpeg`);
