/**
 * Musical key detection.
 *
 * Two steps, both old and both well understood.
 *
 * First, a chromagram: the track's energy folded onto the twelve pitch classes,
 * so every C in every octave adds into one bucket. What comes out is a twelve-number
 * summary of which notes the piece actually spends its time on.
 *
 * Second, correlation against key profiles. Krumhansl and Kessler asked listeners
 * how well each of the twelve notes fitted an established key, and the resulting
 * twenty-four profiles — one major, one minor, rotated to each root — are still the
 * standard reference. The key whose profile correlates best with the chromagram wins.
 *
 * This is deliberately not a neural network. Key detection is one of the few music
 * problems where the classical method is both excellent and cheap, and it needs no
 * download at all, which matters more here than the last few points of accuracy.
 */
import { fft } from './fft';
import { hannPeriodic } from './stft';

export const NOTE_NAMES = [
  'C',
  'C♯',
  'D',
  'D♯',
  'E',
  'F',
  'F♯',
  'G',
  'G♯',
  'A',
  'A♯',
  'B',
] as const;

/** The same notes written with flats, which is how some keys are conventionally named. */
const FLAT_NAMES = [
  'C',
  'D♭',
  'D',
  'E♭',
  'E',
  'F',
  'G♭',
  'G',
  'A♭',
  'A',
  'B♭',
  'B',
] as const;

/**
 * Keys conventionally written with flats rather than sharps.
 *
 * Purely a naming convention, but getting it wrong is the sort of thing a musician
 * notices immediately: nobody calls it "A# minor" when "B flat minor" is the name
 * with five flats instead of ten sharps.
 */
const FLAT_MAJOR = new Set([1, 3, 5, 8, 10]);
const FLAT_MINOR = new Set([1, 3, 6, 8, 10]);

export type Mode = 'major' | 'minor';

export interface KeyCandidate {
  tonic: number;
  mode: Mode;
  /** Correlation with the profile, -1 to 1. */
  score: number;
  /** "F# minor". */
  name: string;
}

export interface KeyResult {
  best: KeyCandidate;
  /** Next best, which is what tells you how much to trust the first. */
  runnerUp: KeyCandidate;
  /**
   * 0..1. The gap between the top two correlations, scaled.
   *
   * Reported because key detection is genuinely ambiguous on some material and
   * pretending otherwise is worse than saying so. A piece that sits between its
   * relative major and minor will score both nearly equally, and that is a real
   * property of the music rather than a failure of the tool.
   */
  confidence: number;
  /** The twelve pitch-class weights, normalised, for the UI to draw. */
  chroma: Float64Array;
}

/**
 * Krumhansl-Kessler probe-tone profiles, major and minor.
 *
 * These are experimental data, not a formula: listeners rated how well each note
 * fitted a previously established key, averaged. The shape is what matters — the
 * tonic highest, then the fifth, then the third — and it is why correlation against
 * them identifies a key rather than merely the most common note.
 */
const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

export function keyName(tonic: number, mode: Mode): string {
  const flats = mode === 'major' ? FLAT_MAJOR : FLAT_MINOR;
  const names = flats.has(tonic) ? FLAT_NAMES : NOTE_NAMES;
  return `${names[tonic]} ${mode}`;
}

/**
 * The Camelot wheel position, which is what DJ software labels tracks with.
 *
 * Included because it is the form most people actually need: "8A" tells a DJ
 * instantly what mixes with what, where "A minor" requires them to think.
 */
export function camelot(tonic: number, mode: Mode): string {
  // Positions run around the circle of fifths. 8B is C major, 8A is A minor.
  const majorWheel = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
  if (mode === 'major') return `${majorWheel[tonic]!}B`;

  // A minor key shares its number with its relative major, three semitones up —
  // that shared number is the whole point of the wheel, because relative keys have
  // the same notes and therefore mix freely. A minor is 8A precisely because C
  // major is 8B.
  return `${majorWheel[(tonic + 3) % 12]!}A`;
}

/** Pearson correlation, which is what makes the comparison scale-invariant. */
function correlate(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < 12; i += 1) {
    meanA += a[i]!;
    meanB += b[i]!;
  }
  meanA /= 12;
  meanB /= 12;

  let num = 0;
  let devA = 0;
  let devB = 0;
  for (let i = 0; i < 12; i += 1) {
    const da = a[i]! - meanA;
    const db = b[i]! - meanB;
    num += da * db;
    devA += da * da;
    devB += db * db;
  }
  const denominator = Math.sqrt(devA * devB);
  return denominator > 0 ? num / denominator : 0;
}

/**
 * Folds a track's spectrum onto the twelve pitch classes.
 *
 * Analysed in overlapping windows and summed, because key is a property of the
 * whole piece rather than of any moment. Only bins between roughly 65 Hz and
 * 2 kHz contribute: below that the fundamental is muddled by the bass drum and
 * room, above it the harmonics of everything overlap so heavily that the mapping
 * from frequency to pitch class stops meaning much.
 */
export function chromagram(buffer: AudioBuffer): Float64Array {
  const rate = buffer.sampleRate;
  const size = 8192;
  const hop = size >> 1;
  const window = hannPeriodic(size);

  const chroma = new Float64Array(12);
  const frame = new Float64Array(2 * size);
  const spec = new Float64Array(2 * size);

  // Mono, because key is not a stereo property and averaging halves the work.
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const mono = new Float32Array(length);
  for (let c = 0; c < channels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) mono[i] = mono[i]! + data[i]! / channels;
  }

  const lowBin = Math.max(1, Math.floor((65 * size) / rate));
  const highBin = Math.min(size >> 1, Math.ceil((2000 * size) / rate));

  for (let start = 0; start + size <= length; start += hop) {
    for (let i = 0; i < size; i += 1) {
      frame[2 * i] = mono[start + i]! * window[i]!;
      frame[2 * i + 1] = 0;
    }
    fft(frame, spec, size);

    for (let bin = lowBin; bin < highBin; bin += 1) {
      const real = spec[2 * bin]!;
      const imag = spec[2 * bin + 1]!;
      const magnitude = Math.sqrt(real * real + imag * imag);
      if (magnitude <= 0) continue;

      const frequency = (bin * rate) / size;
      // MIDI note number, then fold to a pitch class. 69 is A4 at 440 Hz.
      const midi = 69 + 12 * Math.log2(frequency / 440);
      const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
      // Magnitude rather than power: power lets one loud bass note dominate the
      // whole profile, which biases every result toward the root of the loudest
      // moment rather than the key of the piece.
      chroma[pitchClass] = chroma[pitchClass]! + magnitude;
    }
  }

  let total = 0;
  for (let i = 0; i < 12; i += 1) total += chroma[i]!;
  if (total > 0) for (let i = 0; i < 12; i += 1) chroma[i] = chroma[i]! / total;
  return chroma;
}

/** Correlates a chromagram against all twenty-four keys, best first. */
export function rankKeys(chroma: ArrayLike<number>): KeyCandidate[] {
  const candidates: KeyCandidate[] = [];

  for (let tonic = 0; tonic < 12; tonic += 1) {
    for (const mode of ['major', 'minor'] as const) {
      const profile = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
      // Rotate the profile so its tonic lines up with this candidate root.
      const rotated = new Float64Array(12);
      for (let i = 0; i < 12; i += 1) rotated[i] = profile[(i - tonic + 12) % 12]!;
      candidates.push({
        tonic,
        mode,
        score: correlate(chroma, rotated),
        name: keyName(tonic, mode),
      });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}

export function detectKey(buffer: AudioBuffer): KeyResult {
  const chroma = chromagram(buffer);
  const ranked = rankKeys(chroma);
  const best = ranked[0]!;
  const runnerUp = ranked[1]!;

  /**
   * Confidence from the margin between the top two.
   *
   * A correlation of 0.9 means little on its own if the second-placed key also
   * scores 0.89 — that is a piece sitting between two readings, not a confident
   * answer. The gap is what carries the information, and 0.15 is treated as a
   * decisive margin because relative major and minor rarely separate by more.
   */
  const margin = Math.max(0, best.score - runnerUp.score);
  const confidence = Math.max(0, Math.min(1, margin / 0.15));

  return { best, runnerUp, confidence, chroma };
}
