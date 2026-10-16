/**
 * Tier 2: ffmpeg.wasm, loaded only when a format the browser can't handle
 * natively is actually requested.
 *
 * The core is ~31 MB, which is why nothing here is imported at module scope —
 * the dynamic imports below keep every byte of it out of the initial page. The
 * core is served from our own origin, so using it still involves no third-party
 * request and no upload.
 */
import { audioError, type AudioErrorCode } from './errors';
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

  loading = (async () => {
    try {
      const { FFmpeg } = await import('@ffmpeg/ffmpeg');
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
      await prewarm(wasmURL, onStatus);

      // wasmURL is served from the HTTP cache thanks to the prewarm above.
      await ff.load({ coreURL, wasmURL });
      onStatus?.(1);

      instance = ff;
      return ff;
    } catch {
      loading = null;
      throw audioError('ffmpeg-load-failed');
    }
  })();

  return loading;
}

/**
 * Streams the wasm into the HTTP cache so the 31 MB wait can show a real
 * percentage instead of a spinner. ffmpeg's own load then reads from cache.
 *
 * Failures here are deliberately swallowed — this is a progress affordance, and
 * ffmpeg fetching the file itself remains the source of truth.
 */
async function prewarm(
  url: string,
  onStatus?: (ratio: number) => void
): Promise<void> {
  if (!onStatus) return;
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) return;

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
  } catch {
    /* Progress is a nicety; the load itself will surface any real failure. */
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
async function run(
  input: Blob | ArrayBuffer,
  inputName: string,
  outputName: string,
  options: TranscodeOptions,
  failure: AudioErrorCode
): Promise<Uint8Array> {
  const { args = [], onProgress, onLoadProgress, signal } = options;

  const ff = await loadFFmpeg(onLoadProgress);
  if (signal?.aborted) throw audioError('cancelled');

  const handler = (e: { progress: number }): void => {
    // ffmpeg reports >1 near the end on some builds; clamp so bars behave.
    onProgress?.(Math.min(1, Math.max(0, e.progress)));
  };
  ff.on('progress', handler);

  try {
    const bytes = new Uint8Array(input instanceof ArrayBuffer ? input : await input.arrayBuffer());
    await ff.writeFile(inputName, bytes);
    if (signal?.aborted) throw audioError('cancelled');

    let code: number;
    try {
      code = await ff.exec(['-i', inputName, ...args, outputName]);
    } catch {
      /*
       * A throw here is the wasm itself trapping (libopus overflowing the
       * core's stack was the case that surfaced it), not ffmpeg reporting an
       * error. The trap leaves the core's memory in whatever state it died in,
       * and every later exec on it failed the same way, whatever the format,
       * until the page was reloaded. Dropping the instance means the next
       * export loads a clean one, from the HTTP cache rather than the network.
       */
      releaseFFmpeg();
      throw audioError(failure);
    }
    if (code !== 0) throw audioError(failure);

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
