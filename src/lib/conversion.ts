/**
 * Drives ConversionPanel.astro.
 *
 * The interesting judgement here is the verdict line: telling someone that
 * re-encoding a 128 kbps MP3 to 320 kbps MP3 makes the file bigger without
 * making it better is the single most useful thing a converter can say, and no
 * other free converter says it.
 */
import type { ToolRuntime } from './tool';
import { formatById, estimateSize, outputSampleRate, writtenKbps } from './audio/export';
import { fitsIn16Bits, type WavBitDepth } from './audio/encode-wav';
import { filesize, duration, extensionOf, sampleRateLabel, channelLabel } from './format';

/** Formats whose data has already been through a lossy encoder. */
const LOSSY_EXTENSIONS = new Set([
  'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'amr', 'm4b', 'weba', 'webm',
  'mp4', 'mov', 'mkv', 'avi', '3gp',
]);

/**
 * Sample-entry codes for audio an MP4-family file holds without loss, and
 * what to call it. An .m4a holds Apple Lossless as readily as AAC, so the
 * extension alone cannot say whether the audio has been through a lossy
 * encoder; the track's sample description can.
 */
const LOSSLESS_MP4_CODECS = new Map([
  ['alac', 'Apple Lossless'],
  ['fLaC', 'FLAC'],
  ...['lpcm', 'ipcm', 'fpcm', 'sowt', 'twos', 'in24', 'in32', 'fl32', 'fl64'].map(
    (code) => [code, 'PCM'] as const
  ),
]);

interface Verdict {
  kind: 'info' | 'warn';
  title: string;
  body: string;
}

/** Containers whose size is mostly picture, so size over time says nothing about the audio. */
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'mkv', 'avi', '3gp']);

/** The ISO-BMFF family, whose audio track can be measured exactly. */
const MP4_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', '3gp', 'm4a', 'm4b']);

/**
 * Past this a figure from size over time cannot be the audio alone: no lossy
 * codec anyone sends runs higher. It catches a video in a container this file
 * does not parse, such as a WebM with a picture in it.
 */
const MAX_AUDIO_KBPS = 512;

/**
 * Estimates the source's bitrate from its size and duration. Approximate —
 * container overhead and tags are included — but close enough to tell a 128
 * from a 320, as long as the file holds nothing but audio.
 */
function sourceBitrate(bytes: number, seconds: number): number | null {
  if (seconds <= 0) return null;
  const kbps = Math.round((bytes * 8) / seconds / 1000);
  return kbps > MAX_AUDIO_KBPS ? null : kbps;
}

export interface Mp4Audio {
  /** The sample entry's four-character code: 'mp4a' for AAC, 'alac' for Apple Lossless. */
  codec: string | null;
  /** The track's average bitrate, or null when the sample table cannot give it. */
  kbps: number | null;
}

/**
 * The audio track of an MP4-family file: its codec, from the sample
 * description, and its bitrate, read from the sample table rather than
 * guessed from the file size.
 *
 * Size over time is fine for an audio file, but in a video it counts the
 * picture too: a 720p clip carrying 128 kbps AAC read as "about 3273 kbps",
 * which made the warning about re-encoding at a higher bitrate impossible to
 * trigger. The sample size table (stsz) lists every audio frame and the media
 * header (mdhd) the track's own length, so the division is exact. The bitrate
 * is null for fragmented files, which keep their sizes in per-fragment tables
 * instead, and the whole answer null for anything unreadable.
 */
export async function mp4Audio(file: Blob): Promise<Mp4Audio | null> {
  try {
    let offset = 0;
    for (let guard = 0; guard < 512 && offset + 8 <= file.size; guard += 1) {
      const head = new DataView(await file.slice(offset, offset + 16).arrayBuffer());
      let size = head.getUint32(0);
      const type = fourcc(head, 4);
      let header = 8;
      if (size === 1 && head.byteLength >= 16) {
        size = head.getUint32(8) * 2 ** 32 + head.getUint32(12);
        header = 16;
      } else if (size === 0) {
        size = file.size - offset;
      }
      if (size < header) return null;
      if (type === 'moov') {
        // A moov this large is a damaged file, not a long one.
        if (size > 64 * 1024 * 1024) return null;
        const view = new DataView(await file.slice(offset + header, offset + size).arrayBuffer());
        return soundTrack(view);
      }
      offset += size;
    }
  } catch {
    /* Unreadable is the same as unknown. */
  }
  return null;
}

function fourcc(view: DataView, at: number): string {
  let out = '';
  for (let i = 0; i < 4; i += 1) out += String.fromCharCode(view.getUint8(at + i));
  return out;
}

/** The direct children of a box payload spanning [start, end). */
function boxes(view: DataView, start: number, end: number): { type: string; at: number; end: number }[] {
  const out: { type: string; at: number; end: number }[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    let header = 8;
    if (size === 1 && offset + 16 <= end) {
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) break;
    out.push({ type: fourcc(view, offset + 4), at: offset + header, end: offset + size });
    offset += size;
  }
  return out;
}

function soundTrack(moov: DataView): Mp4Audio | null {
  const child = (at: number, end: number, type: string) =>
    boxes(moov, at, end).find((box) => box.type === type);

  for (const trak of boxes(moov, 0, moov.byteLength)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(trak.at, trak.end, 'mdia');
    if (!mdia) continue;
    const hdlr = child(mdia.at, mdia.end, 'hdlr');
    if (!hdlr || fourcc(moov, hdlr.at + 8) !== 'soun') continue;

    const mdhd = child(mdia.at, mdia.end, 'mdhd');
    const stbl = (() => {
      const minf = child(mdia.at, mdia.end, 'minf');
      return minf ? child(minf.at, minf.end, 'stbl') : undefined;
    })();
    const stsz = stbl ? child(stbl.at, stbl.end, 'stsz') : undefined;
    // stsd: version and flags, an entry count, then the first entry's size
    // and its type, which names the codec.
    const stsd = stbl ? child(stbl.at, stbl.end, 'stsd') : undefined;
    const codec = stsd && stsd.at + 16 <= stsd.end ? fourcc(moov, stsd.at + 12) : null;
    if (!mdhd || !stsz) return { codec, kbps: null };

    const v1 = moov.getUint8(mdhd.at) === 1;
    const timescale = moov.getUint32(mdhd.at + (v1 ? 20 : 12));
    const length = v1
      ? moov.getUint32(mdhd.at + 24) * 2 ** 32 + moov.getUint32(mdhd.at + 28)
      : moov.getUint32(mdhd.at + 16);
    const seconds = timescale > 0 ? length / timescale : 0;

    const fixed = moov.getUint32(stsz.at + 4);
    const count = moov.getUint32(stsz.at + 8);
    let bytes = fixed * count;
    if (fixed === 0) {
      if (stsz.at + 12 + count * 4 > stsz.end) return { codec, kbps: null };
      for (let i = 0; i < count; i += 1) bytes += moov.getUint32(stsz.at + 12 + i * 4);
    }

    if (count === 0 || seconds <= 0) return { codec, kbps: null };
    return { codec, kbps: Math.round((bytes * 8) / seconds / 1000) };
  }
  return null;
}

/**
 * Whether a source has been through a lossy encoder: from its codec when the
 * container names one, from its extension otherwise.
 */
export function isLossySource(extension: string, codec: string | null = null): boolean {
  if (codec !== null && MP4_EXTENSIONS.has(extension)) return !LOSSLESS_MP4_CODECS.has(codec);
  return LOSSY_EXTENSIONS.has(extension);
}

/** Measured once per file; the panel re-renders when the answer lands. */
const measured = new WeakMap<File, Mp4Audio | null>();
const measuring = new WeakSet<File>();

/** Whether a buffer holds more than 16 bits, worked out once per buffer. */
const deep = new WeakMap<AudioBuffer, boolean>();

function deeperThan16(buffer: AudioBuffer): boolean {
  let answer = deep.get(buffer);
  if (answer === undefined) {
    answer = !fitsIn16Bits(buffer);
    deep.set(buffer, answer);
  }
  return answer;
}

/** The WAV/FLAC depth the runtime will write: 16 unless the page asks. */
function depthOf(runtime: ToolRuntime): WavBitDepth {
  const raw = Number(runtime.text('bitdepth'));
  return raw === 24 || raw === 32 ? raw : 16;
}

function verdictFor(
  sourceLossy: boolean,
  sourceKbps: number | null,
  targetId: string,
  targetKbps: number,
  /** True when the source holds more bits than the lossless output will. */
  narrowed = false
): Verdict | null {
  const target = formatById(targetId);

  if (!sourceLossy && !target.lossy && narrowed) {
    return {
      kind: 'info',
      title: 'Lossless at 16 bits.',
      body: 'Your source carries more than 16 bits per sample, and this output keeps 16. That is CD resolution and past what anyone can hear, but it is not a bit-for-bit copy of the original.',
    };
  }

  if (!sourceLossy && !target.lossy) {
    return {
      kind: 'info',
      title: 'Lossless the whole way through.',
      body: 'Your source is uncompressed or losslessly compressed, and so is the output. Nothing is discarded.',
    };
  }

  if (!sourceLossy && target.lossy) {
    return {
      kind: 'info',
      title: 'One lossy encode, from a clean source.',
      body: `This is the ideal case: the encoder is working from full-quality audio, so ${targetKbps} kbps buys you the best quality that bitrate can hold.`,
    };
  }

  if (sourceLossy && !target.lossy) {
    return {
      kind: 'warn',
      title: 'This will not improve the audio.',
      body: `A lossless copy of an already-compressed file preserves exactly what is there — including what the first encoder threw away — at several times the size. Convert to ${target.label} only if a specific tool or device requires it.`,
    };
  }

  // Lossy to lossy: the case where the advice actually matters.
  if (sourceKbps !== null && targetKbps > sourceKbps * 1.15) {
    return {
      kind: 'warn',
      title: 'A higher bitrate cannot recover what is gone.',
      body: `Your source is roughly ${sourceKbps} kbps. Encoding at ${targetKbps} kbps makes the file bigger without making it sound better. Match the source, or go lower if you want it smaller.`,
    };
  }

  return {
    kind: 'warn',
    title: 'Second-generation encode.',
    body: 'Your source is already compressed, so this re-encode loses a little more, the way a photocopy of a photocopy does. At 192 kbps and above one extra pass is inaudible to almost everyone.',
  };
}

/**
 * Wires the panel to a tool runtime. Call once from `onReady`; it re-renders
 * itself on every subsequent format or quality change.
 */
export function wireConversionPanel(runtime: ToolRuntime): void {
  const root = runtime.root;
  const panel = root.querySelector<HTMLElement>('[data-convert]');
  if (!panel) return;

  const set = (selector: string, value: string): void => {
    const el = panel.querySelector(selector);
    if (el) el.textContent = value;
  };

  const render = (): void => {
    const buffer = runtime.getBuffer();
    const file = runtime.getFile();
    if (!buffer || !file) return;

    const sourceExt = extensionOf(file.name) || 'audio';
    const targetId = runtime.getFormat();
    const target = formatById(targetId);
    const asked = runtime.getBitrate();
    const depth = depthOf(runtime);
    const rate = buffer.sampleRate;
    const channels = buffer.numberOfChannels;
    // What the encoder will really write, which below 32 kHz is often less
    // than what was asked for: MP3 tops out at 160 kbps there, AAC sooner,
    // Vorbis at 100 kbps for 16 kHz mono. Vorbis also has a floor, so 64 kbps
    // of 5.1 at 48 kHz is written at 84.
    const targetKbps = target.lossy ? writtenKbps(targetId, asked, rate, channels) : asked;

    if (MP4_EXTENSIONS.has(sourceExt) && !measured.has(file) && !measuring.has(file)) {
      measuring.add(file);
      void mp4Audio(file).then((value) => {
        measured.set(file, value);
        if (runtime.getFile() === file) render();
      });
    }

    // A video's size is mostly picture, so without a measurement its audio
    // bitrate is unknown rather than file size over time.
    const probe = measured.get(file);
    const kbps =
      typeof probe?.kbps === 'number'
        ? probe.kbps
        : VIDEO_EXTENSIONS.has(sourceExt)
          ? null
          : sourceBitrate(file.size, buffer.duration);
    const codec = probe?.codec ?? null;
    const sourceIsLossy = isLossySource(sourceExt, codec);
    const lossless = codec === null ? undefined : LOSSLESS_MP4_CODECS.get(codec);

    set('[data-src-format]', sourceIsLossy && kbps
      ? `${sourceExt.toUpperCase()} · about ${kbps} kbps`
      : lossless
        ? `${sourceExt.toUpperCase()} · ${lossless}`
        : sourceExt.toUpperCase());
    set('[data-src-length]', duration(buffer.duration));
    set('[data-src-rate]', sampleRateLabel(buffer.sampleRate));
    set('[data-src-channels]', channelLabel(buffer.numberOfChannels));
    set('[data-src-size]', filesize(file.size));

    // FLAC follows the WAV depth; AIFF is always written at 16 bits.
    const bits = targetId === 'aiff' ? 16 : targetId === 'flac' && depth === 32 ? 24 : depth;
    const approx = targetId === 'mp3' ? '' : 'about ';
    set('[data-out-format]', target.lossy
      ? targetKbps < asked
        ? `${target.label} · ${approx}${targetKbps} kbps, the most it writes at this rate`
        : targetKbps > asked
          ? `${target.label} · ${approx}${targetKbps} kbps, the least it writes for this file`
          : `${target.label} · ${targetKbps} kbps`
      : `${target.label} · lossless, ${bits === 32 ? '32-bit float' : `${bits}-bit`}`);
    // Conversion never changes duration or channel layout on these pages. The
    // rate can change: MP3 drops it at low bitrates, Opus is always 48 kHz,
    // and Vorbis past 50 kHz is 48 kHz too.
    set('[data-out-length]', duration(buffer.duration));
    set('[data-out-rate]', sampleRateLabel(outputSampleRate(targetId, rate, asked, channels)));
    set('[data-out-channels]', channelLabel(channels));

    const outBytes = estimateSize(buffer, targetId, { bitrate: asked, bitDepth: depth });
    const delta = file.size > 0 ? Math.round(((outBytes - file.size) / file.size) * 100) : 0;
    const change =
      Math.abs(delta) < 3
        ? 'about the same'
        : delta > 0
          ? `${delta}% larger`
          : `${Math.abs(delta)}% smaller`;
    set('[data-out-size]', `${filesize(outBytes)} · ${change}`);

    const narrowed = !target.lossy && bits === 16 && !sourceIsLossy && deeperThan16(buffer);
    const verdict = verdictFor(sourceIsLossy, kbps, targetId, targetKbps, narrowed);
    const slot = panel.querySelector<HTMLElement>('[data-convert-verdict]');
    if (!slot) return;

    if (!verdict) {
      slot.innerHTML = '';
      return;
    }

    slot.innerHTML = `<div class="note note--${verdict.kind}">
        <div class="note__body">
          <div class="note__title" data-t></div><div data-b></div>
        </div>
      </div>`;
    const title = slot.querySelector('[data-t]');
    const body = slot.querySelector('[data-b]');
    if (title) title.textContent = verdict.title;
    if (body) body.textContent = verdict.body;
  };

  render();
  root.addEventListener('formatchange', render);
  // Quality lives in the shared export bar, which does not re-dispatch.
  root.querySelector('[data-quality]')?.addEventListener('change', render);
}
