/**
 * Tier 2: ffmpeg.wasm, loaded only when a format the browser can't handle
 * natively is actually requested.
 *
 * The core is ~31 MB, which is why nothing here is imported at module scope —
 * the dynamic imports below keep every byte of it out of the initial page. The
 * core is served from our own origin, so using it still involves no third-party
 * request and no upload.
 */
import { audioError, type AudioError, type AudioErrorCode } from './errors';
import { describeError, environment } from './diagnose';
import { encodeWav, type WavBitDepth } from './encode-wav';
import { FFMPEG_CORE_VERSION } from './ffmpeg-version';

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

/**
 * Runs one instance gets before a fresh one replaces it.
 *
 * Every run on @ffmpeg/core 0.12.10 ends in abort(), which unwinds the wasm
 * stack without putting the stack pointer back, so each run loses 224 bytes of
 * the 64 KB stack until the instance is gone (an error exit loses 4.7 KB). The
 * encoders that go deepest trap once that eats their headroom, measured in
 * Chromium on songs and speech:
 *
 *   - mono Opus at 32 and 48 kbps: 3.7 KB spare, traps on the 19th run;
 *   - stereo Opus at 32 and 48 kbps, and Vorbis at the bottom of each band from
 *     26 kHz up: 7.5 KB, traps on about the 36th;
 *   - AAC, FLAC, WMA and AIFF: 32 KB.
 *
 * Eight runs spend 1.8 KB, half of the tightest margin. A replacement loads
 * from the bytes already in memory (see `core`), and its first encode is about
 * 30 ms slower while the wasm warms up.
 */
const RUNS_PER_INSTANCE = 8;

/** ffmpeg runs started on the current instance. */
let runs = 0;

/** The end of the last transcode, which the next one waits for. */
let queue: Promise<unknown> = Promise.resolve();

/** True once the core is in memory — lets the UI skip the "loading" copy. */
export function isFFmpegReady(): boolean {
  return instance?.loaded === true;
}

/**
 * Why the core cannot run in this browser, or null when it can.
 *
 *   - no-wasm: no WebAssembly at all.
 *   - wasm-blocked: WebAssembly exists but may not compile. The CSP allows it
 *     through 'wasm-unsafe-eval', a keyword Safari only learned in 16.0; Safari
 *     15 wants 'unsafe-eval', which this site will not grant, so on iOS 15 no
 *     WebAssembly runs at all.
 *   - no-simd: the core is built with -msimd128, and Safari only compiles SIMD
 *     from 16.4. Before that the 31 MB download ends in a CompileError, every
 *     time: on iOS 15 that was eight downloads in five minutes from one person.
 *   - no-module-worker: @ffmpeg/ffmpeg starts its worker as a module, which
 *     Firefox only allows from 114.
 *   - low-memory: Chromium says the device has under 1 GB. Compiling 31 MB of
 *     wasm takes a few times that in memory, and the tab dies rather than fails.
 */
export type FFmpegBlocker = 'no-wasm' | 'wasm-blocked' | 'no-simd' | 'no-module-worker' | 'low-memory';

let blocker: FFmpegBlocker | null | undefined;

/** Checked once, without downloading anything. */
export function ffmpegBlocker(): FFmpegBlocker | null {
  if (blocker === undefined) blocker = detectBlocker();
  return blocker;
}

/** The smallest valid module: compiling it is what a CSP refuses. */
const EMPTY_MODULE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

/** One function using i8x16.splat and i8x16.popcnt, as wasm-feature-detect tests SIMD. */
const SIMD_MODULE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15,
  253, 98, 11,
]);

function detectBlocker(): FFmpegBlocker | null {
  if (typeof WebAssembly !== 'object') return 'no-wasm';
  try {
    new WebAssembly.Module(EMPTY_MODULE);
  } catch {
    return 'wasm-blocked';
  }
  try {
    if (!WebAssembly.validate(SIMD_MODULE)) return 'no-simd';
  } catch {
    return 'no-simd';
  }
  if (!moduleWorkers()) return 'no-module-worker';
  const memory =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof memory === 'number' && memory < 1) return 'low-memory';
  return null;
}

/**
 * Whether `new Worker(url, { type: 'module' })` is understood. A browser that
 * reads the option reads `type`; the URL is invalid on purpose, so nothing
 * starts and no CSP report is filed.
 */
function moduleWorkers(): boolean {
  if (typeof Worker === 'undefined') return false;
  let supported = false;
  const options = {
    get type(): 'module' {
      supported = true;
      return 'module';
    },
  };
  try {
    new Worker('blob://', options).terminate();
  } catch {
    /* Expected: only whether `type` was read matters. */
  }
  return supported;
}

/** For tests: forget what the last check found. */
export function resetFFmpegSupport(): void {
  blocker = undefined;
}

/** Where a load got to when it failed, for the error report. */
export type LoadStage = 'import' | 'download' | 'load';

/**
 * The core's wasm, kept once it has been downloaded in full.
 *
 * A retry after a failed start, and the replacement instance every eight runs,
 * load from this instead of the network. Leaving it to the HTTP cache was not
 * enough: iOS Safari does not reliably keep a 31 MB response there, so a press
 * after a failure could download all of it again, and ffmpeg's own fetch after
 * the progress download could too. It lives for the page, not in Cache
 * Storage: public/sw.js keeps the core out of storage on purpose, to protect
 * the quota.
 */
let core: Blob | null = null;

/** Lets the kept bytes go, so the next load downloads them again. */
export function dropFFmpegCore(): void {
  core = null;
}

/**
 * A failed start that is not worth repeating in this page. A CompileError is
 * the browser saying it cannot run this wasm, and it will say so again; any
 * other start failure gets one more try from the kept bytes. A failed download
 * is never remembered: the visitor can press again once the connection is back.
 */
let failure: AudioError | null = null;
let startFailures = 0;
/** Any failed load in this page, remembered or not. */
let failedOnce = false;

/** For tests and for a deliberate retry: forget a remembered failure. */
export function forgetFFmpegFailure(): void {
  failure = null;
  startFailures = 0;
  failedOnce = false;
}

/**
 * True once the core has failed to load in this page, for any reason. The
 * formats with a light encoder stop asking for the core from then on, so a
 * second ringtone does not wait out a second 31 MB download that went wrong
 * the first time.
 */
export function ffmpegFailed(): boolean {
  return failedOnce;
}

/** How long the core may take to start from bytes already in memory. */
const START_TIMEOUT_MS = 90_000;

/** How long a download may go without a byte before it is called stalled. */
const STALL_TIMEOUT_MS = 30_000;

/**
 * The error for a browser that cannot run the core, with the alternative that
 * works here. Thrown before anything is downloaded.
 */
export function unsupportedError(reason: FFmpegBlocker): AudioError {
  const ios = /^ios-/.test(String(environment().ua_class));
  const fix =
    reason === 'low-memory'
      ? 'This device has too little memory for the converter. MP3 and WAV work here without it.'
      : ios
        ? 'The converter needs iOS 16.4 or later. MP3 and WAV work on this iPhone without it.'
        : undefined;
  return audioError('ffmpeg-unsupported', fix, { stage: 'support', blocker: reason, ...environment() });
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

  const reason = ffmpegBlocker();
  if (reason) throw unsupportedError(reason);
  if (failure) {
    // The same answer without another download, marked so the report shows the
    // loop has stopped.
    throw audioError(failure.code, failure.fix, { ...failure.detail, remembered: true });
  }

  loading = (async () => {
    let stage: LoadStage = 'import';
    let received = 0;
    let url: string | null = null;
    let ff: FFmpegInstance | null = null;
    try {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
      ff = new FFmpeg() as unknown as FFmpegInstance;

      // classWorkerURL is deliberately not passed — the library's own worker
      // resolution is what Vite can statically rewrite to an emitted chunk.

      // An absolute URL for the core, and deliberately not a blob URL.
      //
      // The worker import()s coreURL, resolved against the *worker's* base
      // URL rather than the page's. A root-relative "/ffmpeg/..." breaks
      // whenever that base is not the site root; an absolute URL resolves
      // identically from any base. A blob URL would not work for the core:
      // it derives sibling filenames by string-replacing the ".js"
      // extension, which a blob URL lacks. The wasm is named separately, so
      // it can be the bytes already downloaded.
      //
      // The version is in the path so the response can be cached immutably for
      // a year. Without it the filename never changes when the package does, so
      // it could only be cached for a day and every returning visitor paid the
      // 31 MB again.
      const base = new URL(`/ffmpeg/${FFMPEG_CORE_VERSION}/`, window.location.origin);
      const coreURL = new URL('ffmpeg-core.js', base).href;
      const wasmURL = new URL('ffmpeg-core.wasm', base).href;

      stage = 'download';
      onStatus?.(0.02);
      const wasm =
        core ??
        (await download(wasmURL, (bytes, total) => {
          received = bytes;
          // Capped below 1: the core still has to compile after the download.
          onStatus?.(Math.min(0.95, bytes / total));
        }));
      core = wasm;
      received = wasm.size;

      stage = 'load';
      url = URL.createObjectURL(wasm);
      const started = ff;
      await withTimeout(started.load({ coreURL, wasmURL: url }), START_TIMEOUT_MS, () => started.terminate());
      onStatus?.(1);

      instance = started;
      runs = 0;
      startFailures = 0;
      return started;
    } catch (err) {
      loading = null;
      // A worker whose core would not start holds memory and does nothing.
      try {
        ff?.terminate();
      } catch {
        /* Already gone. */
      }
      throw loadFailure(err, stage, received);
    } finally {
      if (url) URL.revokeObjectURL(url);
    }
  })();

  return loading;
}

/** The report for a failed load, remembering it when a retry would only repeat it. */
function loadFailure(err: unknown, stage: LoadStage, received: number): AudioError {
  failedOnce = true;
  const described = describeError(err);
  const detail = { stage, ...described, loaded_mb: Math.round(received / 100_000) / 10 };
  if (stage !== 'load') {
    return audioError(
      'ffmpeg-load-failed',
      'The converter download stopped. Check your connection and press the button again. Nothing is uploaded — only the converter code is downloaded.',
      detail
    );
  }

  startFailures += 1;
  // The browser's own verdict on the wasm does not change between presses.
  const deterministic = /CompileError|LinkError/.test(`${described.error_name} ${described.error_message}`);
  if (deterministic || startFailures >= 2) {
    failure = audioError(
      'ffmpeg-load-failed',
      'The converter downloaded but will not start on this device. MP3 and WAV work without it.',
      detail
    );
    // Nothing will load from it again in this page.
    core = null;
    return failure;
  }
  return audioError(
    'ffmpeg-load-failed',
    'The converter downloaded but did not start. Press the button again to retry: it will not download again. MP3 and WAV work without it.',
    detail
  );
}

/**
 * Downloads the wasm with progress, into a Blob ready to hand to the worker.
 * Throws when the response is not the file, or when the bytes stop coming.
 */
async function download(
  url: string,
  onBytes: (bytes: number, total: number) => void
): Promise<Blob> {
  const controller = new AbortController();
  let stalled = false;
  let timer = setTimeout(() => {
    stalled = true;
    controller.abort();
  }, STALL_TIMEOUT_MS);
  const touch = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, STALL_TIMEOUT_MS);
  };

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const declared = Number(response.headers.get('content-length')) || 0;
    // Compressed transfer means content-length understates the real size, so
    // fall back to the known uncompressed figure.
    const total = declared > 1_000_000 ? declared : 31.5 * 1024 * 1024;

    if (!response.body) {
      const blob = await response.blob();
      onBytes(blob.size, total);
      return new Blob([blob], { type: 'application/wasm' });
    }

    const reader = response.body.getReader();
    const parts: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      touch();
      if (value) {
        parts.push(value);
        received += value.length;
        onBytes(received, total);
      }
    }
    // application/wasm lets the worker compile it while it streams in.
    return new Blob(parts as BlobPart[], { type: 'application/wasm' });
  } catch (err) {
    if (stalled) throw new DOMException(`No data for ${STALL_TIMEOUT_MS / 1000} s`, 'TimeoutError');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Rejects with a TimeoutError if `promise` takes longer than `ms`, after calling `onTimeout`. */
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new DOMException(`No answer in ${ms / 1000} s`, 'TimeoutError'));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  runs = 0;
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
 * Runs one ffmpeg invocation over a blob and returns the result.
 * `inputName` matters: ffmpeg picks the demuxer from the extension.
 */
export async function transcode(
  input: Blob,
  inputName: string,
  outputName: string,
  options: TranscodeOptions = {}
): Promise<Blob> {
  const data = await run(input, inputName, outputName, options, 'encode-failed');
  return new Blob([data as BlobPart], { type: mimeForName(outputName) });
}

/**
 * One ffmpeg invocation, returning the output file's bytes. A failure throws
 * `failure`. An ArrayBuffer input is moved to ffmpeg's worker rather than
 * copied, so the caller cannot use it afterwards.
 */
function run(
  input: Blob | ArrayBuffer,
  inputName: string,
  outputName: string,
  options: TranscodeOptions,
  failure: AudioErrorCode
): Promise<Uint8Array> {
  // One at a time: runs share file names in ffmpeg's virtual filesystem, and
  // the instance can be replaced between runs, which must not happen under one.
  const job = queue.then(() => runNow(input, inputName, outputName, options, failure));
  queue = job.catch(() => {});
  return job;
}

const TRAPPED = Symbol('trapped');

async function runNow(
  input: Blob | ArrayBuffer,
  inputName: string,
  outputName: string,
  options: TranscodeOptions,
  failure: AudioErrorCode
): Promise<Uint8Array> {
  const { onLoadProgress, signal } = options;

  // Replaced before it can run short of stack. The replacement comes from the
  // HTTP cache, so it is not announced as loading the converter. An ArrayBuffer
  // can be handed to the worker only once, so it cannot have the retry below;
  // it gets a fresh instance up front instead.
  const worn = runs >= RUNS_PER_INSTANCE || (input instanceof ArrayBuffer && runs > 0);
  if (worn) releaseFFmpeg();

  let ff = await loadFFmpeg(worn ? undefined : onLoadProgress);
  if (signal?.aborted) throw audioError('cancelled');
  const used = runs > 0;
  let result = await runOnce(ff, input, inputName, outputName, options, failure);

  // A trap on an instance that had already run may be the stack it lost, which
  // a fresh one has back. A trap on a fresh instance is the encode itself.
  if (result === TRAPPED && used && !signal?.aborted) {
    ff = await loadFFmpeg();
    if (signal?.aborted) throw audioError('cancelled');
    result = await runOnce(ff, input, inputName, outputName, options, failure);
  }
  if (result === TRAPPED) throw audioError(failure);
  return result;
}

async function runOnce(
  ff: FFmpegInstance,
  input: Blob | ArrayBuffer,
  inputName: string,
  outputName: string,
  options: TranscodeOptions,
  failure: AudioErrorCode
): Promise<Uint8Array | typeof TRAPPED> {
  const { args = [], onProgress, signal } = options;
  runs += 1;

  const handler = (e: { progress: number }): void => {
    // ffmpeg reports >1 near the end on some builds; clamp so bars behave.
    onProgress?.(Math.min(1, Math.max(0, e.progress)));
  };
  ff.on('progress', handler);

  try {
    // A Blob is read again for every run: writeFile transfers the buffer to the worker.
    const bytes = new Uint8Array(input instanceof ArrayBuffer ? input : await input.arrayBuffer());
    await ff.writeFile(inputName, bytes);
    if (signal?.aborted) throw audioError('cancelled');

    let code: number;
    try {
      code = await ff.exec(['-i', inputName, ...args, outputName]);
    } catch {
      /*
       * A throw here is the wasm itself trapping, not ffmpeg reporting an
       * error: the encode ran out of stack (stereo Opus at 20 ms frames did on
       * every instance; see RUNS_PER_INSTANCE for the runs that did on a used
       * one). The trap leaves the core's memory in whatever state it died in,
       * and every later exec on it failed the same way, whatever the format,
       * until the page was reloaded. Dropping the instance means the next
       * run loads a clean one, from the HTTP cache rather than the network.
       */
      releaseFFmpeg();
      return TRAPPED;
    }
    if (code !== 0) {
      // An error exit unwinds from deeper than a clean one and takes 4.7 KB of
      // stack with it, more than some encoders can spare.
      releaseFFmpeg();
      throw audioError(failure);
    }

    const data = await ff.readFile(outputName);
    if (typeof data === 'string' || data.length === 0) throw audioError(failure);
    return data;
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

export interface DecodeViaOptions extends TranscodeOptions {
  /** Resample to this rate. Left out, the audio keeps the file's own rate. */
  rate?: number;
}

/**
 * Decodes audio the browser has no decoder for: Apple Lossless in Chromium
 * and Firefox, and the other codecs an MP4 can hold that a browser refuses.
 *
 * ffmpeg hands back 32-bit float WAV, which holds every sample exactly and
 * keeps the overs a lossy decoder can produce above full scale. The samples
 * go straight into an AudioBuffer instead of back through decodeAudioData,
 * whose WAV support differs from browser to browser.
 *
 * `bytes` is moved to ffmpeg's worker, not copied: an hour of Apple Lossless
 * is half a gigabyte, and the caller has no more use for it. It is detached
 * once this returns.
 */
export async function decodeVia(
  bytes: ArrayBuffer,
  extension: string,
  options: DecodeViaOptions = {}
): Promise<AudioBuffer> {
  const { rate, ...rest } = options;
  const args = ['-vn', '-c:a', 'pcm_f32le', ...(rate ? ['-ar', String(rate)] : []), '-f', 'wav'];
  const wav = await run(bytes, `in.${extension}`, 'out.wav', { ...rest, args }, 'decode-failed');
  return floatWavToBuffer(wav);
}

/** A 32-bit float WAV, as ffmpeg writes it, in an AudioBuffer. */
function floatWavToBuffer(wav: Uint8Array): AudioBuffer {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const id = (at: number): string =>
    String.fromCharCode(wav[at]!, wav[at + 1]!, wav[at + 2]!, wav[at + 3]!);
  let channels = 0;
  let rate = 0;
  let float = false;

  let offset = 12;
  while (offset + 8 <= wav.length) {
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id(offset) === 'fmt ' && body + 16 <= wav.length) {
      const tag = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      // 3 is IEEE float; 0xFFFE is the extensible header, which ffmpeg uses
      // past two channels and which names float in its subformat instead.
      const subformat = tag === 0xfffe && body + 26 <= wav.length ? view.getUint16(body + 24, true) : tag;
      float = subformat === 3 && view.getUint16(body + 14, true) === 32;
    } else if (id(offset) === 'data') {
      if (!float || channels === 0 || rate === 0) break;
      const frames = Math.floor(Math.min(size, wav.length - body) / (4 * channels));
      if (frames === 0) throw audioError('no-audio-track');
      const buffer = new AudioBuffer({ numberOfChannels: channels, length: frames, sampleRate: rate });
      // DataView, not a Float32Array over the bytes: the header leaves the
      // samples off 4-byte alignment, and realigning them would mean a second
      // copy of the whole file for about the same speed.
      const stride = 4 * channels;
      for (let c = 0; c < channels; c += 1) {
        const out = buffer.getChannelData(c);
        for (let i = 0, at = body + 4 * c; i < frames; i += 1, at += stride) {
          out[i] = view.getFloat32(at, true);
        }
      }
      return buffer;
    }
    offset = body + size + (size % 2);
  }
  throw audioError('decode-failed');
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
