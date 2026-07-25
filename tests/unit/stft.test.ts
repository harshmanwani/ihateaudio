/**
 * The STFT has to agree with PyTorch's, because that is what the separation
 * models were trained against. Three details do the damage if you get them
 * wrong, and none of them raise an error:
 *
 *   - a symmetric Hann window instead of torch's periodic default,
 *   - zero padding instead of reflect padding for `center=True`,
 *   - assuming the constant-overlap-add gain in the inverse instead of dividing
 *     by the real window-squared envelope.
 *
 * The expected values here were produced by running the equivalent torch code
 * and are pinned as literals, so this test keeps holding without torch installed.
 */
import { describe, expect, it } from 'vitest';
import {
  frameCount,
  hannPeriodic,
  istft,
  stft,
  stftPlan,
} from '../../src/lib/audio/stft';

function relativeError(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let num = 0;
  let den = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = a[i]! - b[i]!;
    num += d * d;
    den += b[i]! * b[i]!;
  }
  return Math.sqrt(num / (den || 1));
}

/**
 * Windowed DFT evaluated straight from the definition, sharing no code with the
 * implementation beyond the window itself.
 */
function directStft(x: Float32Array, nFft: number, hop: number): Float64Array {
  const pad = nFft >> 1;
  const w = hannPeriodic(nFft);
  const padded = new Float64Array(x.length + 2 * pad);
  for (let i = 0; i < pad; i += 1) padded[i] = x[pad - i]!;
  for (let i = 0; i < x.length; i += 1) padded[pad + i] = x[i]!;
  for (let i = 0; i < pad; i += 1) padded[pad + x.length + i] = x[x.length - 2 - i]!;

  const frames = Math.floor(x.length / hop) + 1;
  const bins = nFft / 2 + 1;
  const out = new Float64Array(2 * frames * bins);
  for (let f = 0; f < frames; f += 1) {
    for (let b = 0; b < bins; b += 1) {
      let sumR = 0;
      let sumI = 0;
      for (let t = 0; t < nFft; t += 1) {
        const v = padded[f * hop + t]! * w[t]!;
        const phase = (-2 * Math.PI * b * t) / nFft;
        sumR += v * Math.cos(phase);
        sumI += v * Math.sin(phase);
      }
      out[2 * (f * bins + b)] = sumR;
      out[2 * (f * bins + b) + 1] = sumI;
    }
  }
  return out;
}

function tone(length: number): Float32Array {
  const x = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    x[i] = Math.sin(i * 0.07) * 0.6 + Math.sin(i * 0.31) * 0.3;
  }
  return x;
}

describe('hannPeriodic', () => {
  it('is periodic, not symmetric', () => {
    const w = hannPeriodic(8);
    // Periodic Hann divides by N, so w[0] is 0 and the window never returns to
    // 0 at the far end — w[N-1] is the mirror of w[1], not of w[0]. A symmetric
    // window would end on 0.
    expect(w[0]).toBeCloseTo(0, 12);
    expect(w[7]).toBeCloseTo(w[1]!, 12);
    expect(w[7]).toBeGreaterThan(0.1);
    expect(w[4]).toBeCloseTo(1, 12);
  });

  it('matches torch.hann_window(8) exactly', () => {
    // torch.hann_window(8) -> [0.0000, 0.1464, 0.5000, 0.8536, 1.0000, 0.8536, 0.5000, 0.1464]
    const expected = [0, 0.1464466, 0.5, 0.8535534, 1, 0.8535534, 0.5, 0.1464466];
    const w = hannPeriodic(8);
    for (let i = 0; i < 8; i += 1) expect(w[i]).toBeCloseTo(expected[i]!, 6);
  });
});

describe('frameCount', () => {
  /**
   * MDX-Net sets chunk_size = hop * (dim_t - 1) precisely so that a centred
   * transform yields exactly dim_t frames, which is the model's time dimension.
   * If this arithmetic drifts the tensor is the wrong shape and inference fails
   * loudly, which is the one merciful failure mode in this whole pipeline.
   */
  it.each([
    [256, 1024],
    [512, 1024],
  ])('gives exactly dim_t=%i frames for chunk_size = hop*(dim_t-1)', (dimT, hop) => {
    expect(frameCount(hop * (dimT - 1), hop)).toBe(dimT);
  });
});

describe('stft', () => {
  it.each([
    [64, 16],
    [96, 16],
    [128, 32],
    [240, 48],
  ])('matches a direct windowed DFT at n_fft=%i hop=%i', (nFft, hop) => {
    const x = tone(hop * 12);
    const plan = stftPlan(nFft, hop);
    const frames = frameCount(x.length, hop);
    const out = new Float64Array(2 * frames * plan.bins);
    stft(x, plan, out);
    expect(relativeError(out, directStft(x, nFft, hop))).toBeLessThan(1e-11);
  });

  it('reflect pads rather than zero pads', () => {
    // Reflect-padding a constant signal leaves it constant everywhere, so the
    // very first frame is just amplitude x window. A periodic Hann is
    // 0.5 - 0.5*cos(2*pi*t/N), which is three cosines and therefore has exactly
    // three non-zero DFT bins: N/2 at bin 0 and -N/4 at bins +/-1. So frame 0 of
    // a constant 0.5 must be 0.25*N at bin 0, -0.125*N at bin 1, and numerical
    // dust from bin 2 up.
    //
    // Zero padding is what makes this discriminating: frame 0 would then straddle
    // a step from silence to 0.5 halfway through the window, which is not
    // band-limited and spreads energy across every bin. Bin 12 would come out
    // around a tenth of bin 0 instead of vanishing.
    const nFft = 64;
    const hop = 16;
    const x = new Float32Array(hop * 8).fill(0.5);
    const plan = stftPlan(nFft, hop);
    const frames = frameCount(x.length, hop);
    const out = new Float64Array(2 * frames * plan.bins);
    stft(x, plan, out);

    const magnitude = (b: number) => Math.hypot(out[2 * b]!, out[2 * b + 1]!);
    expect(magnitude(0)).toBeCloseTo(0.25 * nFft, 9);
    expect(out[2]).toBeCloseTo(-0.125 * nFft, 9);

    let worstBeyond = 0;
    for (let b = 2; b < plan.bins; b += 1) worstBeyond = Math.max(worstBeyond, magnitude(b));
    expect(worstBeyond).toBeLessThan(1e-9 * nFft);
  });

  it('rejects input too short to reflect pad instead of reading out of bounds', () => {
    const plan = stftPlan(64, 16);
    const out = new Float64Array(2 * 64 * plan.bins);
    expect(() => stft(new Float32Array(4), plan, out)).toThrow(/reflect padding/);
  });
});

describe('istft', () => {
  /**
   * Round trip at every size the models use. The tolerance is deliberately
   * brutal: with the envelope division correct this is limited only by double
   * precision, so anything above -100 dB means a real semantic error rather than
   * accumulated rounding.
   */
  it.each([
    [4096, 1024, 512],
    [6144, 1024, 256],
    [7680, 1024, 256],
    [8192, 1024, 512],
    [16384, 1024, 512],
  ])('reconstructs to below -100 dB at n_fft=%i', (nFft, hop, dimT) => {
    const length = hop * (dimT - 1);
    const x = new Float32Array(length);
    for (let i = 0; i < length; i += 1) x[i] = Math.sin(i * 0.013) * 0.8;

    const plan = stftPlan(nFft, hop);
    const frames = frameCount(length, hop);
    const spec = new Float64Array(2 * frames * plan.bins);
    stft(x, plan, spec);
    const back = istft(spec, frames, plan, length);

    const db = 20 * Math.log10(relativeError(back, x) || 1e-300);
    expect(db).toBeLessThan(-100);
  });

  it('reconstructs the very start and end, not just the interior', () => {
    // The edges are where assuming the constant overlap-add gain goes wrong,
    // because the first and last frames have fewer overlapping neighbours. The
    // symptom is a short fade at every chunk boundary, so it is checked
    // separately from the whole-signal figure above.
    const nFft = 6144;
    const hop = 1024;
    const length = hop * 255;
    const x = new Float32Array(length);
    for (let i = 0; i < length; i += 1) x[i] = Math.sin(i * 0.021) * 0.7;

    const plan = stftPlan(nFft, hop);
    const frames = frameCount(length, hop);
    const spec = new Float64Array(2 * frames * plan.bins);
    stft(x, plan, spec);
    const back = istft(spec, frames, plan, length);

    const edge = 256;
    const head = relativeError(back.subarray(0, edge), x.subarray(0, edge));
    const tail = relativeError(back.subarray(length - edge), x.subarray(length - edge));
    expect(20 * Math.log10(head || 1e-300)).toBeLessThan(-100);
    expect(20 * Math.log10(tail || 1e-300)).toBeLessThan(-100);
  });
});
