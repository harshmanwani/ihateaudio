/**
 * Speech or music.
 *
 * The destination tools need this because the two survive compression so
 * differently that one setting cannot serve both: a lecture is fine at 32 kbps
 * mono, and a song at 32 kbps is a ruin. Guessing wrong in the quiet direction
 * produces a file the user can hear is broken, so this reports its evidence
 * and its confidence rather than just its answer — a guess you can see the
 * reasoning for is one you can correct in a second.
 *
 * Four cheap features, one vote each. No FFT: a first-difference filter is a
 * perfectly good brightness measure, and it cannot be wrong about a convention.
 */
import { findSilence } from './dsp';

export type ContentKind = 'speech' | 'music';

export interface Classification {
  kind: ContentKind;
  /** False when the vote was close. The UI says so rather than bluffing. */
  confident: boolean;
  /** Plain-language evidence, for the line under the verdict. */
  reasons: string[];
}

/** Probes at 20/50/80% rather than the whole file, which is 30× the work. */
const PROBES = [0.2, 0.5, 0.8];
const PROBE_SECONDS = 8;

function probeRanges(buffer: AudioBuffer): { start: number; end: number }[] {
  const length = buffer.length;
  const window = Math.min(Math.floor(buffer.sampleRate * PROBE_SECONDS), length);
  if (window <= 0) return [];
  return PROBES.map((at) => {
    const centre = Math.floor(length * at);
    const start = Math.max(0, Math.min(length - window, centre - Math.floor(window / 2)));
    return { start, end: start + window };
  });
}

/**
 * Ratio of high-frequency energy to total.
 *
 * A first difference is a 6 dB/octave high-pass, so this rises with brightness.
 * Speech puts almost everything below 4 kHz and lands near 0.3–0.6; music with
 * cymbals, strings or synths carries far higher and lands near 0.8 and up.
 */
function brightness(buffer: AudioBuffer, ranges: { start: number; end: number }[]): number {
  const data = buffer.getChannelData(0);
  let signal = 0;
  let edges = 0;
  let count = 0;

  for (const range of ranges) {
    for (let i = range.start + 1; i < range.end; i += 1) {
      const sample = data[i]!;
      const delta = sample - data[i - 1]!;
      signal += sample * sample;
      edges += delta * delta;
      count += 1;
    }
  }

  if (count === 0 || signal === 0) return 0;
  return Math.sqrt(edges / count) / Math.sqrt(signal / count);
}

/** How alike the two channels are. Near-identical means nothing stereo is happening. */
function correlation(buffer: AudioBuffer, ranges: { start: number; end: number }[]): number {
  if (buffer.numberOfChannels < 2) return 1;
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  let lr = 0;
  let ll = 0;
  let rr = 0;

  for (const range of ranges) {
    for (let i = range.start; i < range.end; i += 1) {
      const l = left[i]!;
      const r = right[i]!;
      lr += l * r;
      ll += l * l;
      rr += r * r;
    }
  }

  if (ll === 0 || rr === 0) return 1;
  return lr / Math.sqrt(ll * rr);
}

/**
 * Spread of short-term loudness, in dB.
 *
 * Speech swings between syllables and pauses; mastered music is squashed flat
 * on purpose. Measured over 400 ms blocks, which is long enough to ignore
 * individual waveform cycles and short enough to catch a gap between words.
 */
function dynamics(buffer: AudioBuffer, ranges: { start: number; end: number }[]): number {
  const data = buffer.getChannelData(0);
  const block = Math.max(1, Math.floor(buffer.sampleRate * 0.4));
  const levels: number[] = [];

  for (const range of ranges) {
    for (let pos = range.start; pos + block <= range.end; pos += block) {
      let sum = 0;
      for (let i = pos; i < pos + block; i += 1) sum += data[i]! * data[i]!;
      const rms = Math.sqrt(sum / block);
      // Floor rather than drop silent blocks: a pause is evidence, not a gap
      // in the data.
      levels.push(20 * Math.log10(Math.max(rms, 1e-5)));
    }
  }

  if (levels.length < 2) return 0;
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
  const variance = levels.reduce((a, b) => a + (b - mean) ** 2, 0) / levels.length;
  return Math.sqrt(variance);
}

export function classify(buffer: AudioBuffer): Classification {
  const ranges = probeRanges(buffer);
  if (ranges.length === 0) {
    return { kind: 'music', confident: false, reasons: ['too short to tell'] };
  }

  const speechReasons: string[] = [];
  const musicReasons: string[] = [];
  let votes = 0;

  // 1. Channels.
  if (buffer.numberOfChannels < 2) {
    votes += 1;
    speechReasons.push('mono');
  } else {
    const rho = correlation(buffer, ranges);
    if (rho > 0.98) {
      votes += 1;
      speechReasons.push('both channels near-identical');
    } else if (rho < 0.9) {
      votes -= 1;
      musicReasons.push('real stereo width');
    }
  }

  // 2. Brightness.
  const bright = brightness(buffer, ranges);
  if (bright < 0.55) {
    votes += 1;
    speechReasons.push('little energy up high');
  } else if (bright > 0.8) {
    votes -= 1;
    musicReasons.push('bright, lots of treble');
  }

  // 3. Pauses. Reuses the splitter's silence finder rather than a second
  //    definition of quiet.
  const silences = findSilence(buffer, -45, 0.25);
  const quiet = silences.reduce((total, r) => total + (r.end - r.start), 0);
  const fraction = buffer.duration > 0 ? quiet / buffer.duration : 0;
  if (fraction > 0.1) {
    votes += 1;
    speechReasons.push('pauses throughout');
  } else if (fraction < 0.02) {
    votes -= 1;
    musicReasons.push('almost no silence');
  }

  // 4. Dynamics.
  const spread = dynamics(buffer, ranges);
  if (spread > 8) {
    votes += 1;
    speechReasons.push('uneven levels');
  } else if (spread < 5) {
    votes -= 1;
    musicReasons.push('consistently loud');
  }

  const kind: ContentKind = votes > 0 ? 'speech' : 'music';
  const confident = Math.abs(votes) >= 2;
  const reasons = kind === 'speech' ? speechReasons : musicReasons;

  return {
    kind,
    confident,
    // A split vote assumes music, and says so. Being wrong that way costs a
    // bigger file; being wrong the other way costs a ruined one.
    reasons: confident && reasons.length > 0 ? reasons : ['not certain'],
  };
}
