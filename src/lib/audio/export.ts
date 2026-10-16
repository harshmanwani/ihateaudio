/**
 * The tier router. Every tool exports through here.
 *
 * Deciding the tier per *format* rather than per *tool* is what makes the site
 * fast: trimming an MP3 and saving it back never touches ffmpeg, so the common
 * path stays at ~110 KB instead of 31 MB. Only a genuinely non-native output
 * format escalates.
 */
import { encodeWav, wavSize, type WavBitDepth } from './encode-wav';
import { encodeMp3, mp3Size, nearestMp3Rate, type Mp3Bitrate } from './encode-mp3';
import { encodeVia } from './ffmpeg';
import { audioError } from './errors';

export type ExportTier = 0 | 1 | 2;

export interface FormatSpec {
  id: string;
  label: string;
  extension: string;
  mime: string;
  tier: ExportTier;
  lossy: boolean;
  /** One line explaining when to pick this, shown in the format select's help. */
  note: string;
}

export const FORMATS: FormatSpec[] = [
  {
    id: 'mp3',
    label: 'MP3',
    extension: 'mp3',
    mime: 'audio/mpeg',
    tier: 1,
    lossy: true,
    note: 'Plays everywhere. The safe default.',
  },
  {
    id: 'wav',
    label: 'WAV',
    extension: 'wav',
    mime: 'audio/wav',
    tier: 0,
    lossy: false,
    note: 'Lossless and instant, but large.',
  },
  {
    id: 'm4a',
    label: 'M4A (AAC)',
    extension: 'm4a',
    mime: 'audio/mp4',
    tier: 2,
    lossy: true,
    note: 'Better quality than MP3 at the same size. Apple default.',
  },
  {
    id: 'ogg',
    label: 'OGG Vorbis',
    extension: 'ogg',
    mime: 'audio/ogg',
    tier: 2,
    lossy: true,
    note: 'Open format, common in games and on Android.',
  },
  {
    id: 'opus',
    label: 'Opus',
    extension: 'opus',
    mime: 'audio/ogg',
    tier: 2,
    lossy: true,
    note: 'Best quality per byte, especially for speech.',
  },
  {
    id: 'flac',
    label: 'FLAC',
    extension: 'flac',
    mime: 'audio/flac',
    tier: 2,
    lossy: false,
    note: 'Lossless but compressed — about half the size of WAV.',
  },
  {
    id: 'aac',
    label: 'AAC',
    extension: 'aac',
    mime: 'audio/aac',
    tier: 2,
    lossy: true,
    note: 'Raw AAC stream. Use M4A unless you need this specifically.',
  },
  {
    id: 'aiff',
    label: 'AIFF',
    extension: 'aiff',
    mime: 'audio/aiff',
    tier: 2,
    lossy: false,
    note: 'Lossless. The Mac equivalent of WAV.',
  },
  {
    id: 'wma',
    label: 'WMA',
    extension: 'wma',
    mime: 'audio/x-ms-wma',
    tier: 2,
    lossy: true,
    note: 'Legacy Windows format. Only for old devices.',
  },
  {
    id: 'm4r',
    label: 'M4R (iPhone ringtone)',
    extension: 'm4r',
    mime: 'audio/mp4',
    tier: 2,
    lossy: true,
    note: 'The only format iPhone accepts as a ringtone.',
  },
];

export const FORMATS_BY_ID = new Map(FORMATS.map((f) => [f.id, f]));

export function formatById(id: string): FormatSpec {
  const found = FORMATS_BY_ID.get(id);
  if (!found) throw audioError('encode-failed', `Unknown output format "${id}".`);
  return found;
}

export interface ExportOptions {
  /** MP3 and other lossy formats. Ignored for WAV/FLAC. */
  bitrate?: number;
  /**
   * WAV, and FLAC, which stores 16 bits unless 24 or 32 is asked for (32
   * becomes 24, since FLAC has no floating-point mode).
   */
  bitDepth?: WavBitDepth;
  onProgress?: (ratio: number) => void;
  /** Fired separately while the 31 MB ffmpeg core downloads. */
  onEngineLoad?: (ratio: number) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  format: FormatSpec;
  filename?: string;
}

/** Encodes to the requested format via the cheapest engine that can do it. */
export async function exportAudio(
  buffer: AudioBuffer,
  formatId: string,
  options: ExportOptions = {}
): Promise<Blob> {
  const format = formatById(formatId);
  const { bitrate = 192, bitDepth = 16, onProgress, onEngineLoad, signal } = options;

  if (signal?.aborted) throw audioError('cancelled');

  switch (format.tier) {
    case 0: {
      const blob = encodeWav(buffer, { bitDepth });
      onProgress?.(1);
      return blob;
    }

    case 1:
      return encodeMp3(buffer, {
        bitrate: bitrate as Mp3Bitrate,
        onProgress,
        signal,
      });

    default: {
      const depth = losslessDepth(format.id, bitDepth);
      return encodeVia(buffer, format.extension, {
        args: ffmpegArgsFor(format, bitrate, buffer.sampleRate, buffer.numberOfChannels, depth),
        bitDepth: depth ?? 24,
        onProgress,
        onLoadProgress: onEngineLoad,
        signal,
      });
    }
  }
}

/**
 * The bit depth a lossless ffmpeg format stores, or null for a lossy one.
 *
 * FLAC defaults to 16 bits, like WAV does, so that a FLAC made from a 16-bit
 * file is the roughly-half-a-WAV the format promises rather than a 24-bit
 * file 50% larger with nothing extra in it. AIFF is written as 16-bit PCM.
 */
function losslessDepth(formatId: string, bitDepth: WavBitDepth): 16 | 24 | null {
  if (formatId === 'flac') return bitDepth === 16 ? 16 : 24;
  if (formatId === 'aiff') return 16;
  return null;
}

function ffmpegArgsFor(
  format: FormatSpec,
  bitrate: number,
  sampleRate: number,
  channels: number,
  depth: 16 | 24 | null
): string[] {
  switch (format.id) {
    case 'm4a':
    case 'm4r':
      // M4R is an M4A with a different extension; iOS only checks the extension.
      return ['-c:a', 'aac', '-b:a', `${bitrate}k`, '-f', 'mp4'];
    case 'aac':
      return ['-c:a', 'aac', '-b:a', `${bitrate}k`];
    case 'ogg': {
      /*
       * libvorbis refuses a bitrate outside its range for the rate and width,
       * and has no bitrate mode at all past 50 kHz; see vorbisRange.
       *
       * No -maxrate. It switches on libvorbis's rate management, which holds
       * the bitrate to within 1-7%, but it encoded 3 to 8 times slower:
       * 7.3-8 s a minute of 64 kbps stereo, against about 1. The send
       * tools encode long files at low rates, so that cost more time than
       * the extra passes it would save. The overshoot is costed instead; see
       * vorbisOvershoot.
       */
      const rate = vorbisRate(sampleRate);
      return [
        '-c:a',
        'libvorbis',
        ...(rate === sampleRate ? [] : ['-ar', String(rate)]),
        '-b:a',
        `${vorbisKbps(bitrate, sampleRate, channels)}k`,
      ];
    }
    case 'opus':
      /*
       * Constrained VBR, because libopus's default unconstrained VBR treats
       * the bitrate as a loose average: speech at 64k came out at 81 kbps and
       * dense music at 128k at 147, which broke every size promise the send
       * tools make. Constrained lands within 1-3% of the request.
       *
       * 10 ms frames for anything wider than mono, because the stereo encoder
       * at its default 20 ms overflows the stack of @ffmpeg/core 0.12.10 and
       * the wasm traps ("memory access out of bounds") on the first frame, for
       * every stereo file. Halving the frame halves the per-frame buffers back
       * to what the mono path uses, which fits. The other way out, complexity
       * 4, keeps 20 ms frames but switches off the pitch pre-filter and the
       * tonality analysis, libopus's main tools for music; a 10 ms frame keeps
       * both and pays in coding efficiency instead, a few percent of bitrate.
       */
      return [
        '-c:a',
        'libopus',
        '-b:a',
        `${bitrate}k`,
        '-vbr',
        'constrained',
        ...(channels > 1 ? ['-frame_duration', '10'] : []),
      ];
    case 'flac':
      // The WAV handed over already has this depth; naming the sample format
      // as well keeps ffmpeg from widening it on its own.
      return [
        '-c:a',
        'flac',
        '-compression_level',
        '5',
        '-sample_fmt',
        depth === 24 ? 's32' : 's16',
      ];
    case 'aiff':
      return ['-c:a', 'pcm_s16be'];
    case 'wma':
      return ['-c:a', 'wmav2', '-b:a', `${bitrate}k`];
    default:
      return [];
  }
}

/**
 * What lamejs actually writes for a requested MP3 bitrate.
 *
 * Two of its decisions are invisible from outside. Below 32 kHz the MPEG-2
 * and MPEG-2.5 tables top out at 160 and 64 kbps, so asking for 320 at
 * 22.05 kHz gets 160, and a file half the predicted size. And when it is not
 * told an output rate it picks one from the lowpass it intends to use, so 64
 * kbps stereo from a 44.1 kHz source comes out at 24 kHz and 96 kbps at
 * 32 kHz. This mirrors lame_init_params (optimum_bandwidth,
 * optimum_samplefreq, FindNearestBitrate) for the constant-bitrate encoder
 * encode-mp3 sets up.
 */
export function mp3Output(
  sampleRate: number,
  bitrate: number,
  channels: number
): { sampleRate: number; bitrate: number } {
  // encode-mp3 resamples to the nearest legal rate before lamejs sees it.
  const input = nearestMp3Rate(sampleRate);

  // optimum_bandwidth: the lowpass that goes with the nearest table bitrate.
  // Mono gets half again, having only one channel to spend the bits on.
  let index = MP3_LOWPASS.length - 1;
  for (let i = 0; i < MP3_LOWPASS.length - 1; i += 1) {
    const [low] = MP3_LOWPASS[i]!;
    const [high] = MP3_LOWPASS[i + 1]!;
    if (high > bitrate) {
      index = high - bitrate > bitrate - low ? i : i + 1;
      break;
    }
  }
  let lowpass = MP3_LOWPASS[index]![1] * (channels === 1 ? 1.5 : 1);
  if (2 * lowpass > input) lowpass = input / 2;

  // optimum_samplefreq: the lowest rate that still carries that lowpass,
  // never above the input.
  let rate = MP3_RATES_DOWN.find((candidate) => candidate <= input) ?? 8000;
  for (const [ceiling, candidate] of MP3_RATE_FOR_LOWPASS) {
    if (lowpass <= ceiling) rate = candidate;
  }
  if (input < rate) rate = MP3_RATES_UP.find((candidate) => candidate >= input) ?? input;

  // FindNearestBitrate in the table for that rate's MPEG version. Ties go to
  // the lower rate, as LAME's strict comparison does.
  const table = rate >= 32000 ? MP3_MPEG1 : rate >= 16000 ? MP3_MPEG2 : MP3_MPEG25;
  let nearest = table[0]!;
  for (const candidate of table) {
    if (Math.abs(candidate - bitrate) < Math.abs(nearest - bitrate)) nearest = candidate;
  }
  return { sampleRate: rate, bitrate: nearest };
}

const MP3_LOWPASS: [number, number][] = [
  [8, 2000], [16, 3700], [24, 3900], [32, 5500], [40, 7000], [48, 7500],
  [56, 10000], [64, 11000], [80, 13500], [96, 15100], [112, 15600],
  [128, 17000], [160, 17500], [192, 18600], [224, 19400], [256, 19700],
  [320, 20500],
];
/** [highest lowpass, rate], applied in order so the last match wins. */
const MP3_RATE_FOR_LOWPASS: [number, number][] = [
  [15960, 44100], [15250, 32000], [11220, 24000], [9970, 22050],
  [7230, 16000], [5420, 12000], [4510, 11025], [3970, 8000],
];
const MP3_RATES_DOWN = [48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
const MP3_RATES_UP = [...MP3_RATES_DOWN].reverse();
const MP3_MPEG1 = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_MPEG2 = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_MPEG25 = [8, 16, 24, 32, 40, 48, 56, 64];

/**
 * The rate a Vorbis file is written at. libvorbis's bitrate mode only has
 * setups for 8 to 50 kHz; above that every bitrate is refused, so a 96 kHz
 * file is resampled to 48 kHz, and the rare file below 8 kHz up to 8 kHz.
 */
export function vorbisRate(sampleRate: number): number {
  if (sampleRate > 50000) return 48000;
  if (sampleRate < 8000) return 8000;
  return sampleRate;
}

/**
 * [lowest rate, kbps per channel low and high, stereo kbps low and high,
 * overshoot above 24 kbps a channel and at or below it], highest band first.
 */
const VORBIS_BANDS: [number, number, number, number, number, number, number][] = [
  [40000, 32, 240, 45, 500, 1.28, 1.28],
  [26000, 30, 190, 36, 380, 1.31, 1.47],
  [19000, 16, 90, 30, 180, 1.32, 1.64],
  [15000, 16, 100, 24, 200, 1.06, 1.28],
  [9000, 12, 50, 16, 100, 1.12, 1.45],
  [8000, 8, 42, 12, 84, 1.11, 1.42],
];

function vorbisBand(sampleRate: number): (typeof VORBIS_BANDS)[number] {
  const rate = vorbisRate(sampleRate);
  return VORBIS_BANDS.find(([from]) => rate >= from) ?? VORBIS_BANDS[VORBIS_BANDS.length - 1]!;
}

/**
 * The bitrates, in kbps, libvorbis will open at for this rate and width.
 *
 * Outside them ffmpeg fails to open the encoder and writes nothing: 128 kbps
 * mono at 16 kHz, where the most it takes is 100, was an export that simply
 * failed. Each band is one of libvorbis's setup templates, whose limits are
 * per channel; stereo also has a coupled template reaching lower, and 5.1 at
 * 40 to 50 kHz its own. Measured edge by edge, to the kbps, on the
 * @ffmpeg/core 0.12.10 build the site ships.
 */
export function vorbisRange(sampleRate: number, channels: number): [number, number] {
  const [from, low, high, stereoLow, stereoHigh] = vorbisBand(sampleRate);
  if (channels === 2) return [stereoLow, stereoHigh];
  if (channels === 6 && from === 40000) return [14 * 6, high * 6];
  return [low * channels, high * channels];
}

/** The bitrate libvorbis is asked for: the request, moved into its range. */
export function vorbisKbps(bitrate: number, sampleRate: number, channels: number): number {
  const [low, high] = vorbisRange(sampleRate, channels);
  return Math.min(high, Math.max(low, bitrate));
}

/**
 * The most libvorbis writes over the bitrate it is asked for, as a factor.
 *
 * ffmpeg runs libvorbis without rate management when it is given only -b:a,
 * so the bitrate picks a quality and the material decides the rest. Dense
 * music runs over and speech mostly under, though mono speech ran 28% over
 * at 32 kHz and 128 kbps. The lowest setups of each band run over the most,
 * up to 64% at 24 kHz mono and 16 kbps. Each factor is the worst case of
 * ten songs and five voices, 30 s from the middle of each, at every band,
 * mono and stereo, and every bitrate the range allows, with the
 * @ffmpeg/core 0.12.10 build the site ships. They cover a 30 s file with
 * its 3-5 kB header; a longer file needs less.
 */
export function vorbisOvershoot(bitrate: number, sampleRate: number, channels: number): number {
  const [, , , , , above, atOrBelow] = vorbisBand(sampleRate);
  return vorbisKbps(bitrate, sampleRate, channels) / channels > 24 ? above : atOrBelow;
}

/**
 * The most ffmpeg's AAC encoder will spend, in kbps, at this rate and width.
 *
 * It is not a setting but a measurement: past a point the encoder runs out of
 * spectrum worth coding, so asking for 192k at 22.05 kHz mono gets about 105,
 * and at 16 kHz about 79. Measured on speech and music with the
 * @ffmpeg/core 0.12.10 build the site ships: roughly 4.4 kbps per kHz plus a
 * little, per channel, with a second channel adding 80% rather than 100%.
 */
function aacCeiling(sampleRate: number, channels: number): number {
  const mono = (4.4 * sampleRate) / 1000 + 6;
  return channels === 1 ? mono : mono * 0.9 * channels;
}

/**
 * Bitrate an encoder really averages, in kbps, for a requested one.
 *
 * Every ffmpeg encoder here treats the request as a target rather than a
 * cap, and the size promises the send tools make depend on the difference.
 * The factors are the worst cases measured with the shipped core: constrained
 * Opus 1-3% over (the Ogg pages and 10 ms stereo frames are most of it), AAC
 * up to 8% over at 32 kHz and above and up to 15% below that, WMA 8% (ASF
 * framing), Vorbis up to 28% at 40 to 50 kHz and up to 64% at the lowest
 * setups below that (see vorbisOvershoot).
 */
export function effectiveKbps(
  formatId: string,
  bitrate: number,
  sampleRate: number,
  channels: number
): number {
  switch (formatId) {
    case 'mp3':
      return mp3Output(sampleRate, bitrate, Math.min(2, channels)).bitrate;
    case 'm4a':
    case 'm4r':
    case 'aac':
      return Math.min(
        bitrate * (sampleRate >= 32000 ? 1.08 : 1.15),
        aacCeiling(sampleRate, channels)
      );
    case 'opus':
      return bitrate * 1.03;
    case 'ogg':
      return (
        vorbisKbps(bitrate, sampleRate, channels) *
        vorbisOvershoot(bitrate, sampleRate, channels)
      );
    case 'wma':
      return bitrate * 1.08;
    default:
      return bitrate;
  }
}

/**
 * The bitrate to put on a label: what the encoder writes, not what was asked.
 * Unlike `effectiveKbps` it leaves out the overshoot, which is a margin for
 * sizing rather than something anyone chose.
 */
export function writtenKbps(
  formatId: string,
  bitrate: number,
  sampleRate: number,
  channels: number
): number {
  switch (formatId) {
    case 'mp3':
      return mp3Output(sampleRate, bitrate, Math.min(2, channels)).bitrate;
    case 'm4a':
    case 'm4r':
    case 'aac':
      return Math.round(Math.min(bitrate, aacCeiling(sampleRate, channels)));
    case 'ogg':
      return vorbisKbps(bitrate, sampleRate, channels);
    default:
      return bitrate;
  }
}

/**
 * The sample rate a format comes out at. MP3 can drop it on its own (see
 * `mp3Output`), Opus always decodes at 48 kHz whatever went in, and Vorbis
 * past 50 kHz is written at 48 (see `vorbisRate`).
 */
export function outputSampleRate(
  formatId: string,
  sampleRate: number,
  bitrate: number,
  channels: number
): number {
  if (formatId === 'mp3') return mp3Output(sampleRate, bitrate, Math.min(2, channels)).sampleRate;
  if (formatId === 'opus') return 48000;
  if (formatId === 'ogg') return vorbisRate(sampleRate);
  return sampleRate;
}

/** Bytes of a lossy file averaging `kbps` for `seconds`, plus header room. */
export function lossyBytes(seconds: number, kbps: number): number {
  return Math.round((kbps * 1000 * seconds) / 8) + 2048;
}

/**
 * Predicted output size. Shown before export so nobody is surprised by a
 * 400 MB WAV — the incumbents let you find out after the download starts.
 */
export function estimateSize(
  buffer: AudioBuffer,
  formatId: string,
  options: { bitrate?: number; bitDepth?: WavBitDepth } = {}
): number {
  const format = formatById(formatId);
  const { bitrate = 192, bitDepth = 16 } = options;
  const seconds = buffer.duration;
  const channels = buffer.numberOfChannels;

  switch (format.id) {
    case 'wav':
      return wavSize(buffer.length, channels, bitDepth);
    case 'aiff':
      return 54 + buffer.length * channels * 2;
    case 'flac':
      // 16-bit FLAC typically lands near 55% of the equivalent PCM. At 24
      // bits the bottom byte is mostly noise, which barely compresses.
      return losslessDepth('flac', bitDepth) === 16
        ? Math.round(wavSize(buffer.length, channels, 16) * 0.55)
        : Math.round(wavSize(buffer.length, channels, 24) * 0.65);
    case 'mp3':
      return mp3Size(seconds, effectiveKbps('mp3', bitrate, buffer.sampleRate, channels));
    default:
      return lossyBytes(seconds, effectiveKbps(format.id, bitrate, buffer.sampleRate, channels));
  }
}

/** Bitrate choices that make sense for a format. */
export function bitratesFor(formatId: string): number[] {
  switch (formatId) {
    case 'opus':
      return [32, 48, 64, 96, 128, 160, 192];
    case 'm4a':
    case 'm4r':
    case 'aac':
      return [64, 96, 128, 160, 192, 256];
    case 'wma':
      return [64, 96, 128, 160, 192];
    default:
      return [64, 96, 128, 160, 192, 256, 320];
  }
}

/** Formats that need no engine download — surfaced in the UI as "instant". */
export function isInstant(formatId: string): boolean {
  return formatById(formatId).tier < 2;
}
