/**
 * Copies ONNX Runtime's WebAssembly build into public/ so it is served from our
 * own origin, on a versioned path.
 *
 * Two reasons this is a build step rather than an import:
 *
 * Vite cannot resolve it. ONNX Runtime's loader locates its own .wasm at runtime
 * relative to wherever the loader script ended up, and once Vite has bundled that
 * loader into /_astro/<hash>.js it goes looking for /_astro/ort-wasm-*.wasm, which
 * does not exist. Every project using onnxruntime-web ends up setting
 * `env.wasm.wasmPaths` to a real directory, and this puts a real directory there.
 *
 * Self-hosting is the other reason. The default is a jsDelivr URL, which would
 * mean the AI tools quietly send a request to a third party the moment someone
 * opens them — on a site whose entire promise is that nothing leaves the device.
 *
 * Only the plain threaded build is copied. The .jsep and .jspi variants exist for
 * WebGPU and stack-switching, are not used, and the jsep one is 25.6 MB, which is
 * over Cloudflare's 25 MiB per-asset ceiling and would break the deploy outright.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The loader and the binary it loads, and nothing else.
 *
 * These two must come from the same package version. A mismatched pair fails
 * inside the emscripten glue with an error about a missing export, which reads as
 * a bug in the model rather than in the build.
 */
const FILES = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

/**
 * There are two copies of the runtime to sync, not one, and it is not a mistake to
 * be tidied away.
 *
 * The separation tools import onnxruntime-web directly and get whatever is
 * installed at the top level. transformers.js, which drives Whisper, pins its own
 * exact version and npm therefore nests a second copy under it. The emscripten
 * glue and the .wasm must come from the same version — a mismatched pair fails
 * inside the glue complaining about a missing export, which reads as a broken model
 * rather than a broken build — so each library is pointed at its own.
 *
 * Deduplicating them by forcing one version would mean pinning transformers.js to a
 * dev prerelease of the runtime, or overriding the version it was tested against.
 * Two copies of a 13 MB static file is the cheaper problem, and only one of them is
 * ever fetched by any given visitor because the tools are on separate pages.
 */
const PACKAGES = [
  { specifier: 'onnxruntime-web', constant: 'ORT_VERSION', why: 'separation' },
  {
    specifier: '@huggingface/transformers/node_modules/onnxruntime-web',
    constant: 'ORT_TRANSFORMERS_VERSION',
    why: 'whisper',
    optional: true,
  },
];

const CLOUDFLARE_ASSET_LIMIT = 25 * 1024 * 1024;
const found = [];

for (const pkg of PACKAGES) {
  let packageDir;
  try {
    if (pkg.specifier.includes('node_modules')) {
      // A nested copy cannot be resolved by specifier, so look for it directly.
      packageDir = join(root, 'node_modules', ...pkg.specifier.split('/'));
      if (!existsSync(join(packageDir, 'package.json'))) throw new Error('absent');
    } else {
      // The exports map does not expose package.json, so resolve the entry point
      // and step back out of dist/ — the same dance sync-ffmpeg-core.mjs does.
      packageDir = dirname(dirname(require.resolve(pkg.specifier)));
    }
  } catch {
    if (pkg.optional) {
      // npm may hoist the nested copy away if the versions ever converge, which is
      // a good outcome rather than a failure.
      continue;
    }
    console.warn(
      '[onnx] onnxruntime-web not installed — skipping runtime sync. ' +
        'The AI tools will be unavailable until you run npm install.'
    );
    process.exit(0);
  }

  const version = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')).version;
  const sourceDir = join(packageDir, 'dist');
  const target = join(root, 'public', 'ort', version);
  mkdirSync(target, { recursive: true });

  let copied = 0;
  let skipped = 0;
  for (const file of FILES) {
    const from = join(sourceDir, file);
    if (!existsSync(from)) {
      console.error(`[onnx] missing ${from}`);
      process.exit(1);
    }
    const to = join(target, file);
    // Copy only when the size differs, so a rebuild does not rewrite 13 MB every
    // time and invalidate whatever the OS had cached.
    if (existsSync(to) && statSync(to).size === statSync(from).size) {
      skipped += 1;
      continue;
    }
    copyFileSync(from, to);
    copied += 1;
  }

  const wasmBytes = statSync(join(target, 'ort-wasm-simd-threaded.wasm')).size;
  if (wasmBytes > CLOUDFLARE_ASSET_LIMIT) {
    console.error(
      `[onnx] ort-wasm-simd-threaded.wasm is ${(wasmBytes / 1048576).toFixed(1)} MB, over ` +
        `Cloudflare's ${CLOUDFLARE_ASSET_LIMIT / 1048576} MiB per-asset limit. ` +
        'It needs moving to R2 like the ffmpeg core.'
    );
    process.exit(1);
  }

  found.push({ ...pkg, version, wasmBytes, copied, skipped });
}

if (found.length === 0) {
  console.warn('[onnx] no runtime found — skipping.');
  process.exit(0);
}

/**
 * Versions are written out as a module so the runtime code and this script agree
 * on the paths without anyone maintaining a second copy of the strings.
 */
const generated = `/**
 * Generated by scripts/sync-onnx-runtime.mjs. Do not edit.
 *
 * The installed onnxruntime-web versions, which are also the path segments their
 * WebAssembly builds are served under so they can be cached immutably.
 *
 * Normally there is exactly one, held there by an npm override — see the script
 * for why more than one is a problem rather than a convenience.
 */
${found
  .map((pkg) => `export const ${pkg.constant} = '${pkg.version}';`)
  .join('\n')}
`;
const versionFile = join(root, 'src', 'lib', 'ai', 'ort-version.ts');
if (!existsSync(versionFile) || readFileSync(versionFile, 'utf8') !== generated) {
  writeFileSync(versionFile, generated);
}

for (const pkg of found) {
  console.log(
    `[onnx] ${pkg.why.padEnd(10)} runtime ${pkg.version} in public/ort/${pkg.version}/ ` +
      `(${pkg.copied} copied, ${pkg.skipped} unchanged, wasm ${(pkg.wasmBytes / 1048576).toFixed(1)} MB)`
  );
}
