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
 * The first version voted on pauses, level spread and channel count. Those
 * describe how a recording was made more than what is in it: a podcast read
 * without a breath has no pauses, a song with a quiet verse has plenty, and
 * both fooled it. (A fourth, brightness, had already gone for scoring every
 * file alike.) What is left here was chosen by measuring, not by belief:
 * 107 files (voiceovers, memos, phone audio, text-to-speech in six languages,
 * songs, stems, lofi, drums, synthesised solo lines) cut into 820 clips of
 * 4 s to full length, every candidate feature measured on each, then checked
 * on 75 files it was not tuned on. The ones kept are those whose speech and
 * music ranges barely overlap, and each is a property of a voice talking,
 * not of a microphone:
 *
 *   - pitch. A speaking voice slides through pitch; music sits on the notes
 *     of a scale and holds them. This is the strongest single cue.
 *   - syllables. Speech gets louder and quieter four or five times a second,
 *     once per syllable, even when it never pauses.
 *   - one voice. Speech is one clearly pitched source most of the time; a
 *     band is many at once, and has no single pitch to find.
 *   - consonants. Speech keeps switching between vowels and hiss, which shows
 *     as a jumpy zero-crossing rate. Sustained instruments are smooth.
 *   - gaps, beat, bass and stereo width, which are weaker but catch what the
 *     others miss: the gaps between words, a steady beat, a bass line, a mix
 *     spread across two speakers.
 *
 * Each feature gives a soft vote between -1 and +1, ramped between two
 * thresholds rather than switched at one, so a value near a boundary counts
 * for little and one far past it counts in full. Speech has to win clearly;
 * anything short of that is called music, because a too-big file is better
 * than a ruined song.
 */

export type ContentKind = 'speech' | 'music';

export interface Classification {
  kind: ContentKind;
  /** False when the vote was close. The UI says so rather than bluffing. */
  confident: boolean;
  /** Plain-language evidence, for the line under the verdict. */
  reasons: string[];
}

/** The numbers behind a verdict. Exported for the tests, and for re-tuning. */
export interface Measures {
  /** Size of the loudness swing at syllable rate (2.5–7 Hz), in dB. */
  syllables: number;
  /** Share of 20 ms blocks below half their second's average level. */
  gaps: number;
  /** Spread of the zero-crossing rate relative to its mean. */
  consonants: number;
  /** Share of sounding frames with one clear pitch. */
  voiced: number;
  /** How many frames that is, since the two pitch features need enough. */
  voicedFrames: number;
  /** 0 when pitches land anywhere, 1 when they all sit on one semitone grid. */
  onNotes: number;
  /** Share of pitched frames still within 15 cents 60 ms later. */
  held: number;
  /** Strongest repetition of note onsets 0.3–1.5 s apart, 0 to 1. */
  beat: number;
  /** Share of energy below 120 Hz. */
  bass: number;
  /** Left/right correlation, 1 for mono. */
  correlation: number;
}

/** Probes at 20/50/80% rather than the whole file, which is 30× the work. */
const PROBES = [0.2, 0.5, 0.8];
const PROBE_SECONDS = 8;
/** Below this there is not enough of anything to measure. */
const MIN_SECONDS = 2;

type Range = { start: number; end: number };

function probeRanges(buffer: AudioBuffer): Range[] {
  const length = buffer.length;
  const window = Math.min(Math.floor(buffer.sampleRate * PROBE_SECONDS), length);
  const ranges: Range[] = [];
  for (const at of PROBES) {
    const centre = Math.floor(length * at);
    const start = Math.max(0, Math.min(length - window, centre - Math.floor(window / 2)));
    // A file shorter than one probe yields the same range three times.
    if (!ranges.some((r) => r.start === start)) ranges.push({ start, end: start + window });
  }
  return ranges;
}

/** How alike the two channels are. Near-identical means nothing stereo is happening. */
function correlation(buffer: AudioBuffer, ranges: Range[]): number {
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

/** RBJ biquad, Butterworth Q, run in place. */
function biquad(data: Float32Array, rate: number, hz: number, type: 'low' | 'high'): void {
  const w = (2 * Math.PI * hz) / rate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / Math.SQRT2;
  const a0 = 1 + alpha;
  const b0 = (type === 'low' ? (1 - cos) / 2 : (1 + cos) / 2) / a0;
  const b1 = (type === 'low' ? 1 - cos : -(1 + cos)) / a0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < data.length; i += 1) {
    const x = data[i]!;
    const y = b0 * x + b1 * x1 + b0 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    data[i] = y;
  }
}

/** Frames are 10 ms; the pitch track runs at half that rate to halve its cost. */
const FRAME_SECONDS = 0.01;
const PITCH_STEP = 2;

/**
 * One probe's measures.
 *
 * Everything but the zero-crossing count runs on a copy decimated to about
 * 8 kHz by plain averaging. That is a crude anti-alias filter, and it does
 * not matter here: nothing below needs more than the fundamental and the
 * first few formants. It makes the pitch search 25 times cheaper, since both
 * the window and the range of lags shrink fivefold.
 */
function measureRange(buffer: AudioBuffer, range: Range): Partial<Measures> {
  const left = buffer.getChannelData(0);
  // Anything past two channels is rare enough to leave out of the mix.
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const factor = Math.max(1, Math.floor(buffer.sampleRate / 8000));
  const rate = buffer.sampleRate / factor;
  const hop = Math.max(1, Math.round(rate * FRAME_SECONDS));
  const count = Math.floor((range.end - range.start) / factor);
  const frames = Math.floor(count / hop);
  if (frames < 100) return {};

  // Mix down, decimate, and count zero crossings per frame at the full rate,
  // where the hiss of consonants actually is.
  const mono = new Float32Array(count);
  const crossings = new Float32Array(frames);
  let previous = 0;
  for (let i = 0; i < count; i += 1) {
    const frame = Math.min(frames - 1, Math.floor(i / hop));
    const from = range.start + i * factor;
    let sum = 0;
    let crossed = 0;
    for (let at = from; at < from + factor; at += 1) {
      const v = left[at]! + right[at]!;
      if ((v >= 0) !== (previous >= 0)) crossed += 1;
      previous = v;
      sum += v;
    }
    crossings[frame] = crossings[frame]! + crossed;
    mono[i] = sum / (2 * factor);
  }

  const full = mono.slice();
  biquad(full, rate, 20, 'high');
  const band = full.slice();
  biquad(band, rate, 60, 'high');
  const low = full.slice();
  biquad(low, rate, 120, 'low');
  biquad(low, rate, 120, 'low');
  // Three more bands above the bass, for onsets only. Drums announce
  // themselves in one band while the chords sustain in another, and a single
  // broadband level lets the sustain fill in the hits.
  const bands = [low, full.slice(), full.slice(), full.slice()];
  biquad(bands[1]!, rate, 120, 'high');
  biquad(bands[1]!, rate, 600, 'low');
  biquad(bands[2]!, rate, 600, 'high');
  biquad(bands[2]!, rate, 2000, 'low');
  biquad(bands[3]!, rate, 2000, 'high');

  const energy = new Float64Array(frames);
  const bandEnergy = bands.map(() => new Float64Array(frames));
  const [b0, b1, b2, b3] = bands as [Float32Array, Float32Array, Float32Array, Float32Array];
  const [e0, e1, e2, e3] = bandEnergy as [Float64Array, Float64Array, Float64Array, Float64Array];
  let loudest = 0;
  let bassSum = 0;
  let totalSum = 0;
  for (let f = 0; f < frames; f += 1) {
    let e = 0;
    let t = 0;
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    let s3 = 0;
    for (let i = f * hop; i < (f + 1) * hop; i += 1) {
      e += band[i]! * band[i]!;
      t += full[i]! * full[i]!;
      s0 += b0[i]! * b0[i]!;
      s1 += b1[i]! * b1[i]!;
      s2 += b2[i]! * b2[i]!;
      s3 += b3[i]! * b3[i]!;
    }
    energy[f] = e;
    e0[f] = s0;
    e1[f] = s1;
    e2[f] = s2;
    e3[f] = s3;
    if (e > loudest) loudest = e;
    bassSum += s0;
    totalSum += t;
  }
  if (loudest === 0) return {};

  const result: Partial<Measures> = {
    bass: totalSum > 0 ? bassSum / totalSum : 0,
  };

  // Loudness in dB, floored 60 dB down so silence is a level, not -Infinity.
  const level = new Float64Array(frames);
  const floor = loudest * 1e-6;
  for (let f = 0; f < frames; f += 1) level[f] = 10 * Math.log10(energy[f]! + floor);

  result.syllables = syllableSwing(level);
  result.gaps = gapShare(energy);
  result.beat = beatStrength(bandEnergy, floor);

  // Zero-crossing spread over frames that are actually sounding.
  {
    let n = 0;
    let sum = 0;
    let squares = 0;
    for (let f = 0; f < frames; f += 1) {
      if (energy[f]! < loudest * 1e-5) continue;
      const z = crossings[f]!;
      n += 1;
      sum += z;
      squares += z * z;
    }
    const mean = n > 0 ? sum / n : 0;
    result.consonants = mean > 0 ? Math.sqrt(Math.max(0, squares / n - mean * mean)) / mean : 0;
  }

  Object.assign(result, pitchMeasures(mono, rate, hop, energy));
  return result;
}

/**
 * The syllable-rate part of the loudness curve, as an amplitude in dB.
 *
 * Over 2.56 s windows: take out the mean, then measure what is left between
 * 2.5 and 7 Hz with a direct DFT of just those bins. Talking swings 5–12 dB
 * there and most music 1–3 dB, unless a drum pattern happens to land in the
 * same range, which the beat vote is there to catch.
 */
function syllableSwing(level: Float64Array): number {
  const n = level.length >= 256 ? 256 : 128;
  if (level.length < n) return NaN;
  const frameRate = 1 / FRAME_SECONDS;
  const first = Math.ceil((2.5 * n) / frameRate);
  const last = Math.floor((7 * n) / frameRate);
  const windowed = new Float64Array(n);
  const swings: number[] = [];

  for (let start = 0; start + n <= level.length; start += n / 2) {
    let mean = 0;
    for (let i = 0; i < n; i += 1) mean += level[start + i]!;
    mean /= n;
    for (let i = 0; i < n; i += 1) {
      windowed[i] = (level[start + i]! - mean) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
    }
    let power = 0;
    for (let k = first; k <= last; k += 1) {
      let re = 0;
      let im = 0;
      for (let i = 0; i < n; i += 1) {
        const angle = (2 * Math.PI * k * i) / n;
        re += windowed[i]! * Math.cos(angle);
        im -= windowed[i]! * Math.sin(angle);
      }
      power += re * re + im * im;
    }
    // Undo the window (mean square 0.375) and the one-sided spectrum.
    swings.push(Math.sqrt((2 * power) / (n * n * 0.375)));
  }

  return swings.reduce((a, b) => a + b, 0) / swings.length;
}

/**
 * Share of 20 ms blocks below half the average of their second.
 *
 * Judged a second at a time so a quiet verse does not count as one long gap,
 * which is the mistake the old pause vote made on songs.
 */
function gapShare(energy: Float64Array): number {
  const blocks: number[] = [];
  for (let f = 0; f + 1 < energy.length; f += 2) blocks.push(Math.sqrt((energy[f]! + energy[f + 1]!) / 2));
  const span = Math.min(50, blocks.length);
  const shares: number[] = [];
  for (let start = 0; start + span <= blocks.length; start += span) {
    let mean = 0;
    for (let i = start; i < start + span; i += 1) mean += blocks[i]!;
    mean /= span;
    if (mean <= 0) continue;
    let below = 0;
    for (let i = start; i < start + span; i += 1) if (blocks[i]! < 0.5 * mean) below += 1;
    shares.push(below / span);
  }
  return shares.length > 0 ? shares.reduce((a, b) => a + b, 0) / shares.length : NaN;
}

/** Peak normalised autocorrelation of loudness rises, 0.3–1.5 s apart. */
function beatStrength(bands: Float64Array[], floor: number): number {
  const n = bands[0]!.length;
  const onset = new Float64Array(n);
  let mean = 0;
  for (const energy of bands) {
    let previous = 10 * Math.log10(energy[0]! + floor);
    for (let f = 1; f < n; f += 1) {
      const level = 10 * Math.log10(energy[f]! + floor);
      onset[f] = onset[f]! + Math.max(0, level - previous);
      previous = level;
    }
  }
  for (let f = 0; f < n; f += 1) mean += onset[f]!;
  mean /= n;
  let zero = 0;
  for (let f = 0; f < n; f += 1) {
    onset[f] = onset[f]! - mean;
    zero += onset[f]! * onset[f]!;
  }
  if (zero === 0) return 0;

  let best = 0;
  const shortest = Math.round(0.3 / FRAME_SECONDS);
  const longest = Math.min(Math.round(1.5 / FRAME_SECONDS), Math.floor(n / 2));
  for (let lag = shortest; lag <= longest; lag += 1) {
    let sum = 0;
    for (let f = 0; f + lag < n; f += 1) sum += onset[f]! * onset[f + lag]!;
    // Scaled up for the overlap lost to the lag, so long lags are not penalised.
    const r = sum / (zero * ((n - lag) / n));
    if (r > best) best = r;
  }
  return Math.min(1, best);
}

/**
 * YIN pitch on every other frame, then three numbers from the track.
 *
 * Only frames within 20 dB of the loud ones are tried, which skips the
 * pauses for free and keeps reverb tails from counting as held notes.
 */
function pitchMeasures(
  mono: Float32Array,
  rate: number,
  hop: number,
  energy: Float64Array
): Partial<Measures> {
  const sorted = Array.from(energy).sort((a, b) => a - b);
  const gate = sorted[Math.floor(sorted.length * 0.9)]! * 0.01;
  const shortest = Math.floor(rate / 600);
  const longest = Math.ceil(rate / 70);
  const width = Math.round(rate * 0.02);
  const diff = new Float64Array(longest + 2);

  const steps = Math.floor(energy.length / PITCH_STEP);
  const cents = new Float64Array(steps).fill(NaN);
  let sounding = 0;
  let voiced = 0;

  for (let s = 0; s < steps; s += 1) {
    const f = s * PITCH_STEP;
    if (energy[f]! <= gate) continue;
    const start = f * hop;
    if (start + width + longest + 1 > mono.length) break;
    sounding += 1;

    let e0 = 0;
    for (let j = 0; j < width; j += 1) e0 += mono[start + j]! * mono[start + j]!;
    let eTau = e0;
    let running = 0;
    let best = -1;
    for (let tau = 1; tau <= longest + 1; tau += 1) {
      const entering = mono[start + tau + width - 1]!;
      const leaving = mono[start + tau - 1]!;
      eTau += entering * entering - leaving * leaving;
      let r = 0;
      for (let j = 0; j < width; j += 1) r += mono[start + j]! * mono[start + j + tau]!;
      const d = e0 + eTau - 2 * r;
      running += d;
      diff[tau] = running > 0 ? (d * tau) / running : 1;
      // The first dip under 0.15, followed to the bottom of its valley.
      if (tau > shortest + 1 && diff[tau - 1]! < 0.15 && diff[tau]! >= diff[tau - 1]!) {
        best = tau - 1;
        break;
      }
    }
    if (best < 0) {
      // No clear dip: the deepest one still counts if it is nearly as deep.
      let deepest = Infinity;
      for (let tau = shortest; tau <= longest; tau += 1) {
        if (diff[tau]! < deepest) {
          deepest = diff[tau]!;
          best = tau;
        }
      }
    }
    if (diff[best]! >= 0.2) continue;

    const a = diff[best - 1]!;
    const b = diff[best]!;
    const c = diff[best + 1]!;
    const curve = a - 2 * b + c;
    const shift = curve > 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / curve)) : 0;
    cents[s] = 1200 * Math.log2(rate / (best + shift) / 440);
    voiced += 1;
  }

  // On-grid: each pitch's offset from the nearest semitone as an angle. In
  // tune they all point one way, whatever the tuning; sliding speech spreads
  // them round the circle and the average comes out near zero.
  let re = 0;
  let im = 0;
  let pairs = 0;
  let steady = 0;
  const lag = Math.round(0.06 / (FRAME_SECONDS * PITCH_STEP));
  for (let s = 0; s < steps; s += 1) {
    const value = cents[s]!;
    if (Number.isNaN(value)) continue;
    const angle = (2 * Math.PI * (((value % 100) + 100) % 100)) / 100;
    re += Math.cos(angle);
    im += Math.sin(angle);
    const later = cents[s + lag];
    if (later !== undefined && !Number.isNaN(later)) {
      pairs += 1;
      if (Math.abs(later - value) < 15) steady += 1;
    }
  }

  return {
    voiced: sounding > 0 ? voiced / sounding : 0,
    voicedFrames: voiced,
    onNotes: voiced > 0 ? Math.hypot(re, im) / voiced : 0,
    held: pairs > 0 ? steady / pairs : NaN,
  };
}

function median(values: number[]): number {
  const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (finite.length === 0) return NaN;
  const mid = finite.length >> 1;
  return finite.length % 2 ? finite[mid]! : (finite[mid - 1]! + finite[mid]!) / 2;
}

/** Measures for the whole file: each probe's, then the middle value of each. */
export function measure(buffer: AudioBuffer): Measures | null {
  if (buffer.duration < MIN_SECONDS) return null;
  const ranges = probeRanges(buffer);
  const parts = ranges.map((range) => measureRange(buffer, range)).filter((p) => p.syllables !== undefined);
  if (parts.length === 0) return null;
  const pick = (key: keyof Measures) => median(parts.map((p) => p[key] ?? NaN));
  return {
    syllables: pick('syllables'),
    gaps: pick('gaps'),
    consonants: pick('consonants'),
    voiced: pick('voiced'),
    voicedFrames: pick('voicedFrames'),
    onNotes: pick('onNotes'),
    held: pick('held'),
    beat: pick('beat'),
    bass: pick('bass'),
    correlation: correlation(buffer, ranges),
  };
}

/** -1 at `from`, +1 at `to`, straight between, 0 when unmeasured. */
function ramp(value: number, from: number, to: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, ((value - from) / (to - from)) * 2 - 1));
}

/**
 * 0 at `from`, 1 at `to`, for the votes that only ever point one way. A beat
 * is good evidence of music, but no beat is no evidence of speech.
 */
function rise(value: number, from: number, to: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, (value - from) / (to - from)));
}

/** Enough pitched frames, 0.8 s or so, for the pitch votes to mean anything. */
const PITCH_FRAMES = 40;

interface Vote {
  weight: number;
  /** -1 (music) to +1 (speech). */
  evidence: (m: Measures) => number;
  speech?: string;
  music?: string;
}

/**
 * The votes, weighted roughly by how well each separated the measured set.
 * Thresholds sit where the two ranges meet, with each ramp reaching full
 * strength only where the other kind stops turning up.
 */
const VOTES: Vote[] = [
  {
    weight: 2.5,
    evidence: (m) => (m.voicedFrames >= PITCH_FRAMES ? -ramp(m.onNotes, 0.12, 0.35) : 0),
    speech: 'the pitch slides like a speaking voice',
    music: 'the pitch sits on musical notes',
  },
  {
    weight: 1.5,
    evidence: (m) => ramp(m.syllables, 2.5, 5),
    speech: 'the level rises and falls with each syllable',
  },
  {
    weight: 1.5,
    evidence: (m) => ramp(m.voiced, 0.15, 0.45),
    speech: 'one voice at a time',
    music: 'many sounds at once',
  },
  {
    weight: 2,
    evidence: (m) => (m.voicedFrames >= PITCH_FRAMES ? -rise(m.held, 0.25, 0.45) : 0),
    music: 'held notes',
  },
  {
    weight: 1,
    evidence: (m) => ramp(m.consonants, 0.5, 1.1),
    speech: 'consonants between the vowels',
    music: 'smooth sustained sound',
  },
  {
    weight: 1,
    evidence: (m) => ramp(m.gaps, 0.08, 0.22),
    speech: 'short gaps between words',
    music: 'no gaps in the sound',
  },
  {
    weight: 1,
    evidence: (m) => -rise(m.beat, 0.3, 0.6),
    music: 'a steady beat',
  },
  {
    weight: 1,
    evidence: (m) => -rise(m.bass, 0.2, 0.45),
    music: 'a bass line',
  },
  {
    weight: 1,
    evidence: (m) => -rise(0.97 - m.correlation, 0, 0.12),
    music: 'real stereo width',
  },
];

/**
 * Where the total has to land. Starting from -2 means speech needs most of
 * its votes to agree before it wins; music needs far less, because calling
 * a song speech is the mistake that costs. Either way it needs at least one
 * vote that was sure, or there is nothing to tell the user.
 */
const START = -2;
const SPEECH_AT = 2.5;
const MUSIC_AT = -1.5;

export function classify(buffer: AudioBuffer): Classification {
  const measures = measure(buffer);
  if (!measures) {
    const why = buffer.duration < MIN_SECONDS ? 'too short to tell' : 'too quiet to tell';
    return { kind: 'music', confident: false, reasons: [why] };
  }

  const scored = VOTES.map((vote) => ({ vote, value: vote.weight * vote.evidence(measures) }));
  const total = scored.reduce((sum, s) => sum + s.value, START);

  const kind: ContentKind = total >= SPEECH_AT ? 'speech' : 'music';
  const sign = kind === 'speech' ? 1 : -1;
  const reasons = scored
    // Only votes that agree, and only those that were sure of it.
    .filter((s) => s.value * sign >= 0.5 * s.vote.weight)
    .sort((a, b) => b.value * sign - a.value * sign)
    .map((s) => (kind === 'speech' ? s.vote.speech : s.vote.music))
    .filter((reason): reason is string => reason !== undefined)
    .slice(0, 3);

  if ((total < SPEECH_AT && total > MUSIC_AT) || reasons.length === 0) {
    // A close call assumes music, and says so. Being wrong that way costs a
    // bigger file; being wrong the other way costs a ruined one.
    return { kind: 'music', confident: false, reasons: ['not certain'] };
  }

  return { kind, confident: true, reasons };
}
