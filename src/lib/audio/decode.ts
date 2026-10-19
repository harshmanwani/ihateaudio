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
import { describeError } from './diagnose';
import { decodeVia, isFFmpegReady } from './ffmpeg';
import { audioTrack, fourcc, isMp4, mp4AudioTrack, type Mp4AudioTrack } from './mp4';

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

/** Longest file this device can hold, in seconds, at this rate and channel count. */
export function maxDurationSeconds(sampleRate: number, channels: number): number {
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

/** What a container header says the decode will hold. Null where it cannot say. */
export interface AudioFormat {
  rate: number | null;
  channels: number | null;
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
  return readFormat(bytes)?.rate ?? null;
}

/**
 * The rate and channel count from the header at the start of `bytes`, for
 * WAV, FLAC, MP4 and MP3. The memory check needs both: a mono file holds half
 * of what a stereo one does, so it gets twice the minutes.
 */
export function readFormat(bytes: ArrayBuffer): AudioFormat | null {
  const view = new DataView(bytes);
  const len = view.byteLength;
  if (len < 16) return null;

  const validRate = (rate: number) => rate >= 3000 && rate <= 768000;

  // RIFF/WAVE: walk chunks to the "fmt " header.
  if (ascii(view, 0, 4) === 'RIFF' && ascii(view, 8, 4) === 'WAVE') {
    let offset = 12;
    while (offset + 8 <= len) {
      const id = ascii(view, offset, 4);
      const size = view.getUint32(offset + 4, true);
      if (id === 'fmt ' && offset + 16 <= len) {
        const channels = view.getUint16(offset + 10, true);
        const rate = view.getUint32(offset + 12, true);
        return validRate(rate) ? { rate, channels: channels || null } : null;
      }
      offset += 8 + size + (size % 2);
    }
    return null;
  }

  // FLAC: STREAMINFO is always the first metadata block; rate is 20 bits at
  // bit offset 80 of the block body (byte 18 of the file), then 3 bits of
  // channel count minus one.
  if (ascii(view, 0, 4) === 'fLaC' && len > 21) {
    const rate =
      (view.getUint8(18) << 12) | (view.getUint8(19) << 4) | (view.getUint8(20) >> 4);
    const channels = ((view.getUint8(20) >> 1) & 0x07) + 1;
    return validRate(rate) ? { rate, channels } : null;
  }

  // MP4 family (.m4a, .mp4, .mov): the audio track's sample description.
  // Without this every one of them decoded at the device rate, so on a 48 kHz
  // device a 44.1 kHz Apple Lossless file was resampled and stopped being
  // bit-exact, and the converter called its 16 bits more than 16.
  if (isMp4(bytes)) return formatOf(mp4AudioTrack(bytes));

  return scanMpeg(view, id3End(view) ?? 0);
}

function formatOf(track: Mp4AudioTrack | null): AudioFormat | null {
  if (!track) return null;
  // HE-AAC v2 carries one channel and decodes to two, and only the stream
  // itself says whether it does, so an AAC track counts as stereo at least.
  const { channels } = track;
  const aac = track.codec === 'mp4a' && channels !== null;
  return { rate: track.rate, channels: aac ? Math.max(channels, 2) : channels };
}

/** Bytes after the end of an ID3v2 tag that the MPEG frame scan covers. */
const MPEG_SCAN_BYTES = 8192;

/** Where an MP3's frames start when an ID3v2 tag comes first, else null. */
function id3End(view: DataView): number | null {
  if (view.byteLength <= 10 || ascii(view, 0, 3) !== 'ID3') return null;
  const size =
    ((view.getUint8(6) & 0x7f) << 21) |
    ((view.getUint8(7) & 0x7f) << 14) |
    ((view.getUint8(8) & 0x7f) << 7) |
    (view.getUint8(9) & 0x7f);
  return 10 + size;
}

/** MPEG audio: two frame headers in a row, from `start`. */
function scanMpeg(view: DataView, start: number): AudioFormat | null {
  for (let i = start; i < Math.min(view.byteLength - 4, start + MPEG_SCAN_BYTES); i += 1) {
    const frame = mpegFrame(view, i);
    if (!frame) continue;
    /**
     * A single header proves nothing. This scan used to accept the first 0xFFE
     * sync it met in any file, and AAC, MP4, Ogg, WebM and AIFF data all have
     * them: an ADTS AAC header passes outright and reads as 22.05 kHz. The
     * file was then decoded at that rate, so a 44.1 kHz AAC lost everything
     * above 11 kHz in every tool. A real MP3 has another header exactly one
     * frame on, with the same version, layer and rate.
     */
    const next = mpegFrame(view, i + frame.bytes);
    if (next && next.key === frame.key) return { rate: frame.rate, channels: frame.channels };
  }
  return null;
}

function ascii(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

/** The header window readFileFormat takes: any WAV fmt chunk or FLAC STREAMINFO fits. */
const HEADER_BYTES = 64 * 1024;

/**
 * readFormat for a file not read yet. It reads a 64 KB slice, not the whole
 * file, so it can run before the memory check that decides whether to read
 * the rest. Two formats keep their header further in. Cover art can make an
 * MP3's ID3 tag far longer than the window, and the frames start after the
 * tag. An MP4's moov often sits after the media data.
 */
export async function readFileFormat(file: Blob): Promise<AudioFormat | null> {
  try {
    const bytes = await file.slice(0, HEADER_BYTES).arrayBuffer();
    if (isMp4(bytes)) return formatOf(await mp4FileTrack(file));
    const format = readFormat(bytes);
    const tagEnd = id3End(new DataView(bytes));
    if (format || tagEnd === null || tagEnd + MPEG_SCAN_BYTES <= bytes.byteLength) return format;
    // A frame at the far end of the scan still needs the next one; no frame is over 4 KB.
    const frames = await file.slice(tagEnd, tagEnd + MPEG_SCAN_BYTES + 4096).arrayBuffer();
    return scanMpeg(new DataView(frames), 0);
  } catch {
    return null;
  }
}

/** A moov bigger than this is a video's, and not worth reading for a memory check. */
const MOOV_LIMIT = 32 * 1024 * 1024;

/** An MP4's audio track, read box by box from the file: the top-level headers, then the moov. */
async function mp4FileTrack(file: Blob): Promise<Mp4AudioTrack | null> {
  let offset = 0;
  // Top-level boxes are few: ftyp, free, mdat, moov and the odd udta.
  for (let i = 0; i < 32 && offset + 8 <= file.size; i += 1) {
    const view = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
    let size = view.getUint32(0);
    let header = 8;
    if (size === 1 && view.byteLength >= 16) {
      size = view.getUint32(8) * 2 ** 32 + view.getUint32(12);
      header = 16;
    } else if (size === 0) {
      size = file.size - offset;
    }
    if (size < header) return null;
    if (fourcc(view, 4) === 'moov') {
      if (size > MOOV_LIMIT) return null;
      const moov = new DataView(await file.slice(offset, offset + size).arrayBuffer());
      return audioTrack(moov, header, moov.byteLength);
    }
    offset += size;
  }
  return null;
}

const MPEG_KBPS = {
  // [version 1 | 2][layer I, II, III]
  v1: [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ],
  v2: [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
};

/**
 * The MPEG audio frame header at `at`, if there is a valid one: its sample
 * rate and channel count, its length in bytes, and the fields the next frame
 * must repeat.
 *
 * Rejects the reserved layer (which is what ADTS AAC carries), the free and
 * bad bitrate indices, and the reserved version and rate.
 */
function mpegFrame(
  view: DataView,
  at: number
): { rate: number; channels: number; bytes: number; key: number } | null {
  if (at + 4 > view.byteLength || view.getUint8(at) !== 0xff) return null;
  const b1 = view.getUint8(at + 1);
  const b2 = view.getUint8(at + 2);
  if ((b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 0x03;
  const layerBits = (b1 >> 1) & 0x03;
  const bitrateIndex = b2 >> 4;
  const rateBits = (b2 >> 2) & 0x03;
  if (versionBits === 1 || layerBits === 0 || rateBits === 3) return null;
  if (bitrateIndex === 0 || bitrateIndex === 15) return null;

  const base = [44100, 48000, 32000][rateBits]!;
  const rate = versionBits === 3 ? base : versionBits === 2 ? base / 2 : base / 4;
  const layer = 4 - layerBits; // 1, 2 or 3
  const kbps = (versionBits === 3 ? MPEG_KBPS.v1 : MPEG_KBPS.v2)[layer - 1]![bitrateIndex]!;
  const padding = (b2 >> 1) & 0x01;

  let bytes: number;
  if (layer === 1) bytes = (Math.floor((12 * kbps * 1000) / rate) + padding) * 4;
  else if (layer === 3 && versionBits !== 3) bytes = Math.floor((72 * kbps * 1000) / rate) + padding;
  else bytes = Math.floor((144 * kbps * 1000) / rate) + padding;

  // Channel mode 3 is single channel; the other three are all two channels.
  const channels = view.getUint8(at + 3) >> 6 === 3 ? 1 : 2;

  return { rate, channels, bytes, key: ((b1 & 0xfe) << 8) | (b2 & 0x0c) };
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
  /**
   * Called with 0..1 while reading the file off disk. A label comes with it
   * when the work is something other than reading: loading ffmpeg for a
   * codec the browser cannot decode, then decoding with it.
   */
  onProgress?: (ratio: number, label?: string) => void;
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

  const [seconds, format] = await Promise.all([probeDuration(file), readFileFormat(file)]);
  if (signal?.aborted) throw audioError('cancelled');

  if (seconds !== null) {
    assertFits(seconds, nativeRate ? (format?.rate ?? null) : null, format?.channels ?? null);
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
  const track = mp4AudioTrack(bytes);
  if (track?.codec && ENCRYPTED_CODECS.has(track.codec)) throw audioError('drm-protected');
  // A browser that cannot decode the track often cannot read its length
  // either, which skipped the check above for exactly the files that go on
  // to the heavier ffmpeg path.
  if (seconds === null && track?.seconds) {
    assertFits(track.seconds, detected, formatOf(track)?.channels ?? null);
  }

  let buffer: AudioBuffer;
  let viaFFmpeg = false;
  try {
    buffer = await decodeNatively(bytes, detected, file);
  } catch (err) {
    // Chromium and Firefox have no Apple Lossless decoder, and no browser
    // reads every codec an MP4 can carry. ffmpeg does, at the cost of a
    // one-time download, so it gets the files the browser refused.
    if (!track) throw classifyDecodeFailure(err, file);
    if (signal?.aborted) throw audioError('cancelled');
    try {
      // decodeAudioData took the bytes, so ffmpeg gets the file read again.
      const again = await file.arrayBuffer();
      buffer = await decodeWithFFmpeg(again, file, track.codec, nativeRate, onProgress, signal);
      viaFFmpeg = true;
    } catch (ffmpegErr) {
      // What went wrong with ffmpeg itself is worth saying; a file it could
      // not decode either is the same failure the browser reported.
      const failure = toAudioError(ffmpegErr);
      if (failure.code !== 'decode-failed' && failure.code !== 'unknown-error') throw failure;
      throw classifyDecodeFailure(err, file);
    }
  }

  if (signal?.aborted) throw audioError('cancelled');
  if (buffer.length === 0) throw audioError('no-audio-track');

  onProgress?.(1);
  // ffmpeg keeps the file's own rate, which the headers may not have stated.
  const sourceRate = viaFFmpeg && nativeRate ? buffer.sampleRate : detected;
  return { buffer, sourceRate, bytes: file.size };
}

/** Sample entries whose audio is encrypted: iTunes FairPlay, and common encryption. */
const ENCRYPTED_CODECS = new Set(['drms', 'enca']);

/**
 * Refuses a file whose decoded audio would not fit in this device's memory.
 * The decode holds every channel at the rate it decodes to. Without a header
 * to say, assume stereo at 48k: the pessimistic common case.
 */
function assertFits(seconds: number, rate: number | null, channels: number | null): void {
  const limit = maxDurationSeconds(rate ?? 48000, channels ?? 2);
  if (seconds <= limit) return;
  const canHold = Math.floor(limit / 60);
  // Rounding must not make the file read as short as the limit.
  const minutes = Math.max(Math.round(seconds / 60), canHold + 1);
  throw audioError(
    'too-long',
    `This device can hold about ${canHold} minutes of this file at once, and it is ${minutes} minutes long. Split it into shorter parts first.`
  );
}

/**
 * decodeAudioData detaches its input, so a retry reads the file again.
 * Copying the bytes up front for a retry that almost never runs was a task of
 * 60-140 ms on a 54-minute WAV, and another 570 MB held at once.
 */
async function decodeNatively(
  bytes: ArrayBuffer,
  rate: number | null,
  file: Blob
): Promise<AudioBuffer> {
  try {
    return await decodeAt(bytes, rate);
  } catch (err) {
    // A wrong rate guess must never be the reason a file fails to open.
    if (rate === null) throw err;
    return decodeAt(await file.arrayBuffer(), null);
  }
}

const CODEC_NAMES: Record<string, string> = { alac: 'Apple Lossless' };

/**
 * Decodes with ffmpeg.wasm, reporting the download and then the decode.
 * `bytes` is handed to ffmpeg's worker and is unusable afterwards.
 */
function decodeWithFFmpeg(
  bytes: ArrayBuffer,
  file: File | Blob,
  codec: string | null,
  nativeRate: boolean,
  onProgress: DecodeOptions['onProgress'],
  signal: AbortSignal | undefined
): Promise<AudioBuffer> {
  const name = (codec && CODEC_NAMES[codec]) ?? null;
  const decoding = name ? `Decoding ${name}` : 'Decoding';
  if (isFFmpegReady()) onProgress?.(0, decoding);
  // ffmpeg reads the container from the bytes; the extension only names the file.
  const fileName = 'name' in file && typeof file.name === 'string' ? file.name : '';
  const ext = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  return decodeVia(bytes, /^[a-z0-9]{1,5}$/.test(ext) ? ext : 'mp4', {
    // Without a native rate the buffer must match the device, as decodeAudioData's would.
    rate: nativeRate ? undefined : getAudioContext().sampleRate,
    // The load reports 1 once ffmpeg is up, which is when the decode starts.
    onLoadProgress: (ratio) =>
      ratio >= 1
        ? onProgress?.(0, decoding)
        : onProgress?.(ratio, `Loading the ${name ?? 'audio'} decoder (one time, ~10 MB)`),
    onProgress: (ratio) => onProgress?.(ratio, decoding),
    signal,
  });
}

/** Decodes at `rate`, or at the device's rate for null. Detaches `bytes`. */
async function decodeAt(bytes: ArrayBuffer, rate: number | null): Promise<AudioBuffer> {
  const ctx = rate !== null ? new OfflineAudioContext(1, 1, rate) : getAudioContext();

  const buffer = await decodeOn(ctx, bytes);
  // A browser that took the callback path and handed back nothing would
  // otherwise return undefined from here and fail much later, at the first
  // property read on the "buffer", as a null dereference with no useful shape.
  if (!buffer) throw audioError('decode-failed');
  return buffer;
}

/**
 * Safari's older signature is callback-only and returns undefined rather than a
 * promise. Both context types need that treatment: an OfflineAudioContext is
 * not exempt, and the rate-guess path used to assume the promise form purely
 * because it was written second.
 *
 * Safari also calls the error callback with null, before its promise rejects
 * with the real EncodingError, so a failed decode arrived here as null. That
 * matched nothing in toAudioError and became 'unknown-error': every file an
 * iPhone could not decode was reported as one of our own crashes, before the
 * file had even loaded. Measured in WebKit 26.5; Chromium passes the error.
 */
export function decodeOn(ctx: BaseAudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    const fail = (err: unknown): void =>
      reject(err ?? new DOMException('Decoding failed', 'EncodingError'));
    const maybe = ctx.decodeAudioData(bytes, resolve, fail);
    if (maybe && typeof maybe.then === 'function') maybe.then(resolve, fail);
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
      `Browsers can't decode .${ext} directly. Use the audio converter, which loads a fuller decoder on demand.`,
      { input_format: ext, ...describeError(err) }
    );
  }
  const failure = toAudioError(err);
  if (failure.code !== 'decode-failed') return failure;
  // Formats one browser decodes and another does not. Safari has been the
  // gap for Ogg, Opus and WebM audio, which is where WhatsApp voice notes and
  // many downloads come from, and "it may be corrupted" was the wrong advice.
  if (PATCHY.has(ext)) {
    return audioError(
      'unsupported-format',
      `This browser could not decode this .${ext} file. Open it in Chrome or Firefox on a computer, or convert it to MP3 first.`,
      { input_format: ext, ...failure.detail }
    );
  }
  // The type, from a fixed list and never the name, so the reports show which
  // kinds of file fail to decode where.
  failure.detail = { input_format: INPUT_FORMATS.has(ext) ? ext : 'other', ...failure.detail };
  return failure;
}

/** File types whose decoding differs between browsers. */
const PATCHY = new Set(['ogg', 'oga', 'opus', 'webm', 'weba', 'caf', '3gp']);

/** File types the error report may name. Anything else is 'other'. */
const INPUT_FORMATS = new Set([
  'mp3', 'wav', 'm4a', 'aac', 'mp4', 'mov', 'flac', 'ogg', 'oga', 'opus', 'webm', 'weba', 'caf',
  '3gp', 'm4r', 'aif', 'aiff', 'wma', 'amr', 'mkv',
]);
