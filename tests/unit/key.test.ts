/**
 * Key detection, checked against material whose key is known by construction.
 *
 * The whole test rests on being able to synthesise a chord progression in a chosen
 * key and assert the detector finds it. That is a stronger check than running it on
 * a real song, because with a real song you are trusting somebody's tagging — and
 * arguing about whether a track is in D minor or F major is a genuine musical
 * disagreement, not a bug.
 */
import { describe, expect, it } from 'vitest';
import {
  camelot,
  chromagram,
  detectKey,
  keyName,
  rankKeys,
} from '../../src/lib/audio/key';

const RATE = 44100;

/** Semitone offsets from the root for the chords used below. */
const MAJOR_TRIAD = [0, 4, 7];
const MINOR_TRIAD = [0, 3, 7];

function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/**
 * Renders a chord progression as a stack of harmonically rich tones.
 *
 * Several harmonics per note rather than pure sines, because a pure sine puts all
 * its energy in one bin and makes the task artificially easy. Real instruments have
 * overtones that land on other pitch classes, which is the thing the chromagram has
 * to cope with.
 */
function renderProgression(
  rootMidi: number,
  degrees: { degree: number; triad: number[] }[],
  secondsEach = 1
): AudioBuffer {
  const length = Math.round(RATE * secondsEach * degrees.length);
  const data = new Float32Array(length);

  degrees.forEach((chord, index) => {
    const start = Math.round(index * secondsEach * RATE);
    const end = Math.min(length, Math.round((index + 1) * secondsEach * RATE));
    for (const interval of chord.triad) {
      const midi = rootMidi + chord.degree + interval;
      const frequency = midiToHz(midi);
      for (let harmonic = 1; harmonic <= 4; harmonic += 1) {
        const f = frequency * harmonic;
        if (f > RATE / 2) break;
        const amplitude = 0.12 / harmonic;
        for (let i = start; i < end; i += 1) {
          const t = (i - start) / RATE;
          // A gentle decay, so each chord has an attack rather than being a
          // continuous drone that smears across the window boundaries.
          const envelope = Math.exp(-t * 1.1);
          data[i] = data[i]! + Math.sin(2 * Math.PI * f * t) * amplitude * envelope;
        }
      }
    }
  });

  return {
    numberOfChannels: 1,
    length,
    sampleRate: RATE,
    duration: length / RATE,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

/** I - V - vi - IV, the most common progression in popular music. */
const MAJOR_PROGRESSION = [
  { degree: 0, triad: MAJOR_TRIAD },
  { degree: 7, triad: MAJOR_TRIAD },
  { degree: 9, triad: MINOR_TRIAD },
  { degree: 5, triad: MAJOR_TRIAD },
];

/**
 * i - iv - V - i, which is unambiguously minor.
 *
 * The obvious choice, i - VI - III - VII, is not testable: in A minor those chords
 * are Am, F, C and G, which are exactly C major's vi, IV, I and V. The progression
 * genuinely belongs to both keys, so a detector answering "C major" is right, and an
 * earlier version of this test was failing the code for giving a correct answer to
 * an unanswerable question.
 *
 * A major V is what settles it. In A minor that chord is E major, whose G♯ is the
 * leading tone — a note C major does not contain. Ending back on the tonic weights
 * the chromagram toward it as well.
 */
const MINOR_PROGRESSION = [
  { degree: 0, triad: MINOR_TRIAD },
  { degree: 5, triad: MINOR_TRIAD },
  { degree: 7, triad: MAJOR_TRIAD },
  { degree: 0, triad: MINOR_TRIAD },
];

describe('keyName', () => {
  it('uses flats where that is the conventional spelling', () => {
    // Nobody writes "A♯ minor" — it has ten sharps. B♭ minor has five flats.
    expect(keyName(10, 'minor')).toBe('B♭ minor');
    expect(keyName(3, 'major')).toBe('E♭ major');
    expect(keyName(6, 'minor')).toBe('G♭ minor');
  });

  it('uses sharps where that is the conventional spelling', () => {
    expect(keyName(6, 'major')).toBe('F♯ major');
    expect(keyName(9, 'minor')).toBe('A minor');
    expect(keyName(0, 'major')).toBe('C major');
  });
});

describe('camelot', () => {
  it('places C major and A minor at the anchor positions', () => {
    // The two most commonly cited reference points on the wheel.
    expect(camelot(0, 'major')).toBe('8B');
    expect(camelot(9, 'minor')).toBe('8A');
  });

  it('gives every key a distinct position', () => {
    const seen = new Set<string>();
    for (let tonic = 0; tonic < 12; tonic += 1) {
      seen.add(camelot(tonic, 'major'));
      seen.add(camelot(tonic, 'minor'));
    }
    expect(seen.size).toBe(24);
  });
});

describe('chromagram', () => {
  it('puts a single note in its own pitch class', () => {
    // A4 is 440 Hz and pitch class 9.
    const buffer = renderProgression(69, [{ degree: 0, triad: [0] }], 2);
    const chroma = chromagram(buffer);
    const loudest = chroma.indexOf(Math.max(...Array.from(chroma)));
    expect(loudest).toBe(9);
  });

  it('sums to one so tracks of different loudness compare', () => {
    const chroma = chromagram(renderProgression(60, MAJOR_PROGRESSION));
    const total = Array.from(chroma).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });
});

describe('detectKey', () => {
  /**
   * Every major key, so a bug that works at C and fails elsewhere cannot hide.
   * Root 60 is middle C, so the offset is the tonic's pitch class directly.
   */
  it.each([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])(
    'finds the major key rooted at pitch class %i',
    (tonic) => {
      const result = detectKey(renderProgression(60 + tonic, MAJOR_PROGRESSION));
      expect(result.best.tonic).toBe(tonic);
      expect(result.best.mode).toBe('major');
    },
    30_000
  );

  it.each([0, 3, 5, 7, 9, 11])(
    'finds the minor key rooted at pitch class %i',
    (tonic) => {
      const result = detectKey(renderProgression(60 + tonic, MINOR_PROGRESSION));
      expect(result.best.tonic).toBe(tonic);
      expect(result.best.mode).toBe('minor');
    },
    30_000
  );

  it('reports a runner-up and a confidence between 0 and 1', () => {
    const result = detectKey(renderProgression(60, MAJOR_PROGRESSION));
    expect(result.runnerUp.name).not.toBe(result.best.name);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(result.best.score).toBeGreaterThanOrEqual(result.runnerUp.score);
  }, 30_000);

  it('ranks all twenty-four keys', () => {
    const ranked = rankKeys(chromagram(renderProgression(60, MAJOR_PROGRESSION)));
    expect(ranked).toHaveLength(24);
    for (let i = 1; i < ranked.length; i += 1) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
  }, 30_000);
});
