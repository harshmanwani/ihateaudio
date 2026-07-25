/**
 * Mixed-radix complex FFT for arbitrary transform lengths.
 *
 * The site already had all the DSP it needed until the separation models
 * arrived, and those forced this. MDX-Net's STFT sizes are set by how each model
 * was trained, and they are not powers of two: the instrumental model uses 6144
 * (3 x 2048) and other stems in the four-stem set use 7680 (3 x 5 x 512)
 * alongside the ordinary 4096, 8192 and 16384. A radix-2 FFT cannot do those at
 * all, and Bluestein's algorithm can but costs roughly three transforms of the
 * next power of two, which for 6144 means working at 16384 and paying about
 * eight times over. On a four-minute track that is tens of seconds of pure
 * overhead per pass, so it was worth writing the real thing.
 *
 * The structure follows Kiss FFT: factor the length, recurse depth-first over
 * the decimated sub-transforms, then apply one butterfly per stage with
 * hand-written cases for radix 2, 3, 4 and 5 and a generic DFT for anything
 * left. Every length these models ask for factors completely into 2, 3 and 5, so
 * the generic path is a correctness backstop rather than something we hit.
 *
 * Buffers and twiddles are allocated once per length and cached, because a
 * four-minute stereo track is around twenty thousand transforms and allocating
 * per frame would spend more time in the collector than in arithmetic.
 *
 * Verified against a naive O(n^2) DFT in tests/unit/fft.test.ts, at every length
 * the models use, to a relative error near double precision.
 */

/**
 * Interleaved complex data: re at 2i, im at 2i+1.
 *
 * Interleaved rather than split arrays because every butterfly touches both
 * halves of a value together, so one array keeps them on the same cache line.
 *
 * Float64 throughout, deliberately. The model wants float32 and audio does not
 * need more, but accumulating a 16384-point transform in float32 leaves error
 * around -70 dBFS, and the ISTFT overlap-add then sums four overlapping frames
 * of it. Reconstruction error that size is audible as a faint buzz on quiet
 * passages. Doubles put the round trip near -300 dB, which is free in comparison
 * to the model inference this feeds.
 */
export type Complex = Float64Array;

/** One factor pair of the decomposition: radix, and the sub-transform length. */
interface Stage {
  radix: number;
  m: number;
}

class Plan {
  readonly n: number;
  readonly stages: Stage[];
  /** Forward twiddles: exp(-2*pi*i*k/n) for k in [0, n). */
  readonly tw: Complex;
  /** Scratch for the generic radix butterfly, sized to the largest odd factor. */
  readonly scratch: Complex;

  constructor(n: number) {
    this.n = n;
    this.stages = factor(n);
    this.tw = new Float64Array(2 * n);
    for (let k = 0; k < n; k += 1) {
      const phase = (-2 * Math.PI * k) / n;
      this.tw[2 * k] = Math.cos(phase);
      this.tw[2 * k + 1] = Math.sin(phase);
    }
    let widest = 0;
    for (const stage of this.stages) widest = Math.max(widest, stage.radix);
    this.scratch = new Float64Array(2 * widest);
  }
}

/**
 * Decompose n into the stages the recursion walks.
 *
 * Fours before twos: a radix-4 butterfly does the work of two radix-2 stages
 * with fewer passes over memory and no multiplications for its quarter-turn
 * twiddle, which is the single biggest win available here. Remaining small
 * primes next, then any large prime factor is left for the generic case.
 */
function factor(n: number): Stage[] {
  const stages: Stage[] = [];
  let rest = n;
  while (rest > 1) {
    let radix: number;
    if (rest % 4 === 0) radix = 4;
    else if (rest % 2 === 0) radix = 2;
    else if (rest % 3 === 0) radix = 3;
    else if (rest % 5 === 0) radix = 5;
    else {
      // Smallest remaining prime factor, or rest itself when it is prime.
      radix = rest;
      for (let p = 7; p * p <= rest; p += 2) {
        if (rest % p === 0) {
          radix = p;
          break;
        }
      }
    }
    rest /= radix;
    stages.push({ radix, m: rest });
  }
  return stages;
}

const plans = new Map<number, Plan>();

function planFor(n: number): Plan {
  let plan = plans.get(n);
  if (!plan) {
    if (!Number.isInteger(n) || n < 1) {
      throw new Error(`FFT length must be a positive integer, got ${n}`);
    }
    plan = new Plan(n);
    plans.set(n, plan);
  }
  return plan;
}

/**
 * Depth-first Cooley-Tukey.
 *
 * `out` receives the transform of the input decimated by `stride`, reading from
 * `inp` at `inOff`. Recursing before butterflying is what keeps the reordering
 * implicit — there is no separate bit-reversal pass, because each level of
 * recursion picks up its own stride.
 */
function work(
  out: Complex,
  outOff: number,
  inp: Complex,
  inOff: number,
  stride: number,
  stageIndex: number,
  plan: Plan
): void {
  const { radix, m } = plan.stages[stageIndex]!;

  if (m === 1) {
    for (let i = 0; i < radix; i += 1) {
      const src = 2 * (inOff + i * stride);
      out[outOff + 2 * i] = inp[src]!;
      out[outOff + 2 * i + 1] = inp[src + 1]!;
    }
  } else {
    for (let i = 0; i < radix; i += 1) {
      work(out, outOff + 2 * i * m, inp, inOff + i * stride, stride * radix, stageIndex + 1, plan);
    }
  }

  switch (radix) {
    case 2:
      bfly2(out, outOff, stride, m, plan);
      break;
    case 3:
      bfly3(out, outOff, stride, m, plan);
      break;
    case 4:
      bfly4(out, outOff, stride, m, plan);
      break;
    case 5:
      bfly5(out, outOff, stride, m, plan);
      break;
    default:
      bflyGeneric(out, outOff, stride, m, radix, plan);
      break;
  }
}

function bfly2(out: Complex, off: number, stride: number, m: number, plan: Plan): void {
  const tw = plan.tw;
  let a = off;
  let b = off + 2 * m;
  for (let i = 0; i < m; i += 1) {
    const tr = tw[2 * i * stride]!;
    const ti = tw[2 * i * stride + 1]!;
    const br = out[b]!;
    const bi = out[b + 1]!;
    const xr = br * tr - bi * ti;
    const xi = br * ti + bi * tr;
    out[b] = out[a]! - xr;
    out[b + 1] = out[a + 1]! - xi;
    out[a] = out[a]! + xr;
    out[a + 1] = out[a + 1]! + xi;
    a += 2;
    b += 2;
  }
}

/** sin(2*pi/3), the imaginary part of the primitive cube root of unity. */
const SIN120 = Math.sin((2 * Math.PI) / 3);

function bfly3(out: Complex, off: number, stride: number, m: number, plan: Plan): void {
  const tw = plan.tw;
  const m2 = 2 * m;
  for (let i = 0; i < m; i += 1) {
    const a = off + 2 * i;
    const b = a + m2;
    const c = b + m2;

    const t1r = tw[2 * i * stride]!;
    const t1i = tw[2 * i * stride + 1]!;
    const t2r = tw[4 * i * stride]!;
    const t2i = tw[4 * i * stride + 1]!;

    const br = out[b]! * t1r - out[b + 1]! * t1i;
    const bi = out[b]! * t1i + out[b + 1]! * t1r;
    const cr = out[c]! * t2r - out[c + 1]! * t2i;
    const ci = out[c]! * t2i + out[c + 1]! * t2r;

    const sr = br + cr;
    const si = bi + ci;

    const ar = out[a]!;
    const ai = out[a + 1]!;
    out[a] = ar + sr;
    out[a + 1] = ai + si;

    // X1 = z0 - s/2 - i*k*d and X2 = z0 - s/2 + i*k*d, where k = sin(120) and
    // d = z1 - z2. Multiplying by -i*k swaps the parts and negates the new
    // imaginary one, so the real correction comes from d's imaginary half and
    // vice versa. Getting either sign wrong leaves the transform looking
    // plausible while being wrong by O(1), which is exactly what the DFT
    // cross-check caught.
    const hr = ar - 0.5 * sr;
    const hi = ai - 0.5 * si;
    const corrR = SIN120 * (bi - ci);
    const corrI = -SIN120 * (br - cr);
    out[b] = hr + corrR;
    out[b + 1] = hi + corrI;
    out[c] = hr - corrR;
    out[c + 1] = hi - corrI;
  }
}

function bfly4(out: Complex, off: number, stride: number, m: number, plan: Plan): void {
  const tw = plan.tw;
  const m2 = 2 * m;
  for (let i = 0; i < m; i += 1) {
    const a = off + 2 * i;
    const b = a + m2;
    const c = b + m2;
    const d = c + m2;

    const t1r = tw[2 * i * stride]!;
    const t1i = tw[2 * i * stride + 1]!;
    const t2r = tw[4 * i * stride]!;
    const t2i = tw[4 * i * stride + 1]!;
    const t3r = tw[6 * i * stride]!;
    const t3i = tw[6 * i * stride + 1]!;

    const br = out[b]! * t1r - out[b + 1]! * t1i;
    const bi = out[b]! * t1i + out[b + 1]! * t1r;
    const cr = out[c]! * t2r - out[c + 1]! * t2i;
    const ci = out[c]! * t2i + out[c + 1]! * t2r;
    const dr = out[d]! * t3r - out[d + 1]! * t3i;
    const di = out[d]! * t3i + out[d + 1]! * t3r;

    const ar = out[a]!;
    const ai = out[a + 1]!;

    // Sums across the two halves, then the quarter turn, which for a forward
    // transform is a multiply by -i and so costs only a swap and a sign.
    const s0r = ar + cr;
    const s0i = ai + ci;
    const s1r = ar - cr;
    const s1i = ai - ci;
    const s2r = br + dr;
    const s2i = bi + di;
    const s3r = br - dr;
    const s3i = bi - di;

    out[a] = s0r + s2r;
    out[a + 1] = s0i + s2i;
    out[c] = s0r - s2r;
    out[c + 1] = s0i - s2i;
    out[b] = s1r + s3i;
    out[b + 1] = s1i - s3r;
    out[d] = s1r - s3i;
    out[d + 1] = s1i + s3r;
  }
}

const SIN72 = Math.sin((2 * Math.PI) / 5);
const COS72 = Math.cos((2 * Math.PI) / 5);
const SIN144 = Math.sin((4 * Math.PI) / 5);
const COS144 = Math.cos((4 * Math.PI) / 5);

function bfly5(out: Complex, off: number, stride: number, m: number, plan: Plan): void {
  const tw = plan.tw;
  const m2 = 2 * m;
  for (let i = 0; i < m; i += 1) {
    const i0 = off + 2 * i;
    const i1 = i0 + m2;
    const i2 = i1 + m2;
    const i3 = i2 + m2;
    const i4 = i3 + m2;

    const z0r = out[i0]!;
    const z0i = out[i0 + 1]!;

    const rotated: number[] = [];
    for (let j = 1; j < 5; j += 1) {
      const idx = i0 + j * m2;
      const tr = tw[2 * j * i * stride]!;
      const ti = tw[2 * j * i * stride + 1]!;
      rotated.push(out[idx]! * tr - out[idx + 1]! * ti, out[idx]! * ti + out[idx + 1]! * tr);
    }
    const [z1r, z1i, z2r, z2i, z3r, z3i, z4r, z4i] = rotated as [
      number, number, number, number, number, number, number, number,
    ];

    const a14r = z1r + z4r;
    const a14i = z1i + z4i;
    const s14r = z1r - z4r;
    const s14i = z1i - z4i;
    const a23r = z2r + z3r;
    const a23i = z2i + z3i;
    const s23r = z2r - z3r;
    const s23i = z2i - z3i;

    out[i0] = z0r + a14r + a23r;
    out[i0 + 1] = z0i + a14i + a23i;

    const b1r = z0r + COS72 * a14r + COS144 * a23r;
    const b1i = z0i + COS72 * a14i + COS144 * a23i;
    const c1r = SIN72 * s14i + SIN144 * s23i;
    const c1i = -(SIN72 * s14r + SIN144 * s23r);

    const b2r = z0r + COS144 * a14r + COS72 * a23r;
    const b2i = z0i + COS144 * a14i + COS72 * a23i;
    const c2r = SIN144 * s14i - SIN72 * s23i;
    const c2i = -(SIN144 * s14r - SIN72 * s23r);

    out[i1] = b1r + c1r;
    out[i1 + 1] = b1i + c1i;
    out[i4] = b1r - c1r;
    out[i4 + 1] = b1i - c1i;
    out[i2] = b2r + c2r;
    out[i2 + 1] = b2i + c2i;
    out[i3] = b2r - c2r;
    out[i3 + 1] = b2i - c2i;
  }
}

/**
 * Any radix without a hand-written case: a direct DFT of length `radix`.
 *
 * Never reached by the model sizes, all of which are 2/3/5-smooth. It exists so
 * that a future model with, say, a 7-smooth length is slow rather than wrong.
 */
function bflyGeneric(
  out: Complex,
  off: number,
  stride: number,
  m: number,
  radix: number,
  plan: Plan
): void {
  const tw = plan.tw;
  const n = plan.n;
  const scratch = plan.scratch;

  for (let u = 0; u < m; u += 1) {
    for (let q = 0; q < radix; q += 1) {
      scratch[2 * q] = out[off + 2 * (u + q * m)]!;
      scratch[2 * q + 1] = out[off + 2 * (u + q * m) + 1]!;
    }
    for (let k = 0; k < radix; k += 1) {
      let sumR = scratch[0]!;
      let sumI = scratch[1]!;
      let twIndex = 0;
      for (let q = 1; q < radix; q += 1) {
        twIndex += stride * (u + k * m);
        if (twIndex >= n) twIndex -= n;
        const tr = tw[2 * twIndex]!;
        const ti = tw[2 * twIndex + 1]!;
        sumR += scratch[2 * q]! * tr - scratch[2 * q + 1]! * ti;
        sumI += scratch[2 * q]! * ti + scratch[2 * q + 1]! * tr;
      }
      out[off + 2 * (u + k * m)] = sumR;
      out[off + 2 * (u + k * m) + 1] = sumI;
    }
  }
}

/**
 * Forward transform. `input` and `output` are interleaved complex of length 2n
 * and may not be the same array — the recursion reads the input with strides
 * while writing the output contiguously.
 */
export function fft(input: Complex, output: Complex, n: number): void {
  const plan = planFor(n);
  if (input === output) throw new Error('fft cannot run in place');
  if (n === 1) {
    output[0] = input[0]!;
    output[1] = input[1]!;
    return;
  }
  work(output, 0, input, 0, 1, 0, plan);
}

/**
 * Inverse transform, scaled by 1/n so that ifft(fft(x)) === x.
 *
 * Implemented by conjugation rather than a second twiddle table: conjugate in,
 * forward transform, conjugate and scale out. One table, half the memory, and no
 * second code path to keep in step with the first.
 */
export function ifft(input: Complex, output: Complex, n: number): void {
  const plan = planFor(n);
  if (input === output) throw new Error('ifft cannot run in place');
  if (n === 1) {
    output[0] = input[0]!;
    output[1] = input[1]!;
    return;
  }

  // Conjugating the input in place would mutate the caller's buffer, so the
  // sign flip is folded into a scratch copy held by the plan.
  const conj = conjBuffer(n);
  for (let i = 0; i < n; i += 1) {
    conj[2 * i] = input[2 * i]!;
    conj[2 * i + 1] = -input[2 * i + 1]!;
  }
  work(output, 0, conj, 0, 1, 0, plan);
  const scale = 1 / n;
  for (let i = 0; i < n; i += 1) {
    output[2 * i] = output[2 * i]! * scale;
    output[2 * i + 1] = -output[2 * i + 1]! * scale;
  }
}

const conjBuffers = new Map<number, Complex>();

function conjBuffer(n: number): Complex {
  let buf = conjBuffers.get(n);
  if (!buf) {
    buf = new Float64Array(2 * n);
    conjBuffers.set(n, buf);
  }
  return buf;
}

/** Frees the cached plans. Only used by tests that measure allocation. */
export function clearFftPlans(): void {
  plans.clear();
  conjBuffers.clear();
}
