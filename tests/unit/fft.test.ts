/**
 * The FFT is the one place in the codebase where a wrong answer is completely
 * silent. A separation model fed a subtly incorrect spectrum still returns a
 * confident, plausible-looking tensor, and the result only sounds slightly worse
 * than it should — which is indistinguishable from the model simply not being
 * very good. So this is checked against an independent O(n^2) DFT rather than
 * against itself.
 *
 * A real bug found this way: the radix-3 butterfly had both signs of its
 * imaginary correction flipped. Every power-of-two length passed, so a
 * round-trip test would have reported success, and only lengths with a factor of
 * three were wrong — which is to say, exactly the lengths the separation models
 * actually use.
 */
import { describe, expect, it } from 'vitest';
import { fft, ifft } from '../../src/lib/audio/fft';

/** Direct O(n^2) DFT. Slow, obvious, and independent of the code under test. */
function naiveDft(input: Float64Array, n: number): Float64Array {
  const out = new Float64Array(2 * n);
  for (let k = 0; k < n; k += 1) {
    let sumR = 0;
    let sumI = 0;
    for (let t = 0; t < n; t += 1) {
      const phase = (-2 * Math.PI * k * t) / n;
      const c = Math.cos(phase);
      const s = Math.sin(phase);
      sumR += input[2 * t]! * c - input[2 * t + 1]! * s;
      sumI += input[2 * t]! * s + input[2 * t + 1]! * c;
    }
    out[2 * k] = sumR;
    out[2 * k + 1] = sumI;
  }
  return out;
}

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

function signal(n: number): Float64Array {
  const out = new Float64Array(2 * n);
  for (let i = 0; i < 2 * n; i += 1) {
    out[i] = Math.sin(i * 1.7) + 0.3 * Math.cos(i * 0.11);
  }
  return out;
}

describe('fft', () => {
  /**
   * Covers each butterfly in isolation and in combination: 2, 3, 4 and 5 alone,
   * products of them, and 7 and 14 to reach the generic radix path.
   */
  const lengths = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 15, 16, 20, 21, 24, 25, 27, 30, 32, 35, 45, 48, 60,
    64, 81, 96, 120, 125, 128, 243, 384, 512, 768, 1024,
  ];

  it.each(lengths)('matches a naive DFT at length %i', (n) => {
    const input = signal(n);
    const output = new Float64Array(2 * n);
    fft(input, output, n);
    expect(relativeError(output, naiveDft(input, n))).toBeLessThan(1e-11);
  });

  it('does not mutate its input', () => {
    const n = 96;
    const input = signal(n);
    const copy = Float64Array.from(input);
    fft(input, new Float64Array(2 * n), n);
    expect(Array.from(input)).toEqual(Array.from(copy));
  });

  it('refuses to run in place, rather than producing garbage', () => {
    const buf = new Float64Array(2 * 64);
    expect(() => fft(buf, buf, 64)).toThrow(/in place/);
    expect(() => ifft(buf, buf, 64)).toThrow(/in place/);
  });

  /**
   * The lengths that actually matter. 6144 is 3 x 2048 and 7680 is 3 x 5 x 512,
   * which is the whole reason this file exists rather than a radix-2 FFT.
   */
  const modelLengths = [4096, 6144, 7680, 8192, 16384];

  it.each(modelLengths)('round trips to near double precision at %i', (n) => {
    const input = new Float64Array(2 * n);
    for (let i = 0; i < n; i += 1) input[2 * i] = Math.sin(i * 0.013) * 0.8;
    const spec = new Float64Array(2 * n);
    const back = new Float64Array(2 * n);
    fft(input, spec, n);
    ifft(spec, back, n);
    expect(relativeError(back, input)).toBeLessThan(1e-13);
  });

  it('puts a pure tone in exactly one bin', () => {
    const n = 6144;
    const bin = 300;
    const input = new Float64Array(2 * n);
    for (let i = 0; i < n; i += 1) {
      input[2 * i] = Math.cos((2 * Math.PI * bin * i) / n);
    }
    const out = new Float64Array(2 * n);
    fft(input, out, n);

    const magnitude = (k: number) => Math.hypot(out[2 * k]!, out[2 * k + 1]!);
    // A real cosine splits its energy between +bin and -bin, so both peaks are
    // n/2 and everything else must be numerical dust.
    expect(magnitude(bin)).toBeCloseTo(n / 2, 4);
    expect(magnitude(n - bin)).toBeCloseTo(n / 2, 4);

    let worstOther = 0;
    for (let k = 0; k < n; k += 1) {
      if (k === bin || k === n - bin) continue;
      worstOther = Math.max(worstOther, magnitude(k));
    }
    expect(worstOther).toBeLessThan(1e-8 * n);
  });
});
