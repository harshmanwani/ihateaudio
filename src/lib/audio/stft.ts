/**
 * Short-time Fourier transform matching PyTorch's, because the models were
 * trained against PyTorch's.
 *
 * This is not a general-purpose STFT and should not be tidied into one. Every
 * choice here exists to reproduce
 *
 *   torch.stft(x, n_fft, hop_length=hop, window=torch.hann_window(n_fft),
 *              center=True, return_complex=True)
 *
 * bit for bit in behaviour, because a separation model is a function of its input
 * representation. Get the window periodicity, the padding mode or the frame count
 * wrong and the network still produces confident-looking output; it is simply the
 * wrong output, in a way no error message will ever tell you about. The three
 * places that bite:
 *
 *   - `hann_window` is periodic by default in torch, not symmetric. The last
 *     sample is not a mirror of the first.
 *   - `center=True` pads by n_fft/2 each side in **reflect** mode, not zeros.
 *   - the inverse divides by the real overlap-added window-squared envelope
 *     rather than assuming the constant-overlap-add value, which is what makes
 *     the first and last few frames reconstruct correctly.
 *
 * Verified in tests/unit/stft.test.ts against a directly-evaluated DFT of the
 * windowed frames, and for round-trip identity at every size the models use.
 */
import { fft, ifft } from './fft';

export interface StftPlan {
  nFft: number;
  hop: number;
  /** n_fft / 2 + 1 — the one-sided bin count for real input. */
  bins: number;
  /**
   * Bins actually stored per frame. Defaults to all of them.
   *
   * The separation models read only the lowest `dimF` bins and discard the rest,
   * and storing what is about to be thrown away is not free at these sizes. The
   * bass model transforms at 16384 over 512 frames, so a full stereo spectrum is
   * 134 MB in double precision, per chunk, allocated and collected repeatedly.
   * Keeping 2048 bins instead brings that to 34 MB.
   */
  keep: number;
  window: Float64Array;
}

const windows = new Map<number, Float64Array>();

/**
 * Periodic Hann, which is what torch.hann_window gives by default.
 *
 * The periodic form divides by N, the symmetric form by N-1. At n_fft 6144 the
 * difference is one part in six thousand per sample, which sounds ignorable and
 * is not: it breaks the exact constant-overlap-add property the inverse relies
 * on, leaving a low-level periodic ripple at the hop rate through the whole
 * reconstruction.
 */
export function hannPeriodic(n: number): Float64Array {
  let w = windows.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i += 1) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    windows.set(n, w);
  }
  return w;
}

export function stftPlan(nFft: number, hop: number, keep?: number): StftPlan {
  const bins = nFft / 2 + 1;
  if (keep !== undefined && (keep < 1 || keep > bins)) {
    throw new Error(`keep must be between 1 and ${bins}, got ${keep}`);
  }
  return { nFft, hop, bins, keep: keep ?? bins, window: hannPeriodic(nFft) };
}

/** Frame count torch produces for a centred transform. */
export function frameCount(length: number, hop: number): number {
  return Math.floor(length / hop) + 1;
}

/**
 * Reflect-pad by n_fft/2 on each side, as `center=True` does.
 *
 * Reflection rather than zeros matters at the edges of every chunk, and because
 * the separation runs in chunks there are a great many edges. Zero padding puts
 * a step discontinuity at each one, which spreads energy across every frequency
 * bin and shows up in the output as a click at the chunk boundary.
 *
 * Torch reflects without repeating the edge sample: for input abcde the left pad
 * is ...dcb | abcde. A signal shorter than the pad would need repeated
 * reflection; the chunk sizes here are always far longer, and the guard makes
 * that assumption explicit rather than silently producing a wrong index.
 */
function reflectPad(input: Float32Array, pad: number): Float64Array {
  if (input.length < pad + 1) {
    throw new Error(`reflect padding needs at least ${pad + 1} samples, got ${input.length}`);
  }
  const out = new Float64Array(input.length + 2 * pad);
  for (let i = 0; i < pad; i += 1) out[i] = input[pad - i]!;
  for (let i = 0; i < input.length; i += 1) out[pad + i] = input[i]!;
  for (let i = 0; i < pad; i += 1) {
    out[pad + input.length + i] = input[input.length - 2 - i]!;
  }
  return out;
}

/**
 * Forward transform of one real channel.
 *
 * Writes interleaved complex into `out` as [frame][bin] — frame-major, because
 * that is the order the frames are produced in and the caller re-lays it out into
 * the model's channel-major tensor anyway.
 *
 * `out` must hold 2 * frames * plan.keep values.
 */
export function stft(input: Float32Array, plan: StftPlan, out: Float64Array): number {
  const { nFft, hop, keep, window } = plan;
  const pad = nFft >> 1;
  const padded = reflectPad(input, pad);
  const frames = frameCount(input.length, hop);

  const frame = new Float64Array(2 * nFft);
  const spec = new Float64Array(2 * nFft);

  for (let f = 0; f < frames; f += 1) {
    const start = f * hop;
    for (let i = 0; i < nFft; i += 1) {
      frame[2 * i] = padded[start + i]! * window[i]!;
      frame[2 * i + 1] = 0;
    }
    fft(frame, spec, nFft);
    // One-sided: the negative frequencies of a real signal are the conjugate of
    // the positive ones and carry no extra information. Only `keep` of those are
    // stored, which for the separation models is all the network will look at.
    const base = 2 * f * keep;
    for (let b = 0; b < keep; b += 1) {
      out[base + 2 * b] = spec[2 * b]!;
      out[base + 2 * b + 1] = spec[2 * b + 1]!;
    }
  }
  return frames;
}

/**
 * Inverse transform back to one real channel of exactly `length` samples.
 *
 * `input` is interleaved complex laid out as [frame][bin], the same order stft
 * writes, carrying `plan.keep` bins per frame. Bins above that are taken as zero,
 * which is exactly what the separation models imply about the band they discard,
 * and the Hermitian half is reconstructed on the way in.
 */
export function istft(
  input: Float64Array,
  frames: number,
  plan: StftPlan,
  length: number
): Float32Array {
  const { nFft, hop, bins, keep, window } = plan;
  const pad = nFft >> 1;
  const total = (frames - 1) * hop + nFft;

  const acc = new Float64Array(total);
  const envelope = new Float64Array(total);

  const spec = new Float64Array(2 * nFft);
  const time = new Float64Array(2 * nFft);

  for (let f = 0; f < frames; f += 1) {
    const base = 2 * f * keep;
    for (let b = 0; b < keep; b += 1) {
      spec[2 * b] = input[base + 2 * b]!;
      spec[2 * b + 1] = input[base + 2 * b + 1]!;
    }
    for (let b = keep; b < bins; b += 1) {
      spec[2 * b] = 0;
      spec[2 * b + 1] = 0;
    }
    // Mirror the conjugate half so the inverse transform sees a Hermitian
    // spectrum and returns a real signal.
    for (let b = bins; b < nFft; b += 1) {
      spec[2 * b] = spec[2 * (nFft - b)]!;
      spec[2 * b + 1] = -spec[2 * (nFft - b) + 1]!;
    }

    ifft(spec, time, nFft);

    const start = f * hop;
    for (let i = 0; i < nFft; i += 1) {
      const w = window[i]!;
      acc[start + i] = acc[start + i]! + time[2 * i]! * w;
      envelope[start + i] = envelope[start + i]! + w * w;
    }
  }

  // Divide by the measured window envelope rather than the theoretical
  // constant. In the interior the two agree, but the first and last few frames
  // have fewer overlapping neighbours, and assuming the constant there scales
  // those samples wrongly — an audible fade artefact at every chunk edge.
  const out = new Float32Array(length);
  const limit = Math.min(length, total - pad);
  for (let i = 0; i < limit; i += 1) {
    const env = envelope[pad + i]!;
    out[i] = env > 1e-11 ? acc[pad + i]! / env : 0;
  }
  return out;
}
