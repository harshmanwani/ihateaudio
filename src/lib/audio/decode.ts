/**
 * File -> AudioBuffer, with the guards that keep mobile Safari alive.
 *
 * Decoded audio is Float32: sampleRate x channels x 4 bytes per second, so a
 * stereo 44.1kHz file costs ~0.35 MB per second — an hour is 1.2 GB. iOS Safari
 * kills a tab somewhere north of ~250 MB, so we probe duration *before*
 * decoding (cheap, via a media element) and refuse with a real message rather
 * than crashing the tab.
 */
import { audioError, toAudioError } from './errors';

const BYTES_PER_SAMPLE = 4;

/** Conservative decoded-audio ceilings, in bytes. */
function memoryBudget(): number {
  if (typeof navigator === 'undefined') return 512 * 1024 * 1024;

  const ua = navigator.userAgent;
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as Macintosh but has touch points.
    (/Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1);

  if (isIOS) return 180 * 1024 * 1024;
  if (/Android/.test(ua)) return 320 * 1024 * 1024;

  // deviceMemory is Chromium-only and reports whole GB, capped at 8.
  const gb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof gb === 'number' && gb <= 4) return 512 * 1024 * 1024;

  return 1200 * 1024 * 1024;
}

export function estimateDecodedBytes(
  seconds: number,
  channels: number,
  sampleRate: number
): number {
  return Math.ceil(seconds * channels * sampleRate * BYTES_PER_SAMPLE);
}

/** Longest file this device can hold, in seconds, assuming stereo 44.1kHz. */
export function maxDurationSeconds(sampleRate = 44100, channels = 2): number {
  return memoryBudget() / (channels * sampleRate * BYTES_PER_SAMPLE);
}

let sharedContext: AudioContext | null = null;

/**
 * The one AudioContext used for playback. Browsers cap the number of live
 * contexts (Safari at ~4), so tools must share rather than each making one.
 */
export function getAudioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === 'closed') {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    sharedContext = new Ctor();
  }
  return sharedContext;
}

/** Autoplay policy suspends contexts until a gesture; call from a click. */
export async function resumeAudioContext(): Promise<void> {
  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      /* Resuming can reject if the gesture was consumed; playback retries. */
    }
  }
}

/**
 * Reads the native sample rate straight out of the container header.
 *
 * decodeAudioData resamples to the context's rate, so decoding a 44.1kHz file
 * on a 48kHz device and exporting back to 44.1kHz resamples twice for no
 * reason. Detecting the rate up front lets us decode at the file's own rate.
 * Returns null when the format isn't one we can cheaply parse.
 */
export function detectSampleRate(bytes: ArrayBuffer): number | null {
  const view = new DataView(bytes);
  const len = view.byteLength;
  if (len < 16) return null;

  const ascii = (offset: number, length: number): string => {
    let out = '';
    for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
    return out;
  };

  // RIFF/WAVE: walk chunks to the "fmt " header.
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') {
    let offset = 12;
    while (offset + 8 <= len) {
      const id = ascii(offset, 4);
      const size = view.getUint32(offset + 4, true);
      if (id === 'fmt ' && offset + 12 <= len) {
        const rate = view.getUint32(offset + 12, true);
        return rate >= 3000 && rate <= 768000 ? rate : null;
      }
      offset += 8 + size + (size % 2);
    }
    return null;
  }

  // FLAC: STREAMINFO is always the first metadata block; rate is 20 bits at
  // bit offset 80 of the block body (byte 18 of the file).
  if (ascii(0, 4) === 'fLaC' && len > 21) {
    const rate =
      (view.getUint8(18) << 12) | (view.getUint8(19) << 4) | (view.getUint8(20) >> 4);
    return rate >= 3000 && rate <= 768000 ? rate : null;
  }

  // MPEG audio: skip an ID3v2 tag, then read the first frame header.
  let start = 0;
  if (ascii(0, 3) === 'ID3' && len > 10) {
    const size =
      ((view.getUint8(6) & 0x7f) << 21) |
      ((view.getUint8(7) & 0x7f) << 14) |
      ((view.getUint8(8) & 0x7f) << 7) |
      (view.getUint8(9) & 0x7f);
    start = 10 + size;
  }
  for (let i = start; i < Math.min(len - 4, start + 8192); i += 1) {
    if (view.getUint8(i) !== 0xff) continue;
    const b1 = view.getUint8(i + 1);
    if ((b1 & 0xe0) !== 0xe0) continue;
    const versionBits = (b1 >> 3) & 0x03;
    if (versionBits === 1) continue; // reserved
    const rateBits = (view.getUint8(i + 2) >> 2) & 0x03;
    if (rateBits === 3) continue; // reserved
    const base = [44100, 48000, 32000][rateBits];
    if (versionBits === 3) return base; // MPEG-1
    if (versionBits === 2) return base / 2; // MPEG-2
    return base / 4; // MPEG-2.5
  }

  return null;
}

/**
 * Duration without decoding. A media element parses just the header, which
 * costs kilobytes instead of the gigabyte a full decode would.
 * Returns null if the browser can't read it (we then let decode try anyway).
 */
export function probeDuration(file: Blob): Promise<number | null> {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const el = document.createElement('audio');
    const url = URL.createObjectURL(file);
    let settled = false;

    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeAttribute('src');
      el.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };

    // Some containers never fire loadedmetadata in some browsers.
    const timer = setTimeout(() => finish(null), 4000);

    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      const d = el.duration;
      finish(Number.isFinite(d) && d > 0 ? d : null);
    };
    el.onerror = () => finish(null);
    el.src = url;
  });
}

export interface DecodeOptions {
  /** Preserve the file's own sample rate instead of the device's. Default true. */
  nativeRate?: boolean;
  /** Called with 0..1 while reading the file off disk. */
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

export interface DecodedAudio {
  buffer: AudioBuffer;
  /** Sample rate the file declared, when we could read it. */
  sourceRate: number | null;
  bytes: number;
}

/**
 * The single entry point every tool uses to turn a dropped file into audio.
 */
export async function decodeFile(
  file: File | Blob,
  options: DecodeOptions = {}
): Promise<DecodedAudio> {
  const { nativeRate = true, onProgress, signal } = options;

  if (file.size === 0) throw audioError('empty-file');

  // Refuse absurd inputs before spending time reading them. 2 GB of compressed
  // audio decodes to far more than any browser can hold.
  if (file.size > 2 * 1024 * 1024 * 1024) throw audioError('too-large');

  const seconds = await probeDuration(file);
  if (signal?.aborted) throw audioError('cancelled');

  if (seconds !== null) {
    // Assume stereo at 48k for the estimate; it is the pessimistic common case.
    const needed = estimateDecodedBytes(seconds, 2, 48000);
    if (needed > memoryBudget()) {
      throw audioError(
        'too-long',
        `This device can hold about ${Math.floor(maxDurationSeconds() / 60)} minutes of audio at once, and that file is ${Math.round(seconds / 60)} minutes. Split it into shorter parts first.`
      );
    }
  }

  onProgress?.(0.1);
  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (err) {
    throw toAudioError(err);
  }
  if (signal?.aborted) throw audioError('cancelled');
  onProgress?.(0.5);

  const detected = nativeRate ? detectSampleRate(bytes) : null;

  let buffer: AudioBuffer;
  try {
    buffer = await decodeAt(bytes, detected);
  } catch (err) {
    if (detected !== null) {
      // A wrong rate guess must never be the reason a file fails to open.
      try {
        buffer = await decodeAt(bytes, null);
      } catch (retryErr) {
        throw classifyDecodeFailure(retryErr, file);
      }
    } else {
      throw classifyDecodeFailure(err, file);
    }
  }

  if (signal?.aborted) throw audioError('cancelled');
  if (buffer.length === 0) throw audioError('no-audio-track');

  onProgress?.(1);
  return { buffer, sourceRate: detected, bytes: file.size };
}

async function decodeAt(bytes: ArrayBuffer, rate: number | null): Promise<AudioBuffer> {
  // decodeAudioData detaches the input, so hand each attempt its own copy.
  const copy = bytes.slice(0);

  if (rate !== null) {
    const offline = new OfflineAudioContext(1, 1, rate);
    return offline.decodeAudioData(copy);
  }

  const ctx = getAudioContext();
  // Safari's older signature is callback-only; the promise form is absent.
  return new Promise<AudioBuffer>((resolve, reject) => {
    const maybe = ctx.decodeAudioData(copy, resolve, reject);
    if (maybe && typeof maybe.then === 'function') maybe.then(resolve, reject);
  });
}

function classifyDecodeFailure(err: unknown, file: File | Blob): Error {
  const name = 'name' in file && typeof file.name === 'string' ? file.name : '';
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();

  // Purchased iTunes tracks are .m4p, or .m4a with a protected codec.
  if (ext === 'm4p' || ext === 'aax' || ext === 'aa') {
    return audioError('drm-protected');
  }
  // Formats no browser decodes natively — these need the ffmpeg path.
  if (['wma', 'aiff', 'aif', 'amr', 'ape', 'ac3', 'dts'].includes(ext)) {
    return audioError(
      'unsupported-format',
      `Browsers can't decode .${ext} directly. Use the audio converter, which loads a fuller decoder on demand.`
    );
  }
  return toAudioError(err);
}
