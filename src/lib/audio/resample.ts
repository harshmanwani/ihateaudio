/**
 * Band-limited sample-rate conversion.
 *
 * Every output sample is a weighted sum of the input around its position, the
 * weights a windowed sinc that cuts off just below the lower of the two
 * Nyquist frequencies (Smith's bandlimited interpolation). That one filter does
 * both jobs: going down, it removes what the new rate cannot hold before it can
 * fold back as aliasing; going up, it removes the images that interpolation
 * would otherwise leave above the old Nyquist.
 *
 * This exists because the browser's own resampler is not this. Rendering a
 * buffer through an OfflineAudioContext at another rate interpolates linearly
 * in Chrome, which is a gentle low-pass in the audible band: 3.4 dB down at
 * 15 kHz for one pass from 44.1 to 48 kHz, and the AI tools make two passes.
 */
import { createBuffer } from './dsp';

/** Sinc zero crossings each side of the centre, at the lower of the two rates. */
const ZERO_CROSSINGS = 16;
/** Kaiser window shape. 8 puts the stopband around -80 dB. */
const BETA = 8;
/** Cutoff as a fraction of the lower Nyquist, leaving room for the transition. */
const ROLLOFF = 0.94;
/** Table entries per zero crossing; the kernel is interpolated between them. */
const STEPS = 512;

/** Zeroth-order modified Bessel function, for the Kaiser window. */
function bessel0(x: number): number {
  let sum = 1;
  let term = 1;
  const half = x / 2;
  for (let k = 1; k < 50; k += 1) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

let kernel: Float64Array | null = null;

/** The windowed sinc from the centre outwards, in steps of 1/STEPS zero crossing. */
function kernelTable(): Float64Array {
  if (kernel) return kernel;
  const size = ZERO_CROSSINGS * STEPS;
  // Two spare zeros, so interpolating at the very last entry reads a real value.
  const table = new Float64Array(size + 2);
  const norm = bessel0(BETA);
  for (let k = 0; k <= size; k += 1) {
    const t = k / STEPS;
    const sinc = k === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const edge = k / size;
    table[k] = (sinc * bessel0(BETA * Math.sqrt(1 - edge * edge))) / norm;
  }
  kernel = table;
  return table;
}

/**
 * One channel from `from` Hz to `to` Hz.
 *
 * `length` defaults to the input's duration at the new rate; callers that must
 * land on an exact frame count (a round trip back to the source length) pass it.
 */
export function resampleChannel(
  input: Float32Array,
  from: number,
  to: number,
  length = Math.max(1, Math.round((input.length * to) / from))
): Float32Array {
  const out = new Float32Array(length);
  if (from === to) {
    out.set(input.subarray(0, Math.min(length, input.length)));
    return out;
  }

  const table = kernelTable();
  // Cutoff relative to the input's Nyquist: the input's own when going up, the
  // output's when going down.
  const scale = Math.min(1, to / from) * ROLLOFF;
  const reach = ZERO_CROSSINGS / scale;
  const step = from / to;
  const perSample = scale * STEPS;
  const last = input.length - 1;

  for (let n = 0; n < length; n += 1) {
    const x = n * step;
    const lo = Math.max(0, Math.ceil(x - reach));
    const hi = Math.min(last, Math.floor(x + reach));
    let sum = 0;
    for (let i = lo; i <= hi; i += 1) {
      const at = Math.abs(x - i) * perSample;
      const k = at | 0;
      const a = table[k]!;
      sum += input[i]! * (a + (table[k + 1]! - a) * (at - k));
    }
    out[n] = sum * scale;
  }
  return out;
}

/**
 * A whole buffer to `rate`, channel by channel.
 *
 * Yields between channels so a page can paint its progress: a five-minute
 * channel takes most of a second.
 */
export async function resampleBuffer(
  buffer: AudioBuffer,
  rate: number,
  length = Math.max(1, Math.round((buffer.length * rate) / buffer.sampleRate))
): Promise<AudioBuffer> {
  if (buffer.sampleRate === rate && buffer.length === length) return buffer;
  const out = createBuffer(buffer.numberOfChannels, length, rate);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    if (c > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    out.copyToChannel(resampleChannel(buffer.getChannelData(c), buffer.sampleRate, rate, length), c);
  }
  return out;
}
