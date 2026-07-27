/**
 * Neural noise suppression with RNNoise.
 *
 * The odd one out among the AI tools: its model is about 150 KB, small enough to
 * ship with the site, so there is no download to wait for and no setup panel to
 * show. RNNoise is a small recurrent network from the Xiph people that estimates,
 * band by band and frame by frame, how much of what it is hearing is voice and how
 * much is noise, then attenuates accordingly. It is a decade old, it is tiny, and it
 * is still better at steady room noise than almost anything of its size.
 *
 * This used to run the packaged AudioWorklet inside an OfflineAudioContext and
 * returned silence every time; rnnoise.ts explains exactly why, and why the fix was
 * to drop the audio graph and call the model directly. What is left here is
 * plumbing: rate conversion either side, a frame loop, and a blend.
 *
 * The loop yields to the event loop periodically rather than running to completion.
 * RNNoise manages about 84x real time, so a ten-minute recording is roughly seven
 * seconds of solid arithmetic — long enough that holding the main thread would mean
 * a frozen page, a dead cancel button and a progress bar that never repaints.
 * Yielding every couple of seconds of audio costs nothing measurable and makes all
 * three work.
 */
import {
  loadRnnoise,
  RNNOISE_DELAY,
  RNNOISE_FRAME,
  RNNOISE_RATE,
  type RnnoiseModule,
} from './rnnoise';

/**
 * Vite resolves these to real served URLs at build time.
 *
 * `?url` rather than an import, because the wasm has to be fetched as bytes and
 * cannot be bundled into the page.
 */
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

export { RNNOISE_RATE };

export interface DenoiseOptions {
  /**
   * 0..1, how much of the cleaned signal to keep against the original.
   *
   * Full suppression is not always what people want. RNNoise is aggressive, and on
   * a recording where the room tone is part of the atmosphere, mixing back a little
   * of the original sounds more natural than removing all of it.
   */
  amount?: number;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

/**
 * Frames processed between yields.
 *
 * 200 frames is two seconds of audio, about 24 ms of work — under a frame and a half
 * at 60 Hz, so the page stays responsive, while the yield overhead stays negligible
 * against the arithmetic.
 */
const FRAMES_PER_CHUNK = 200;

let cached: Promise<RnnoiseModule> | null = null;

/** Detects SIMD support with the canonical minimal probe module. */
function hasSimd(): boolean {
  try {
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0,
        65, 0, 253, 15, 253, 98, 11,
      ])
    );
  } catch {
    return false;
  }
}

/**
 * Fetches and instantiates the model once per page.
 *
 * The non-SIMD build exists for older browsers and is several times slower. Both are
 * about 150 KB, so the check is worth making rather than always taking the safe one.
 */
function module(): Promise<RnnoiseModule> {
  cached ??= (async () => {
    const url = hasSimd() ? rnnoiseSimdWasmUrl : rnnoiseWasmUrl;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Could not load the denoiser (HTTP ${response.status}).`);
    }
    return loadRnnoise(await response.arrayBuffer());
  })().catch((error: unknown) => {
    // A failed fetch must not poison every later attempt.
    cached = null;
    throw error;
  });
  return cached;
}

/** Hands the browser a turn, so it can paint and notice a click on Cancel. */
function breathe(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Rate conversion through the browser's own resampler, which has a proper filter. */
async function resample(
  buffer: AudioBuffer,
  rate: number,
  frames: number
): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(buffer.numberOfChannels, frames, rate);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  return context.startRendering();
}

function peakOf(buffer: AudioBuffer): number {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i += 1) {
      const value = Math.abs(data[i]!);
      if (value > peak) peak = value;
    }
  }
  return peak;
}

/**
 * Cleans a buffer and returns it at its original sample rate and channel count.
 *
 * The signal is resampled to 48 kHz, denoised, and resampled back, so a 44.1 kHz file
 * comes out at 44.1 kHz. That round trip costs a little high-frequency detail, which
 * is a fair price for the model working on the rate it was built for.
 */
export async function denoise(
  buffer: AudioBuffer,
  options: DenoiseOptions = {}
): Promise<AudioBuffer> {
  const amount = Math.max(0, Math.min(1, options.amount ?? 1));
  const abort = (): void => {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  };

  abort();
  const rnnoise = await module();
  abort();

  const channels = buffer.numberOfChannels;
  const sourceRate = buffer.sampleRate;

  // Up to 48 kHz if it is not there already.
  const working =
    sourceRate === RNNOISE_RATE
      ? buffer
      : await resample(
          buffer,
          RNNOISE_RATE,
          Math.max(1, Math.round((buffer.length / sourceRate) * RNNOISE_RATE))
        );
  abort();

  const length = working.length;
  /**
   * One extra frame beyond the audio, because the model runs a frame behind: the
   * last 480 real samples are still inside it when the input runs out, and without a
   * final push of silence they never come back out.
   */
  const totalFrames = Math.ceil((length + RNNOISE_DELAY) / RNNOISE_FRAME);
  const cleaned = new AudioBuffer({
    numberOfChannels: channels,
    length,
    sampleRate: RNNOISE_RATE,
  });

  const frame = new Float32Array(RNNOISE_FRAME);
  let done = 0;

  for (let c = 0; c < channels; c += 1) {
    // A state per channel, never one reused: RNNoise is recurrent, so sharing one
    // would let each channel's noise estimate contaminate the other's.
    const state = rnnoise.createState();
    const dry = working.getChannelData(c);
    const wet = cleaned.getChannelData(c);

    try {
      for (let f = 0; f < totalFrames; f += 1) {
        const start = f * RNNOISE_FRAME;

        // Reads past the end are silence, which is exactly the flush the tail needs.
        for (let i = 0; i < RNNOISE_FRAME; i += 1) {
          frame[i] = dry[start + i] ?? 0;
        }

        state.process(frame);

        /**
         * Written back shifted, undoing the model's one-frame delay.
         *
         * Output sample n corresponds to input sample n - 480, so the result is
         * placed 480 earlier than it arrived. Without this the cleaned file sits
         * 10 ms late against the original, and the blend below would be mixing a
         * signal with a delayed copy of itself, which is a comb filter and not a
         * blend at all.
         */
        for (let i = 0; i < RNNOISE_FRAME; i += 1) {
          const at = start + i - RNNOISE_DELAY;
          if (at >= 0 && at < length) wet[at] = frame[i]!;
        }

        done += 1;
        if (done % FRAMES_PER_CHUNK === 0) {
          options.onProgress?.(done / (totalFrames * channels));
          await breathe();
          abort();
        }
      }
    } finally {
      state.destroy();
    }

    // Now that the whole channel is aligned, fold in however much of the original
    // was asked for. Both paths are on the same timeline, so this is a real blend.
    if (amount < 1) {
      for (let i = 0; i < length; i += 1) {
        wet[i] = wet[i]! * amount + dry[i]! * (1 - amount);
      }
    }
  }

  options.onProgress?.(1);

  /**
   * Refuse to hand back silence that did not start that way.
   *
   * A silent input should give a silent output and that is not a fault, so the
   * comparison is against the input rather than against zero. Handing somebody an
   * empty file as their cleaned recording is the worst outcome available, and it is
   * what this tool used to do.
   */
  if (peakOf(cleaned) < 1e-6 && peakOf(working) >= 1e-6) {
    throw new Error(
      'The denoiser produced silence rather than cleaned audio, so nothing was ' +
        'changed. This is a fault in the tool, not in your file.'
    );
  }

  if (sourceRate === RNNOISE_RATE) return cleaned;
  return resample(cleaned, sourceRate, buffer.length);
}

/**
 * How much quieter the result is, in dB, as a rough indication of what was removed.
 *
 * Not a quality measure — a number here only says the denoiser did something. But
 * "it took out 6 dB of noise" is a more useful thing to tell someone than a tick.
 */
export function reductionDb(before: AudioBuffer, after: AudioBuffer): number {
  const rms = (buffer: AudioBuffer): number => {
    let sum = 0;
    let count = 0;
    for (let c = 0; c < buffer.numberOfChannels; c += 1) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i += 1) {
        sum += data[i]! * data[i]!;
        count += 1;
      }
    }
    return Math.sqrt(sum / (count || 1));
  };

  const a = rms(before);
  const b = rms(after);
  // Silent output is a failure, not a perfect result, and returning 0 for it made
  // the tool report "almost nothing was removed — the recording was already clean"
  // while handing back an empty file. Infinity is the honest answer and the caller
  // checks for it.
  if (a <= 0) return 0;
  if (b <= 0) return Infinity;
  return 20 * Math.log10(a / b);
}
