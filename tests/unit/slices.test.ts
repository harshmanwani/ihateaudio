/**
 * Whole-file analyses run a slice at a time.
 *
 * Slicing is only allowed to change when the work happens, never what it
 * computes. Each analysis is compared value for value (Object.is, so even the
 * sign of a zero counts) across three ways of running it: unbroken, with the
 * pauses at awkward places, and through runSliced with a pause after every step.
 */
import { describe, expect, it } from 'vitest';
import {
  loudnessSteps,
  measureLoudness,
  measureLoudnessSliced,
  type LoudnessResult,
} from '../../src/lib/audio/analysis';
import { chromagramSteps, detectKey, detectKeySliced } from '../../src/lib/audio/key';
import { applyGain, applyGainSliced, createBuffer, gainSteps } from '../../src/lib/audio/dsp';
import { runAll, runSliced, type Steps } from '../../src/lib/audio/slices';

/** Deterministic noise in -1..1, so a failure reproduces. */
function noise(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 31 - 1;
  };
}

/**
 * Something with the features each stage reacts to: a level that moves (the
 * gates and the loudness range), a quiet stretch below the absolute gate, and a
 * quarter-rate tone whose crests fall between samples (the true peak).
 */
function material(seconds: number, rate: number, channels: number, seed = 1): AudioBuffer {
  const length = Math.round(seconds * rate);
  const buffer = createBuffer(channels, length, rate);
  const random = noise(seed);
  for (let c = 0; c < channels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) {
      const t = i / rate;
      const level = 0.15 + 0.6 * Math.abs(Math.sin(t * 0.7 + c));
      const quiet = t % 9 > 7.5 ? 0.0001 : 1;
      const tone = Math.sin(2 * Math.PI * (220 * (c + 1)) * t);
      const crest = t > 2 && t < 2.5 ? 0.97 * Math.sin((Math.PI * i) / 2 + Math.PI / 4) : 0;
      data[i] = quiet * (level * (0.5 * tone + 0.3 * random())) + crest;
    }
  }
  return buffer;
}

function expectIdentical(actual: LoudnessResult, expected: LoudnessResult): void {
  for (const key of ['integrated', 'range', 'truePeak', 'peak', 'momentaryStep'] as const) {
    expect(Object.is(actual[key], expected[key]), `${key}: ${actual[key]} vs ${expected[key]}`).toBe(true);
  }
  expect(actual.momentary.length).toBe(expected.momentary.length);
  const differs = actual.momentary.findIndex((v, i) => !Object.is(v, expected.momentary[i]));
  expect(differs).toBe(-1);
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

describe('measureLoudness, sliced', () => {
  const cases: [string, AudioBuffer][] = [
    ['stereo, 44.1 kHz, 12 s', material(12, 44100, 2)],
    ['5.1 surround, 8 kHz, 10 s', material(10, 8000, 6, 7)],
    ['mono, 48 kHz, 4.3 s', material(4.3, 48000, 1, 3)],
    ['shorter than one gating block', material(0.3, 44100, 2, 5)],
    ['digital silence', createBuffer(2, 44100 * 3, 44100)],
  ];

  for (const [name, buffer] of cases) {
    it(`matches the unbroken pass: ${name}`, async () => {
      const whole = runAll(loudnessSteps(buffer, Infinity));

      expectIdentical(measureLoudness(buffer), whole);

      // A prime chunk puts every pause somewhere a power of two would not.
      const odd = countPauses(loudnessSteps(buffer, 997));
      expect(odd.pauses).toBeGreaterThan(buffer.length / 997);
      expectIdentical(odd.value, whole);

      expectIdentical(await measureLoudnessSliced(buffer, { sliceMs: 0 }), whole);
    });
  }

  it('still measures exactly what it measured before slicing', () => {
    // Pinned from measureLoudness as it was before it was split into steps
    // (commit 4e90c24), to the last bit.
    const stereo = measureLoudness(material(12, 44100, 2));
    expect(stereo.integrated).toBe(-6.693518593142058);
    expect(stereo.range).toBe(8.75199440003512);
    expect(stereo.truePeak).toBe(4.390764553859051);
    expect(stereo.peak).toBe(2.155507238881984);
    expect(stereo.momentary.length).toBe(117);

    const surround = measureLoudness(material(10, 8000, 6, 7));
    expect(surround.integrated).toBe(-2.044076083988819);
    expect(surround.range).toBe(8.344229108829294);
    expect(surround.truePeak).toBe(4.533424738692302);
    expect(surround.peak).toBe(2.154650839550078);
    expect(surround.momentary.length).toBe(97);
  });
});

describe('detectKey, sliced', () => {
  // A C major chord with overtones, long enough for many analysis frames.
  const rate = 22050;
  const buffer = createBuffer(2, rate * 6, rate);
  for (let c = 0; c < 2; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i += 1) {
      let v = 0;
      for (const midi of [60, 64, 67]) {
        const hz = 440 * 2 ** ((midi - 69) / 12);
        for (let h = 1; h <= 3; h += 1) v += Math.sin((2 * Math.PI * hz * h * i) / rate) / h;
      }
      data[i] = 0.1 * v;
    }
  }

  it('matches the unbroken pass', async () => {
    const whole = runAll(chromagramSteps(buffer, Infinity));
    const odd = countPauses(chromagramSteps(buffer, 3));
    expect(odd.pauses).toBeGreaterThan(5);
    expect(Array.from(odd.value)).toEqual(Array.from(whole));

    const one = detectKey(buffer);
    const sliced = await detectKeySliced(buffer, { sliceMs: 0 });
    expect(Array.from(one.chroma)).toEqual(Array.from(whole));
    expect(sliced).toEqual(one);
    expect(sliced.best.name).toBe('C major');
  });
});

describe('applyGain, sliced', () => {
  it('matches the unbroken pass, clipped and not', async () => {
    const buffer = material(1.3, 44100, 2, 9);
    for (const [db, clip] of [
      [6, true],
      [-3.7, false],
      [12, false],
    ] as const) {
      const whole = applyGain(buffer, db, clip);
      const odd = countPauses(gainSteps(buffer, db, clip, 1009));
      const sliced = await applyGainSliced(buffer, db, { clip, sliceMs: 0 });
      expect(odd.pauses).toBeGreaterThan(buffer.length / 1009);
      for (let c = 0; c < buffer.numberOfChannels; c += 1) {
        expect(odd.value.getChannelData(c)).toEqual(whole.getChannelData(c));
        expect(sliced.getChannelData(c)).toEqual(whole.getChannelData(c));
      }
    }
  });
});

describe('runSliced', () => {
  function* counting(steps: number): Steps<number> {
    for (let i = 1; i <= steps; i += 1) yield i / steps;
    return steps;
  }

  it('reports progress that only rises and ends at 1', async () => {
    const seen: number[] = [];
    const value = await runSliced(counting(20), {
      sliceMs: 0,
      onProgress: (ratio) => seen.push(ratio),
    });
    expect(value).toBe(20);
    expect(seen.length).toBeGreaterThan(10);
    expect(seen.every((ratio, i) => i === 0 || ratio >= seen[i - 1]!)).toBe(true);
    expect(seen.at(-1)).toBe(1);
  });

  it('gives the browser a turn between slices', async () => {
    let otherWork = 0;
    const tick = (): void => {
      otherWork += 1;
      if (otherWork < 1000) setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
    await runSliced(counting(200), { sliceMs: 0 });
    expect(otherWork).toBeGreaterThan(0);
  });

  it('stops at the next pause when aborted, with an AbortError', async () => {
    const controller = new AbortController();
    let taken = 0;
    function* endless(): Steps<never> {
      for (;;) {
        taken += 1;
        yield 0;
      }
    }
    const run = runSliced(endless(), {
      sliceMs: 0,
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(taken).toBe(1);
  });

  it('refuses to start when already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runSliced(counting(3), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
