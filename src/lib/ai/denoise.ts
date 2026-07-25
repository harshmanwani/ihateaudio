/**
 * Neural noise suppression with RNNoise, rendered offline.
 *
 * The odd one out among the AI tools: its network is about 150 KB, small enough to
 * ship with the site, so there is no download to wait for and no setup panel to
 * show. RNNoise is a small recurrent network from the Xiph people that estimates,
 * band by band and frame by frame, how much of what it is hearing is voice and how
 * much is noise, then attenuates accordingly. It is a decade old, it is tiny, and it
 * is still better at steady room noise than almost anything of its size.
 *
 * It ships as an AudioWorklet, which is built for live microphone input. Running it
 * over a file instead means putting the worklet inside an OfflineAudioContext, which
 * renders as fast as the machine allows rather than in real time — so a ten-minute
 * recording is cleaned in seconds rather than in ten minutes.
 */

/**
 * Vite resolves these to real served URLs at build time.
 *
 * `?url` rather than an import, because the worklet has to be fetched by
 * `audioWorklet.addModule` as a separate script and the wasm has to be fetched as
 * bytes. Neither can be bundled into the page.
 */
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

/**
 * RNNoise is built for 48 kHz and nothing else.
 *
 * Its band layout is defined in terms of that rate, so feeding it 44.1 kHz shifts
 * every band it learned. Unlike a separation model, where the result would merely be
 * worse, here it is audible immediately: the suppression lands on the wrong
 * frequencies and voices come out hollow.
 */
export const RNNOISE_RATE = 48000;

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

let wasmBinary: ArrayBuffer | null = null;

/**
 * Fetches the network, choosing the SIMD build where it is supported.
 *
 * The non-SIMD build exists for older browsers and is several times slower. Both are
 * about 150 KB so the check is worth making rather than always taking the safe one.
 */
async function loadWasm(): Promise<ArrayBuffer> {
  if (wasmBinary) return wasmBinary;

  const simd = await (async () => {
    try {
      // The canonical minimal SIMD probe module.
      return WebAssembly.validate(
        new Uint8Array([
          0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0,
          65, 0, 253, 15, 253, 98, 11,
        ])
      );
    } catch {
      return false;
    }
  })();

  const response = await fetch(simd ? rnnoiseSimdWasmUrl : rnnoiseWasmUrl);
  if (!response.ok) {
    throw new Error(`Could not load the denoiser (HTTP ${response.status}).`);
  }
  wasmBinary = await response.arrayBuffer();
  return wasmBinary;
}

/**
 * Cleans a buffer and returns it at its original sample rate and channel count.
 *
 * The signal is resampled to 48 kHz, run through the worklet, and resampled back, so
 * a 44.1 kHz file comes out at 44.1 kHz. That round trip costs a little high-frequency
 * detail, which is a fair price for the network working on the rate it was built for.
 */
export async function denoise(
  buffer: AudioBuffer,
  options: DenoiseOptions = {}
): Promise<AudioBuffer> {
  const amount = Math.max(0, Math.min(1, options.amount ?? 1));
  const binary = await loadWasm();
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const channels = buffer.numberOfChannels;
  const frames = Math.max(1, Math.round((buffer.length / buffer.sampleRate) * RNNOISE_RATE));

  const context = new OfflineAudioContext(channels, frames, RNNOISE_RATE);
  await context.audioWorklet.addModule(rnnoiseWorkletUrl);
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const { RnnoiseWorkletNode } = await import('@sapphi-red/web-noise-suppressor');

  const source = context.createBufferSource();
  source.buffer = buffer;

  // The node's constructor is typed for AudioContext, but an OfflineAudioContext is
  // just as valid a BaseAudioContext as far as the worklet is concerned — which is
  // the whole reason this can render faster than real time.
  const node = new RnnoiseWorkletNode(context as unknown as AudioContext, {
    maxChannels: channels,
    wasmBinary: binary,
  });

  /**
   * A dry/wet crossfade rather than a switch.
   *
   * Both paths run and are summed, so `amount` is a genuine blend. Gains are set
   * once rather than automated because this is an offline render with no
   * user-facing timeline to move them along.
   */
  const wet = context.createGain();
  const dry = context.createGain();
  wet.gain.value = amount;
  dry.gain.value = 1 - amount;

  source.connect(node);
  node.connect(wet);
  wet.connect(context.destination);
  source.connect(dry);
  dry.connect(context.destination);
  source.start();

  // OfflineAudioContext gives no progress events, so the only honest report is
  // that it started and then that it finished.
  options.onProgress?.(0);
  const rendered = await context.startRendering();
  options.onProgress?.(1);

  node.destroy();

  /**
   * Refuse to hand back silence.
   *
   * The worklet does not report failure — if it produces nothing, the wet path is
   * simply empty, and at full strength the dry path is muted, so the result is a
   * silent file that looks perfectly valid. Handing that to somebody as their
   * cleaned recording is the worst outcome available, so it is caught here.
   */
  let peak = 0;
  for (let c = 0; c < rendered.numberOfChannels; c += 1) {
    const data = rendered.getChannelData(c);
    for (let i = 0; i < data.length; i += 1) {
      const value = Math.abs(data[i]!);
      if (value > peak) peak = value;
    }
  }
  if (peak < 1e-6) {
    throw new Error(
      'The denoiser produced silence rather than cleaned audio, so nothing was ' +
        'changed. This is a fault in the tool, not in your file.'
    );
  }

  if (rendered.sampleRate === buffer.sampleRate) return rendered;

  // Back to the source's own rate.
  const back = new OfflineAudioContext(channels, buffer.length, buffer.sampleRate);
  const replay = back.createBufferSource();
  replay.buffer = rendered;
  replay.connect(back.destination);
  replay.start();
  return back.startRendering();
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
