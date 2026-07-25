/**
 * MP3 writer. Tier 1 — ~110 KB, loaded on demand.
 *
 * This covers the single most common journey on the site (MP3 in, MP3 out) at
 * a fraction of a percent of ffmpeg's weight, which is the whole reason the
 * trimmer feels instant while competitors spin.
 */
import { audioError } from './errors';
import { resampleLinear } from './dsp';

/** Sample rates the MP3 format permits. Anything else must be resampled. */
const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

export const MP3_BITRATES = [64, 96, 128, 160, 192, 256, 320] as const;
export type Mp3Bitrate = (typeof MP3_BITRATES)[number];

export interface Mp3Options {
  bitrate?: Mp3Bitrate;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

export function nearestMp3Rate(rate: number): number {
  return MP3_RATES.reduce((best, candidate) =>
    Math.abs(candidate - rate) < Math.abs(best - rate) ? candidate : best
  );
}

type LameModule = {
  Mp3Encoder: new (
    channels: number,
    sampleRate: number,
    kbps: number
  ) => {
    encodeBuffer(left: Int16Array, right?: Int16Array): Uint8Array;
    flush(): Uint8Array;
  };
};

let lamePromise: Promise<LameModule> | null = null;

/** Loads the encoder once and shares it across tools and repeat exports. */
async function loadLame(): Promise<LameModule> {
  if (!lamePromise) {
    lamePromise = import('@breezystack/lamejs')
      .then((mod) => (mod.default ?? mod) as unknown as LameModule)
      .catch((err) => {
        lamePromise = null;
        throw err;
      });
  }
  return lamePromise;
}

/** Warms the encoder while the user is still choosing settings. */
export function preloadMp3Encoder(): void {
  void loadLame().catch(() => {
    /* Preload is best-effort; export will surface any real failure. */
  });
}

function toInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    let s = input[i];
    if (!Number.isFinite(s)) s = 0;
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}

export async function encodeMp3(
  buffer: AudioBuffer,
  options: Mp3Options = {}
): Promise<Blob> {
  const { bitrate = 192, onProgress, signal } = options;

  let lame: LameModule;
  try {
    lame = await loadLame();
  } catch {
    throw audioError(
      'encode-failed',
      'The MP3 encoder failed to load. Check your connection and reload, or export as WAV instead.'
    );
  }

  // MP3 only permits certain rates; resample rather than fail.
  const targetRate = nearestMp3Rate(buffer.sampleRate);
  const source =
    targetRate === buffer.sampleRate ? buffer : resampleLinear(buffer, targetRate);

  // lamejs handles mono and stereo; anything wider is downmixed by taking the
  // first two channels, which is what every consumer player would do anyway.
  const channels = Math.min(2, source.numberOfChannels);
  const encoder = new lame.Mp3Encoder(channels, targetRate, bitrate);

  const left = toInt16(source.getChannelData(0));
  const right = channels > 1 ? toInt16(source.getChannelData(1)) : undefined;

  const chunks: Uint8Array[] = [];
  // 1152 samples is one MPEG frame; multiples keep the encoder on frame
  // boundaries and avoid an extra copy per block.
  const block = 1152 * 16;
  const total = left.length;

  try {
    for (let offset = 0; offset < total; offset += block) {
      if (signal?.aborted) throw audioError('cancelled');

      const end = Math.min(offset + block, total);
      const chunk = encoder.encodeBuffer(
        left.subarray(offset, end),
        right ? right.subarray(offset, end) : undefined
      );
      if (chunk.length > 0) chunks.push(chunk);

      onProgress?.(end / total);

      // Yield so the progress bar actually paints. Without this the whole
      // encode blocks the main thread and the UI looks frozen.
      if (offset % (block * 8) === 0) await new Promise((r) => setTimeout(r, 0));
    }

    const tail = encoder.flush();
    if (tail.length > 0) chunks.push(tail);
  } catch (err) {
    if (err instanceof Error && err.name === 'AudioError') throw err;
    throw audioError('encode-failed');
  }

  onProgress?.(1);
  return new Blob(chunks as BlobPart[], { type: 'audio/mpeg' });
}

/** Predicted MP3 size in bytes — constant bitrate plus a small tag allowance. */
export function mp3Size(seconds: number, bitrate: number): number {
  return Math.round((bitrate * 1000 * seconds) / 8) + 512;
}
