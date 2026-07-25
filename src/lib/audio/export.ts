/**
 * The tier router. Every tool exports through here.
 *
 * Deciding the tier per *format* rather than per *tool* is what makes the site
 * fast: trimming an MP3 and saving it back never touches ffmpeg, so the common
 * path stays at ~110 KB instead of 31 MB. Only a genuinely non-native output
 * format escalates.
 */
import { encodeWav, wavSize, type WavBitDepth } from './encode-wav';
import { encodeMp3, mp3Size, type Mp3Bitrate } from './encode-mp3';
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
  /** WAV only. */
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

    default:
      return encodeVia(buffer, format.extension, {
        args: ffmpegArgsFor(format, bitrate),
        onProgress,
        onLoadProgress: onEngineLoad,
        signal,
      });
  }
}

function ffmpegArgsFor(format: FormatSpec, bitrate: number): string[] {
  switch (format.id) {
    case 'm4a':
    case 'm4r':
      // M4R is an M4A with a different extension; iOS only checks the extension.
      return ['-c:a', 'aac', '-b:a', `${bitrate}k`, '-f', 'mp4'];
    case 'aac':
      return ['-c:a', 'aac', '-b:a', `${bitrate}k`];
    case 'ogg':
      return ['-c:a', 'libvorbis', '-b:a', `${bitrate}k`];
    case 'opus':
      return ['-c:a', 'libopus', '-b:a', `${bitrate}k`];
    case 'flac':
      return ['-c:a', 'flac', '-compression_level', '5'];
    case 'aiff':
      return ['-c:a', 'pcm_s16be'];
    case 'wma':
      return ['-c:a', 'wmav2', '-b:a', `${bitrate}k`];
    default:
      return [];
  }
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

  switch (format.id) {
    case 'wav':
      return wavSize(buffer.length, buffer.numberOfChannels, bitDepth);
    case 'aiff':
      return 54 + buffer.length * buffer.numberOfChannels * 2;
    case 'flac':
      // FLAC typically lands near 55% of the equivalent PCM.
      return Math.round(wavSize(buffer.length, buffer.numberOfChannels, 16) * 0.55);
    case 'mp3':
      return mp3Size(seconds, bitrate);
    default:
      return Math.round((bitrate * 1000 * seconds) / 8) + 2048;
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
