/**
 * The denoiser's numeric core, tested against real speech.
 *
 * This tool shipped silence once, so the first test here is the regression: run
 * actual audio through and assert something came back. The rest check the things
 * that were wrong or unverified underneath that — the frame delay the blend depends
 * on, and whether two states really are independent.
 *
 * The fixtures are a matched pair: ai-noisy.wav is ai-speech.wav with broadband
 * noise added at about -20 dB. They were built for the separation tests, and they
 * are borrowed rather than ideal — the "speech" is a continuous synthetic vocal with
 * no pauses in it. The model does read it as voice (probability 0.8) and leaves it
 * alone, so it is a fair test of noise reduction, but it cannot show suppression
 * between phrases because it never stops. That case gets a signal built in the test.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadRnnoise, RNNOISE_DELAY, RNNOISE_FRAME, RNNOISE_RATE } from '../../src/lib/ai/rnnoise';

const ROOT = resolve(__dirname, '../..');
const WASM = resolve(
  ROOT,
  'node_modules/@sapphi-red/web-noise-suppressor/dist/rnnoise.wasm'
);

/** Minimal 16-bit WAV reader: walks the chunk list rather than assuming offset 44. */
function readWav(path: string): { samples: Float32Array; sampleRate: number } {
  const bytes = readFileSync(path);
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  if (bytes.readUInt16LE(34) !== 16) throw new Error('fixture is not 16-bit');

  let offset = 12;
  while (offset < bytes.length - 8) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'data') {
      const count = Math.floor(size / 2 / channels);
      const samples = new Float32Array(count);
      for (let i = 0; i < count; i += 1) {
        samples[i] = bytes.readInt16LE(offset + 8 + i * 2 * channels) / 32768;
      }
      return { samples, sampleRate };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('no data chunk in fixture');
}

/**
 * Linear resample, good enough for a test.
 *
 * Both the noisy input and the clean reference go through this identically, so
 * whatever it costs in fidelity it costs both sides equally and the comparison
 * between them stays fair.
 */
function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input;
  const length = Math.round((input.length / from) * to);
  const output = new Float32Array(length);
  const step = from / to;
  for (let i = 0; i < length; i += 1) {
    const at = i * step;
    const low = Math.floor(at);
    const frac = at - low;
    output[i] = (input[low] ?? 0) * (1 - frac) + (input[low + 1] ?? 0) * frac;
  }
  return output;
}

const rms = (data: Float32Array, from = 0, to = data.length): number => {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += data[i]! * data[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
};

/** Runs a whole signal through one state, undoing the frame delay on the way out. */
function run(module: Awaited<ReturnType<typeof loadRnnoise>>, input: Float32Array): Float32Array {
  const state = module.createState();
  const output = new Float32Array(input.length);
  const frame = new Float32Array(RNNOISE_FRAME);
  const frames = Math.ceil((input.length + RNNOISE_DELAY) / RNNOISE_FRAME);

  try {
    for (let f = 0; f < frames; f += 1) {
      const start = f * RNNOISE_FRAME;
      for (let i = 0; i < RNNOISE_FRAME; i += 1) frame[i] = input[start + i] ?? 0;
      state.process(frame);
      for (let i = 0; i < RNNOISE_FRAME; i += 1) {
        const at = start + i - RNNOISE_DELAY;
        if (at >= 0 && at < output.length) output[at] = frame[i]!;
      }
    }
  } finally {
    state.destroy();
  }
  return output;
}

const load = () => loadRnnoise(readFileSync(WASM));

const fixture = (name: string, rate = RNNOISE_RATE): Float32Array => {
  const { samples, sampleRate } = readWav(resolve(ROOT, 'tests/fixtures', name));
  return resample(samples, sampleRate, rate);
};

describe('rnnoise', () => {
  it('instantiates from bytes with no Emscripten glue', async () => {
    const module = await load();
    const state = module.createState();
    expect(state).toBeTruthy();
    state.destroy();
  });

  it('returns audio rather than silence', async () => {
    // The regression. The AudioWorklet version returned a perfectly valid,
    // perfectly empty file for every input it was ever given.
    const module = await load();
    const speech = fixture('ai-speech.wav');
    const output = run(module, speech);

    expect(rms(speech)).toBeGreaterThan(0.01);
    expect(rms(output)).toBeGreaterThan(0.01);
  });

  it('reduces the added noise component', async () => {
    const module = await load();
    const clean = fixture('ai-speech.wav');
    const noisy = fixture('ai-noisy.wav');

    /**
     * Both signals are denoised and compared against each other, not against the
     * clean reference directly, and that control is the whole point of this test.
     *
     * Measured here: the added noise is 0.0112, but the model's own alteration of an
     * already-clean signal is 0.0179 — larger than the noise it is being asked to
     * remove. That is not a defect; it is overlap-add reconstruction plus spectral
     * gains, and it is inaudible. But it means a naive `||denoise(noisy) - clean||`
     * is dominated by reconstruction rather than by residual noise, and reports a
     * working denoiser as a broken one. Denoising the reference too subtracts that
     * common term and leaves the question actually being asked.
     */
    const distance = (a: Float32Array, b: Float32Array): number => {
      const n = Math.min(a.length, b.length);
      let sum = 0;
      for (let i = 0; i < n; i += 1) {
        const d = a[i]! - b[i]!;
        sum += d * d;
      }
      return Math.sqrt(sum / n);
    };

    const before = distance(noisy, clean);
    const after = distance(run(module, noisy), run(module, clean));
    expect(after).toBeLessThan(before);
  });

  it('attenuates steady noise in passages with no voice', async () => {
    /**
     * Built here rather than taken from the fixtures, because the fixtures cannot
     * show this. ai-speech.wav is a continuous synthetic vocal with no pauses, and
     * suppressing noise *between* phrases is exactly what RNNoise is for — there is
     * nowhere in that file for it to demonstrate the thing it is best at.
     *
     * So: alternating half-seconds of voiced and unvoiced, with the same steady
     * noise running underneath throughout. Deterministic, so this cannot flake.
     */
    const module = await load();
    const seconds = 4;
    const total = RNNOISE_RATE * seconds;
    const half = RNNOISE_RATE / 2;
    const signal = new Float32Array(total);

    let seed = 12345;
    const noise = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 0xffffffff - 0.5) * 0.12;
    };
    const voiced = (i: number): boolean => Math.floor(i / half) % 2 === 0;

    for (let i = 0; i < total; i += 1) {
      const t = i / RNNOISE_RATE;
      let voice = 0;
      if (voiced(i)) {
        for (let h = 1; h <= 6; h += 1) voice += Math.sin(2 * Math.PI * 120 * h * t) / h;
        voice *= 0.25 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t));
      }
      signal[i] = voice + noise();
    }

    const output = run(module, signal);

    // Skip the first half second, which the model spends settling.
    const spans = (want: boolean): [number, number][] => {
      const out: [number, number][] = [];
      for (let i = half; i + half <= total; i += half) {
        if (voiced(i) === want) out.push([i, i + half]);
      }
      return out;
    };
    const mean = (ranges: [number, number][], data: Float32Array): number =>
      ranges.reduce((sum, [a, b]) => sum + rms(data, a, b), 0) / ranges.length;

    const quietBefore = mean(spans(false), signal);
    const quietAfter = mean(spans(false), output);
    const voiceBefore = mean(spans(true), signal);
    const voiceAfter = mean(spans(true), output);

    // Noise-only passages come well down...
    expect(quietAfter).toBeLessThan(quietBefore * 0.75);
    // ...while the voice is left roughly intact, which is the harder half.
    expect(voiceAfter).toBeGreaterThan(voiceBefore * 0.85);
  });

  it('leaves the frame delay where the blend expects it', async () => {
    // denoise() shifts its output by RNNOISE_DELAY and blends the original against
    // it. If this constant ever stops matching the model, that blend silently
    // becomes a comb filter, so it is pinned here.
    const module = await load();
    const speech = fixture('ai-speech.wav');

    const state = module.createState();
    const raw = new Float32Array(speech.length);
    const frame = new Float32Array(RNNOISE_FRAME);
    for (let start = 0; start + RNNOISE_FRAME <= speech.length; start += RNNOISE_FRAME) {
      for (let i = 0; i < RNNOISE_FRAME; i += 1) frame[i] = speech[start + i]!;
      state.process(frame);
      raw.set(frame, start);
    }
    state.destroy();

    const correlate = (lag: number): number => {
      let dot = 0;
      let na = 0;
      let nb = 0;
      const from = Math.floor(speech.length * 0.3);
      const to = from + RNNOISE_RATE * 2;
      for (let i = from; i < to; i += 1) {
        const a = speech[i] ?? 0;
        const b = raw[i + lag] ?? 0;
        dot += a * b;
        na += a * a;
        nb += b * b;
      }
      return dot / (Math.sqrt(na * nb) || 1);
    };

    let best = 0;
    let bestScore = -Infinity;
    for (let lag = 0; lag <= RNNOISE_FRAME * 2; lag += 1) {
      const score = correlate(lag);
      if (score > bestScore) {
        bestScore = score;
        best = lag;
      }
    }

    expect(best).toBe(RNNOISE_DELAY);
    expect(bestScore).toBeGreaterThan(0.9);
  });

  it('keeps two states independent, as a stereo file needs', async () => {
    const module = await load();
    const speech = fixture('ai-speech.wav');
    const slice = speech.subarray(0, RNNOISE_FRAME * 40);

    // One state fed the signal, another fed silence first. If they shared any
    // internal state the second would not match a clean run.
    const a = run(module, Float32Array.from(slice));

    const primed = module.createState();
    const frame = new Float32Array(RNNOISE_FRAME);
    for (let i = 0; i < 20; i += 1) {
      frame.fill(0);
      primed.process(frame);
    }
    primed.destroy();

    const b = run(module, Float32Array.from(slice));
    expect(Array.from(b.subarray(0, 480))).toEqual(Array.from(a.subarray(0, 480)));
  });

  it('rejects a frame that is the wrong length', async () => {
    const module = await load();
    const state = module.createState();
    expect(() => state.process(new Float32Array(128))).toThrow(/480/);
    state.destroy();
  });
});
