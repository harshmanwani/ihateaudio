/**
 * Puts the ffmpeg core into R2, which is where production serves it from.
 *
 * The core is 30.7 MB and Cloudflare caps a single static asset at 25 MiB, so it
 * cannot ship with the rest of the site. R2 has no egress charge, which for a
 * file this size downloaded by this many people is the difference between free
 * and a bill that grows with traffic.
 *
 * Only needs running when @ffmpeg/core changes version, because the object key
 * carries the version and old keys stay valid for anyone still holding a cached
 * page. Uses the wrangler CLI rather than the S3 API so it uses the login you
 * already have.
 *
 *   npm run ffmpeg:upload            # to real R2
 *   npm run ffmpeg:upload -- --local # to the local dev simulation
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const local = process.argv.includes('--local');

const version = /'([^']+)'/.exec(
  readFileSync(join(root, 'src', 'lib', 'audio', 'ffmpeg-version.ts'), 'utf8')
    .split('\n')
    .find((line) => line.includes('FFMPEG_CORE_VERSION')) ?? ''
)?.[1];

if (!version) {
  console.error(
    'Could not read the core version. Run `node scripts/sync-ffmpeg-core.mjs` first.'
  );
  process.exit(1);
}

const bucket = /"bucket_name":\s*"([^"]+)"/.exec(
  readFileSync(join(root, 'wrangler.jsonc'), 'utf8')
)?.[1];

if (!bucket) {
  console.error('Could not find bucket_name in wrangler.jsonc.');
  process.exit(1);
}

const source = join(root, 'public', 'ffmpeg', version);
if (!existsSync(source)) {
  console.error(
    `${source} does not exist. Run \`node scripts/sync-ffmpeg-core.mjs\` first.`
  );
  process.exit(1);
}

/**
 * Content types are set explicitly, and `application/wasm` is not cosmetic:
 * WebAssembly.instantiateStreaming rejects anything else outright, and the
 * failure looks nothing like its cause.
 */
const FILES = [
  { name: 'ffmpeg-core.js', type: 'text/javascript' },
  { name: 'ffmpeg-core.wasm', type: 'application/wasm' },
];

console.log(
  `Uploading core ${version} to ${local ? 'the local simulation of ' : ''}r2://${bucket}\n`
);

for (const file of FILES) {
  const path = join(source, file.name);
  if (!existsSync(path)) {
    console.error(`missing ${path}`);
    process.exit(1);
  }

  const mb = (statSync(path).size / 1024 / 1024).toFixed(1);
  process.stdout.write(`  ${file.name} (${mb} MB) `);

  const args = [
    'wrangler',
    'r2',
    'object',
    'put',
    `${bucket}/${version}/${file.name}`,
    `--file=${path}`,
    `--content-type=${file.type}`,
  ];
  if (local) args.push('--local');
  else args.push('--remote');

  try {
    execFileSync('npx', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('ok');
  } catch (error) {
    console.log('FAILED');
    console.error(String(error.stderr ?? error.stdout ?? error).slice(0, 600));
    process.exit(1);
  }
}

console.log(`\nServed at /ffmpeg/${version}/ by worker/index.ts.`);
