/**
 * Puts the AI models into R2, which is where production serves them from.
 *
 * They cannot ship as static assets: Cloudflare caps a single asset at 25 MiB and
 * the separation model alone is 64 MB. R2 has no egress charge, which for files this
 * size downloaded by this many people is the difference between free and a bill that
 * grows with traffic.
 *
 * Reads whatever is in public/models/<version>/ and mirrors it, so the local copy
 * used for development and verification is by construction the same tree production
 * serves. Only needs running when a model changes, because the version is in the path
 * and old keys stay valid for anyone holding a cached page.
 *
 *   npm run models:upload            # to real R2
 *   npm run models:upload -- --local # to the local dev simulation
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const local = process.argv.includes('--local');

const version = /MODELS_VERSION = '([^']+)'/.exec(
  readFileSync(join(root, 'src', 'lib', 'ai', 'models.ts'), 'utf8')
)?.[1];

if (!version) {
  console.error('Could not read MODELS_VERSION from src/lib/ai/models.ts.');
  process.exit(1);
}

/**
 * The bucket name comes from wrangler.jsonc rather than being repeated here, so
 * there is one place it can be wrong.
 */
const bucket = /"binding":\s*"MODELS",\s*\n\s*"bucket_name":\s*"([^"]+)"/.exec(
  readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
)?.[1];

if (!bucket) {
  console.error('Could not find the MODELS bucket_name in wrangler.jsonc.');
  process.exit(1);
}

const source = join(root, 'public', 'models', version);
if (!existsSync(source)) {
  console.error(
    `${source} does not exist.\n\n` +
      'The models are not in the repository — they are large binaries fetched once\n' +
      'and gitignored. Put them under that directory before uploading; see\n' +
      'DEPLOY.md for where each one comes from.'
  );
  process.exit(1);
}

/**
 * Content types matter more than they look. `application/wasm` is rejected outright
 * by WebAssembly.instantiateStreaming if wrong, and transformers.js fails in its own
 * confusing way if tokenizer.json arrives as octet-stream.
 */
function contentTypeFor(name) {
  if (name.endsWith('.wasm')) return 'application/wasm';
  if (name.endsWith('.json')) return 'application/json';
  if (name.endsWith('.txt')) return 'text/plain';
  if (name.endsWith('.js') || name.endsWith('.mjs')) return 'text/javascript';
  return 'application/octet-stream';
}

/** Every file under the version directory, recursively — Whisper is a tree. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(source).sort();
if (files.length === 0) {
  console.error(`${source} is empty.`);
  process.exit(1);
}

const total = files.reduce((sum, file) => sum + statSync(file).size, 0);
console.log(
  `Uploading ${files.length} file(s), ${(total / 1048576).toFixed(1)} MB, to ` +
    `${local ? 'the local simulation of ' : ''}r2://${bucket}/${version}/\n`
);

let done = 0;
for (const file of files) {
  // Forward slashes in the key regardless of platform: this is a URL path, and on
  // Windows the native separator would produce keys nothing can fetch.
  const key = `${version}/${relative(source, file).split(/[\\/]/).join('/')}`;
  const mb = (statSync(file).size / 1048576).toFixed(1);
  process.stdout.write(`  ${key} (${mb} MB) `);

  const args = [
    'wrangler',
    'r2',
    'object',
    'put',
    `${bucket}/${key}`,
    `--file=${file}`,
    `--content-type=${contentTypeFor(file)}`,
    local ? '--local' : '--remote',
  ];

  try {
    execFileSync('npx', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('ok');
    done += 1;
  } catch (error) {
    console.log('FAILED');
    console.error(String(error.stderr ?? error.stdout ?? error).slice(0, 600));
    process.exit(1);
  }
}

console.log(`\n${done} file(s) uploaded. Served at /models/${version}/ by worker/index.ts.`);
