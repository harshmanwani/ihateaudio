/**
 * Band-limited resampling, and the places that depend on it.
 *
 * The AI tools used to resample through an OfflineAudioContext on the belief
 * that it filters. In Chrome it interpolates linearly: a 44.1 kHz file through
 * the noise remover came back 5.5 dB down at 15 kHz, and a 48 kHz file reached
 * Whisper with a 10 kHz tone folded to 6 kHz at full level. These pin the
 * replacement's response with pure tones, where the right answer is exact.
 */
import { describe, expect, it } from 'vitest';
import { resampleChannel, resampleChannelSteps } from '../../src/lib/audio/resample';
import {
  changeSpeed,
  changeSpeedSliced,
  changeSpeedSteps,
  createBuffer,
  setChannels,
} from '../../src/lib/audio/dsp';
import { runSliced, type Steps } from '../../src/lib/audio/slices';
import { toSrt, toVtt, toWhisperInput } from '../../src/lib/ai/transcribe';

function tone(rate: number, freq: number, seconds = 1): Float32Array<ArrayBuffer> {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i += 1) out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** Level of `freq` in dB relative to the 0.5 amplitude of `tone`, away from the edges. */
function levelDb(data: Float32Array, rate: number, freq: number): number {
  const from = Math.round(data.length * 0.25);
  const to = Math.round(data.length * 0.75);
  let re = 0;
  let im = 0;
  for (let i = from; i < to; i += 1) {
    re += data[i]! * Math.cos((2 * Math.PI * freq * i) / rate);
    im += data[i]! * Math.sin((2 * Math.PI * freq * i) / rate);
  }
  return 20 * Math.log10((2 * Math.hypot(re, im)) / (to - from) / 0.5);
}

describe('resampleChannel', () => {
  it('keeps the treble flat between 44.1 and 48 kHz, both ways', () => {
    for (const [from, to] of [
      [44100, 48000],
      [48000, 44100],
    ] as const) {
      for (const freq of [1000, 10000, 15000, 18000]) {
        const out = resampleChannel(tone(from, freq), from, to);
        expect(Math.abs(levelDb(out, to, freq))).toBeLessThan(0.1);
      }
    }
  });

  it('removes what the lower rate cannot hold instead of folding it back', () => {
    // 10 kHz is above 16 kHz's Nyquist and would alias to 6 kHz.
    const out = resampleChannel(tone(48000, 10000), 48000, 16000);
    expect(levelDb(out, 16000, 6000)).toBeLessThan(-60);
  });

  it('lands on the requested length', () => {
    expect(resampleChannel(tone(44100, 440), 44100, 48000).length).toBe(48000);
    expect(resampleChannel(tone(48000, 440), 48000, 44100, 44099).length).toBe(44099);
  });
});

describe('toWhisperInput', () => {
  it('gives Whisper 16 kHz mono without the band above 8 kHz folded into it', async () => {
    const rate = 48000;
    const buffer = new AudioBuffer({ numberOfChannels: 2, length: rate, sampleRate: rate });
    buffer.copyToChannel(tone(rate, 1000), 0);
    buffer.copyToChannel(tone(rate, 10000), 1);

    const out = await toWhisperInput(buffer);
    expect(out.length).toBe(16000);
    // Each channel is half the mono mix, so the 1 kHz tone is 6 dB down. The
    // 10 kHz tone must not reappear at 6 kHz.
    expect(levelDb(out, 16000, 1000)).toBeCloseTo(-6.02, 1);
    expect(levelDb(out, 16000, 6000)).toBeLessThan(-60);
  });
});

describe('subtitle times', () => {
  it('carries a rounded millisecond into the seconds', () => {
    const segments = [{ start: 0, end: 2.9996, text: 'Hello' }];
    expect(toSrt(segments)).toContain('00:00:00,000 --> 00:00:03,000');
    expect(toVtt(segments)).toContain('00:00:00.000 --> 00:00:03.000');
  });
});

describe('setChannels to stereo from surround', () => {
  it('folds the 5.1 centre into both sides rather than dropping it', () => {
    const length = 100;
    const buffer = new AudioBuffer({ numberOfChannels: 6, length, sampleRate: 48000 });
    // Dialogue lives in the centre channel (index 2) and nowhere else.
    buffer.copyToChannel(new Float32Array(length).fill(0.5), 2);

    const stereo = setChannels(buffer, 2);
    expect(stereo.getChannelData(0)[50]).toBeCloseTo(0.5 * Math.SQRT1_2, 5);
    expect(stereo.getChannelData(1)[50]).toBeCloseTo(0.5 * Math.SQRT1_2, 5);
  });
});

/** Deterministic noise in -1..1, so a failure reproduces. */
function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 31 - 1;
  };
}

/** A tone, a 15 kHz tone that a fall in rate must filter out, and some noise. */
function material(length: number, rate: number, seed: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(length);
  const random = noise(seed);
  for (let i = 0; i < length; i += 1) {
    const t = i / rate;
    out[i] =
      0.4 * Math.sin(2 * Math.PI * 440 * t) + 0.25 * Math.sin(2 * Math.PI * 15000 * t) + 0.2 * random();
  }
  return out;
}

function stereo(length: number, rate: number): AudioBuffer {
  const buffer = createBuffer(2, length, rate);
  buffer.copyToChannel(material(length, rate, 10), 0);
  buffer.copyToChannel(material(length, rate, 11), 1);
  return buffer;
}

/** FNV-1a over the bits of every sample, so one hash pins a whole channel. */
function bitsHash(data: Float32Array): string {
  const bits = new Uint32Array(data.buffer, data.byteOffset, data.length);
  let hash = 0x811c9dc5;
  for (let i = 0; i < bits.length; i += 1) {
    let word = bits[i]!;
    for (let b = 0; b < 4; b += 1) {
      hash = Math.imul(hash ^ (word & 0xff), 0x01000193) >>> 0;
      word >>>= 8;
    }
  }
  return hash.toString(16).padStart(8, '0');
}

/** The first sample that differs by Object.is (so even the sign of a zero counts), or -1. */
function firstDifference(actual: Float32Array, expected: Float32Array): number {
  if (actual.length !== expected.length) return Math.min(actual.length, expected.length);
  for (let i = 0; i < actual.length; i += 1) {
    if (!Object.is(actual[i], expected[i])) return i;
  }
  return -1;
}

/** Runs steps and counts the pauses, so a test can tell they really paused. */
function countPauses<T>(steps: Steps<T>): { value: T; pauses: number } {
  let pauses = 0;
  for (;;) {
    const next = steps.next();
    if (next.done) return { value: next.value, pauses };
    pauses += 1;
  }
}

describe('resampleChannel, sliced', () => {
  const cases: [string, number, number, number][] = [
    ['44.1 to 48 kHz', 44100, 48000, 30011],
    ['48 to 16 kHz', 48000, 16000, 24007],
    ['slowed to 0.85x', 44100, 44100 / 0.85, 22051],
    ['nightcore at 1.25x', 44100, 44100 / 1.25, 22051],
    ['8 kHz up 3.7 times', 8000, 8000 * 3.7, 999],
  ];

  for (const [name, from, to, length] of cases) {
    it(`matches the unbroken pass: ${name}`, async () => {
      const input = material(length, from, 3);
      const whole = resampleChannel(input, from, to);

      // A prime chunk puts every pause somewhere a power of two would not.
      const odd = countPauses(resampleChannelSteps(input, from, to, undefined, 997));
      expect(odd.pauses).toBeGreaterThan(whole.length / 997);
      expect(firstDifference(odd.value, whole)).toBe(-1);

      const single = countPauses(resampleChannelSteps(input, from, to, undefined, 1));
      expect(single.pauses).toBe(whole.length);
      expect(firstDifference(single.value, whole)).toBe(-1);

      const sliced = await runSliced(resampleChannelSteps(input, from, to), { sliceMs: 0 });
      expect(firstDifference(sliced, whole)).toBe(-1);
    });
  }

  it('lands on a pinned length the same way when sliced', () => {
    const input = material(44100, 48000, 4);
    const whole = resampleChannel(input, 48000, 44100, 40000);
    const odd = countPauses(resampleChannelSteps(input, 48000, 44100, 40000, 333));
    expect(odd.value.length).toBe(40000);
    expect(firstDifference(odd.value, whole)).toBe(-1);
  });

  it('copies straight through at the same rate, without pausing', () => {
    const input = material(5000, 44100, 5);
    const same = countPauses(resampleChannelSteps(input, 44100, 44100, 4000, 7));
    expect(same.pauses).toBe(0);
    expect(firstDifference(same.value, input.subarray(0, 4000))).toBe(-1);
  });

  it('still gives exactly what it gave before slicing', () => {
    // Pinned from resampleChannel as it was before it was split into steps
    // (commit a368cb6), every sample to the last bit through the hash.
    const pins: [number, number, number, number, number, string, number, number][] = [
      [44100, 48000, 30011, 1, 32665, '41090b14', 0.5184067487716675, -0.4765651524066925],
      [48000, 16000, 24007, 2, 8002, '81da4062', 0.48381033539772034, 0.1883755624294281],
      [44100, 44100 / 0.85, 22051, 3, 25942, '3e226319', 0.2858070135116577, 0.04674708843231201],
      [44100, 44100 / 1.25, 22051, 4, 17641, 'a00c7843', 0.2830052077770233, -0.11933623999357224],
      [8000, 8000 * 3.7, 999, 5, 3696, '731b94d9', -0.07677518576383591, -0.06494318693876266],
    ];
    for (const [from, to, length, seed, outLength, hash, seventh, middle] of pins) {
      const out = resampleChannel(material(length, from, seed), from, to);
      expect(out.length).toBe(outLength);
      expect(bitsHash(out)).toBe(hash);
      expect(out[7]).toBe(seventh);
      expect(out[out.length >> 1]).toBe(middle);
    }
  });
});

describe('changeSpeed, sliced', () => {
  const cases: [string, number, number, number][] = [
    ['slowed, 0.85x', 44100, 0.85, 26460],
    ['nightcore, 1.25x', 44100, 1.25, 26460],
    ['slowest, 0.25x', 48000, 0.25, 4801],
    ['fastest, 4x', 44100, 4, 26460],
  ];

  for (const [name, rate, speed, length] of cases) {
    it(`matches the unbroken pass: ${name}`, async () => {
      const buffer = stereo(length, rate);
      const whole = changeSpeed(buffer, speed);
      const sliced = await changeSpeedSliced(buffer, speed, { sliceMs: 0 });
      expect(sliced.length).toBe(whole.length);
      expect(sliced.sampleRate).toBe(rate);
      for (let c = 0; c < 2; c += 1) {
        expect(firstDifference(sliced.getChannelData(c), whole.getChannelData(c))).toBe(-1);
      }
    });
  }

  it('still gives exactly what it gave before slicing', () => {
    // Pinned from changeSpeed as it was before it was split into steps (commit
    // a368cb6), every sample to the last bit through the hash.
    const pins: [number, number, number, number, string, string, number][] = [
      [44100, 0.85, 26460, 31129, '4498065d', '2a42f4d7', -0.1230987012386322],
      [44100, 1.25, 26460, 21168, 'd83aa442', '39c37507', 0.04134576767683029],
      [48000, 0.25, 4801, 19204, '38f83194', '6d9e4853', 0.04837700352072716],
      [44100, 1.45, 26460, 18248, '0026f774', '6e0405c6', 0.0322234220802784],
      [44100, 0.7, 26460, 37800, '36a578fc', 'dba58741', 0.00513142254203558],
    ];
    for (const [rate, speed, length, outLength, left, right, middle] of pins) {
      const out = changeSpeed(stereo(length, rate), speed);
      expect(out.length).toBe(outLength);
      expect(out.sampleRate).toBe(rate);
      expect(bitsHash(out.getChannelData(0))).toBe(left);
      expect(bitsHash(out.getChannelData(1))).toBe(right);
      expect(out.getChannelData(0)[outLength >> 1]).toBe(middle);
    }
  });

  it('speeds an 8 kHz file up 4x, below the lowest rate a buffer may have', () => {
    // It used to resample into a buffer at the new rate, 2 kHz here, which no
    // AudioBuffer accepts.
    const buffer = stereo(9001, 8000);
    const out = changeSpeed(buffer, 4);
    expect(out.length).toBe(2250);
    expect(out.sampleRate).toBe(8000);
    const left = resampleChannel(buffer.getChannelData(0), 8000, 2000, 2250);
    expect(firstDifference(out.getChannelData(0), left)).toBe(-1);
  });

  it('reports progress across both channels, rising to 1', () => {
    const seen: number[] = [];
    const steps = changeSpeedSteps(stereo(44100, 44100), 0.85);
    for (let next = steps.next(); !next.done; next = steps.next()) seen.push(next.value);
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.every((ratio, i) => i === 0 || ratio > seen[i - 1]!)).toBe(true);
    expect(seen.some((ratio) => Math.abs(ratio - 0.5) < 1e-12)).toBe(true);
    expect(seen.at(-1)).toBe(1);
  });

  it('stops at the next pause when aborted', async () => {
    const controller = new AbortController();
    let slices = 0;
    const run = changeSpeedSliced(stereo(44100 * 4, 44100), 0.85, {
      sliceMs: 0,
      signal: controller.signal,
      onProgress: () => {
        slices += 1;
        if (slices === 2) controller.abort();
      },
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(slices).toBe(2);
  });
});
