/**
 * The light AAC encode, off the main thread.
 *
 * Two builds of the same encoder (scripts/aac-encoder/build.sh): WebAssembly
 * where the page may compile it, and the same code as plain JavaScript where
 * it may not. Safari 15 is the second case: the CSP allows WebAssembly only
 * through 'wasm-unsafe-eval', which it does not know.
 *
 * The page names both builds by URL, so they stay files of their own that load
 * only when an export needs them. As with the MP3 worker, the samples arrive a
 * piece at a time and each progress message asks for the next one.
 */
import { AacStream, type AacModule } from './aac-stream';
import { aacAdts, aacMp4 } from './mp4-write';

export interface AacUrls {
  glue: string;
  wasm: string;
  js: string;
}

export type AacEngine = 'wasm' | 'js';

export type AacRequest =
  | {
      type: 'start';
      urls: AacUrls;
      channels: number;
      sampleRate: number;
      /** Bits per second. */
      bitRate: number;
      container: 'mp4' | 'adts';
      /** Samples per channel that will be sent, for the edit list. */
      frames: number;
    }
  | { type: 'piece'; planes: Float32Array[] }
  | { type: 'end' };

export type AacResponse =
  | { type: 'progress'; samples: number }
  | { type: 'done'; blob: Blob; engine: AacEngine }
  | { type: 'error'; name: string; message: string; stage: 'load' | 'encode'; engine: AacEngine | null };

type Create = (options: Record<string, unknown>) => Promise<AacModule>;

function post(message: AacResponse): void {
  (self as unknown as Worker).postMessage(message);
}

/** True when this worker may compile WebAssembly, and has sign-extension ops. */
function canCompileWasm(): boolean {
  if (typeof WebAssembly !== 'object') return false;
  try {
    new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    // i32.extend8_s, which the build uses: Safari 14.1, Chrome 74, Firefox 62.
    return WebAssembly.validate(
      new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 65, 0, 192, 26, 11])
    );
  } catch {
    return false;
  }
}

let loaded: Promise<{ module: AacModule; engine: AacEngine }> | null = null;

function load(urls: AacUrls): Promise<{ module: AacModule; engine: AacEngine }> {
  loaded ??= (async () => {
    if (canCompileWasm()) {
      try {
        const create = ((await import(/* @vite-ignore */ urls.glue)) as { default: Create }).default;
        const module = await create({
          locateFile: (path: string) => (path.endsWith('.wasm') ? urls.wasm : path),
        });
        return { module, engine: 'wasm' as const };
      } catch {
        /* The JavaScript build does the same work, only slower. */
      }
    }
    const create = ((await import(/* @vite-ignore */ urls.js)) as { default: Create }).default;
    return { module: await create({}), engine: 'js' as const };
  })();
  // A load that failed may work next time, on a better connection.
  loaded.catch(() => {
    loaded = null;
  });
  return loaded;
}

interface Job {
  stream: AacStream | null;
  start: Extract<AacRequest, { type: 'start' }>;
  engine: AacEngine | null;
  samples: number;
  failed: boolean;
}

let job: Job | null = null;
// Messages are handled in order, and the first waits for the encoder to load.
let chain: Promise<void> = Promise.resolve();

function fail(err: unknown, stage: 'load' | 'encode'): void {
  const engine = job?.engine ?? null;
  job?.stream?.close();
  if (job) job.failed = true;
  const name = (err as { name?: unknown } | null)?.name;
  post({
    type: 'error',
    name: typeof name === 'string' ? name : typeof err,
    message: err instanceof Error ? err.message : String(err),
    stage,
    engine,
  });
}

async function handle(message: AacRequest): Promise<void> {
  if (message.type === 'start') {
    job = { stream: null, start: message, engine: null, samples: 0, failed: false };
    let module: AacModule;
    try {
      const result = await load(message.urls);
      module = result.module;
      job.engine = result.engine;
    } catch (err) {
      fail(err, 'load');
      return;
    }
    try {
      job.stream = new AacStream(module, message.channels, message.sampleRate, message.bitRate);
    } catch (err) {
      fail(err, 'encode');
    }
    return;
  }

  if (!job || job.failed || !job.stream) return;
  try {
    if (message.type === 'piece') {
      job.stream.write(message.planes);
      job.samples += message.planes[0]?.length ?? 0;
      post({ type: 'progress', samples: job.samples });
      return;
    }

    const encoded = job.stream.end();
    const { start } = job;
    const track = {
      sampleRate: start.sampleRate,
      channels: start.channels,
      config: encoded.config,
      priming: encoded.priming,
      frames: start.frames,
      packetFrames: encoded.packetFrames,
      sizes: encoded.sizes,
    };
    let blob: Blob;
    if (start.container === 'mp4') {
      blob = aacMp4(track, encoded.chunks as BlobPart[]);
    } else {
      const packets = new Uint8Array(encoded.bytes);
      let at = 0;
      for (const chunk of encoded.chunks) {
        packets.set(chunk, at);
        at += chunk.length;
      }
      blob = aacAdts(track, packets);
    }
    const engine = job.engine ?? 'js';
    job = null;
    post({ type: 'done', blob, engine });
  } catch (err) {
    fail(err, 'encode');
  }
}

self.onmessage = (event: MessageEvent<AacRequest>) => {
  const message = event.data;
  chain = chain.then(() => handle(message));
};
