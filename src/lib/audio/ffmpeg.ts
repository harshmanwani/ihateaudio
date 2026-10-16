/**
 * Tier 2: ffmpeg.wasm, loaded only when a format the browser can't handle
 * natively is actually requested.
 *
 * The core is ~31 MB, which is why nothing here is imported at module scope —
 * the dynamic imports below keep every byte of it out of the initial page. The
 * core is served from our own origin, so using it still involves no third-party
 * request and no upload.
 */
import { AudioError, audioError, causeOf, toAudioError, type AudioErrorDetail } from './errors';
import { encodeWav, type WavBitDepth } from './encode-wav';
import { FFMPEG_CORE_VERSION } from './ffmpeg-version';
import {
  MAX_LOAD_ATTEMPTS,
  clearLoadFailures,
  loadGivenUp,
  recordLoadFailure,
} from './ffmpeg-failures';

/**
 * Shown once the core has failed `MAX_LOAD_ATTEMPTS` times on this device.
 *
 * The standard copy tells the visitor to check their connection and reload, which
 * is right for a dropped download and wrong here: the connection was fine, the
 * device could not run the core, and a reload only downloads 31 MB to fail again.
 */
const GIVE_UP_FIX =
  "This device couldn't run the converter, and trying again would only download it again. Try a desktop browser or a newer phone, or pick WAV or MP3 if the tool offers them, because those need no download.";

/** Where in the load a failure happened. Reported with `tool_error`. */
type LoadStage = 'import' | 'load';

/**
 * What this browser can do, as booleans a person could not mistake for content.
 *
 * Old iPhones and Lockdown Mode are the suspected reasons the core will not
 * start, and neither is visible in the user agent. `wasm` is false where
 * WebAssembly is switched off outright.
 */
function engineSupport(): AudioErrorDetail {
  const out: AudioErrorDetail = {
    wasm: typeof WebAssembly === 'object',
    sab: typeof SharedArrayBuffer === 'function',
  };
  const memory =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as { deviceMemory?: unknown }).deviceMemory;
  // Chromium only, and already rounded by the browser to a few coarse values.
  if (typeof memory === 'number') out.mem_gb = memory;
  return out;
}

export interface FFmpegProgress {
  (ratio: number): void;
}

type FFmpegInstance = {
  loaded: boolean;
  load(config: {
    coreURL: string;
    wasmURL: string;
    classWorkerURL?: string;
  }): Promise<boolean>;
  writeFile(path: string, data: Uint8Array): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array | string>;
  deleteFile(path: string): Promise<boolean>;
  exec(args: string[]): Promise<number>;
  on(event: 'progress', cb: (e: { progress: number }) => void): void;
  off(event: 'progress', cb: (e: { progress: number }) => void): void;
  terminate(): void;
};

let instance: FFmpegInstance | null = null;
let loading: Promise<FFmpegInstance> | null = null;

/** True once the core is in memory — lets the UI skip the "loading" copy. */
export function isFFmpegReady(): boolean {
  return instance?.loaded === true;
}

/**
 * Loads the core. Callers should surface `onStatus` because this is the one
 * place on the site where a real wait can happen, and saying why is the
 * difference between patience and a bounce.
 */
export async function loadFFmpeg(
  onStatus?: (ratio: number) => void
): Promise<FFmpegInstance> {
  if (instance?.loaded) return instance;
  if (loading) return loading;

  // Out of attempts: say so without fetching 31 MB that will fail the same way.
  if (loadGivenUp()) {
    throw audioError('ffmpeg-load-failed', GIVE_UP_FIX, {
      stage: 'blocked',
      gave_up: true,
      ...engineSupport(),
    });
  }

  let stage: LoadStage = 'import';
  let prewarmed: PrewarmResult = 'skipped';

  loading = (async () => {
    try {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      stage = 'load';
      const ff = new FFmpeg() as unknown as FFmpegInstance;

      // classWorkerURL is deliberately not passed — the library's own worker
      // resolution is what Vite can statically rewrite to an emitted chunk.

      // Fully absolute URLs, and deliberately not blob URLs.
      //
      // The worker import()s coreURL, resolved against the *worker's* base
      // URL rather than the page's. A root-relative "/ffmpeg/..." breaks
      // whenever that base is not the site root; an absolute URL resolves
      // identically from any base.
      //
      // A blob URL would not work either: the core derives sibling filenames
      // by string-replacing the ".js" extension, which a blob URL lacks.
      //
      // The version is in the path so the response can be cached immutably for
      // a year. Without it the filename never changes when the package does, so
      // it could only be cached for a day and every returning visitor paid the
      // 31 MB again.
      const base = new URL(`/ffmpeg/${FFMPEG_CORE_VERSION}/`, window.location.origin);
      const coreURL = new URL('ffmpeg-core.js', base).href;
      const wasmURL = new URL('ffmpeg-core.wasm', base).href;

      onStatus?.(0.02);
      prewarmed = await prewarm(wasmURL, onStatus);

      // wasmURL is served from the HTTP cache thanks to the prewarm above.
      await ff.load({ coreURL, wasmURL });
      onStatus?.(1);

      instance = ff;
      clearLoadFailures();
      return ff;
    } catch (err) {
      loading = null;
      const attempts = recordLoadFailure();
      const gaveUp = attempts >= MAX_LOAD_ATTEMPTS;
      // `cause` is an allow-listed name, never the message: see causeOf.
      throw audioError('ffmpeg-load-failed', gaveUp ? GIVE_UP_FIX : undefined, {
        stage,
        cause: causeOf(err),
        prewarm: prewarmed,
        attempt: attempts,
        gave_up: gaveUp,
        ...engineSupport(),
      });
    }
  })();

  return loading;
}

type PrewarmResult = 'ok' | 'failed' | 'skipped';

/**
 * Streams the wasm into the HTTP cache so the 31 MB wait can show a real
 * percentage instead of a spinner. ffmpeg's own load then reads from cache.
 *
 * Failures here are deliberately swallowed — this is a progress affordance, and
 * ffmpeg fetching the file itself remains the source of truth. The outcome is
 * returned only so a later load failure can say whether the download itself had
 * already gone wrong.
 */
async function prewarm(
  url: string,
  onStatus?: (ratio: number) => void
): Promise<PrewarmResult> {
  if (!onStatus) return 'skipped';
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) return 'failed';

    const declared = Number(response.headers.get('content-length')) || 0;
    // Compressed transfer means content-length understates the real size, so
    // fall back to the known uncompressed figure.
    const total = declared > 1_000_000 ? declared : 31.5 * 1024 * 1024;

    const reader = response.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value?.length ?? 0;
      // Cap below 1: instantiation still has to happen after the download.
      onStatus(Math.min(0.95, received / total));
    }
    return 'ok';
  } catch {
    /* Progress is a nicety; the load itself will surface any real failure. */
    return 'failed';
  }
}

/** Frees the core. Worth doing on mobile, where 31 MB of heap is significant. */
export function releaseFFmpeg(): void {
  try {
    instance?.terminate();
  } catch {
    /* Terminating an already-dead worker is not an error worth surfacing. */
  }
  instance = null;
  loading = null;
}

export interface TranscodeOptions {
  /** Extra ffmpeg arguments inserted before the output filename. */
  args?: string[];
  onProgress?: FFmpegProgress;
  /** Reported while the 31 MB core downloads, separately from encode progress. */
  onLoadProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

/**
 * Runs one step of a transcode and tags whatever it throws with where it was.
 *
 * Nothing about the outcome changes: a raw error is normalised exactly as the
 * UI would have normalised it (an out-of-memory stays out-of-memory, anything
 * else stays unknown-error), and an AudioError passes through untouched. The one
 * addition is the stage, so a bare `unknown-error` in analytics says whether it
 * happened while writing the input into the core or reading the result back.
 */
async function inStage<T>(stage: 'write' | 'read', run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AudioError) throw err;
    const known = toAudioError(err);
    throw new AudioError(known.code, known.message, known.fix, { ...known.detail, stage });
  }
}

/**
 * Runs one ffmpeg invocation over a blob and returns the result.
 * `inputName` matters: ffmpeg picks the demuxer from the extension.
 */
export async function transcode(
  input: Blob,
  inputName: string,
  outputName: string,
  options: TranscodeOptions = {}
): Promise<Blob> {
  const { args = [], onProgress, onLoadProgress, signal } = options;

  const ff = await loadFFmpeg(onLoadProgress);
  if (signal?.aborted) throw audioError('cancelled');

  const handler = (e: { progress: number }): void => {
    // ffmpeg reports >1 near the end on some builds; clamp so bars behave.
    onProgress?.(Math.min(1, Math.max(0, e.progress)));
  };
  ff.on('progress', handler);

  try {
    await inStage('write', async () => {
      await ff.writeFile(inputName, new Uint8Array(await input.arrayBuffer()));
    });
    if (signal?.aborted) throw audioError('cancelled');

    let code: number;
    try {
      code = await ff.exec(['-i', inputName, ...args, outputName]);
    } catch (err) {
      /*
       * A throw here is the wasm itself trapping (libopus overflowing the
       * core's stack was the case that surfaced it), not ffmpeg reporting an
       * error. The trap leaves the core's memory in whatever state it died in,
       * and every later exec on it failed the same way, whatever the format,
       * until the page was reloaded. Dropping the instance means the next
       * export loads a clean one, from the HTTP cache rather than the network.
       */
      releaseFFmpeg();
      throw audioError('encode-failed', undefined, { stage: 'exec', cause: causeOf(err) });
    }
    if (code !== 0) {
      throw audioError('encode-failed', undefined, { stage: 'exec', exit_code: code });
    }

    const data = await inStage('read', () => ff.readFile(outputName));
    if (typeof data === 'string') {
      throw audioError('encode-failed', undefined, { stage: 'read', cause: 'text-output' });
    }
    if (data.length === 0) {
      throw audioError('encode-failed', undefined, { stage: 'read', cause: 'empty-output' });
    }

    return new Blob([data as BlobPart], { type: mimeForName(outputName) });
  } finally {
    ff.off('progress', handler);
    // Clean the virtual filesystem so repeat runs don't accumulate megabytes.
    await ff.deleteFile(inputName).catch(() => {});
    await ff.deleteFile(outputName).catch(() => {});
  }
}

export interface EncodeViaOptions extends TranscodeOptions {
  /**
   * Bit depth of the WAV handed to ffmpeg. 24 suits a lossy encoder, which
   * works in floating point and benefits from the extra precision. A lossless
   * target must get the depth it is meant to store instead, because ffmpeg's
   * FLAC encoder copies the depth of its input: a 24-bit hand-over made every
   * FLAC 24-bit, half as big again as a 16-bit one for no audible gain.
   */
  bitDepth?: WavBitDepth;
}

/**
 * Encodes an AudioBuffer to any ffmpeg-supported format.
 *
 * The buffer is handed over as WAV because that is lossless and instant to
 * write — ffmpeg only does the part the browser genuinely cannot.
 */
export async function encodeVia(
  buffer: AudioBuffer,
  outputExtension: string,
  options: EncodeViaOptions = {}
): Promise<Blob> {
  const { bitDepth = 24, ...rest } = options;
  const wav = encodeWav(buffer, { bitDepth });
  return transcode(wav, 'in.wav', `out.${outputExtension}`, rest);
}

/**
 * Extracts the audio track from a video without re-encoding when possible.
 */
export async function extractAudio(
  file: File,
  outputExtension: string,
  options: TranscodeOptions = {}
): Promise<Blob> {
  const ext = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase() || 'mp4';
  return transcode(file, `in.${ext}`, `out.${outputExtension}`, {
    ...options,
    args: ['-vn', ...(options.args ?? [])],
  });
}

const MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  m4r: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  wma: 'audio/x-ms-wma',
  aiff: 'audio/aiff',
  amr: 'audio/amr',
  caf: 'audio/x-caf',
};

export function mimeForName(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}
