/**
 * Measurement: loudness (ITU-R BS.1770-4), true peak, and tempo.
 *
 * The LUFS implementation is the real thing — K-weighting, 400 ms blocks at 75%
 * overlap, and both gating stages — because "normalize to -14 LUFS" is only
 * useful if the number matches what Spotify, YouTube and Auphonic measure.
 */
import { createBuffer, gainFactor, applyGain } from './dsp';
import { runAll, runSliced, type SliceOptions, type Steps } from './slices';

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * K-weighting stage 1: a high shelf approximating the acoustic effect of a
 * head in a diffuse field. Coefficients are derived per sample rate rather
 * than hard-coded at 48 kHz, so 44.1 kHz material measures correctly.
 */
function shelvingFilter(sampleRate: number): Biquad {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;

  const K = Math.tan((Math.PI * f0) / sampleRate);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  const denom = 1 + K / Q + K * K;

  return {
    b0: (Vh + (Vb * K) / Q + K * K) / denom,
    b1: (2 * (K * K - Vh)) / denom,
    b2: (Vh - (Vb * K) / Q + K * K) / denom,
    a1: (2 * (K * K - 1)) / denom,
    a2: (1 - K / Q + K * K) / denom,
  };
}

/** K-weighting stage 2: high-pass, removing rumble that doesn't affect loudness. */
function highpassFilter(sampleRate: number): Biquad {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;
  const K = Math.tan((Math.PI * f0) / sampleRate);
  const denom = 1 + K / Q + K * K;

  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / denom,
    a2: (1 - K / Q + K * K) / denom,
  };
}

/** A biquad's last two inputs and outputs, carried from one stretch to the next. */
interface BiquadState {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

const biquadState = (): BiquadState => ({ x1: 0, x2: 0, y1: 0, y2: 0 });

/**
 * Filters input[from, to) into output from `at` onwards. The state goes on
 * where the last stretch stopped, so a signal filtered in pieces comes out
 * exactly as it does filtered whole.
 */
function runBiquad(
  input: Float32Array,
  from: number,
  to: number,
  output: Float32Array,
  at: number,
  f: Biquad,
  state: BiquadState
): void {
  let { x1, x2, y1, y2 } = state;

  for (let i = from, o = at; i < to; i += 1, o += 1) {
    const x0 = input[i];
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    output[o] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }

  state.x1 = x1;
  state.x2 = x2;
  state.y1 = y1;
  state.y2 = y2;
}

/** BS.1770 channel weights. Surround channels count for more; LFE is excluded. */
function channelWeight(index: number, total: number): number {
  if (total <= 2) return 1;
  // 5.1 ordering: L R C LFE Ls Rs
  if (index === 3) return 0;
  if (index >= 4) return 1.41;
  return 1;
}

export interface LoudnessResult {
  /** Integrated loudness, LUFS. -Infinity for silence. */
  integrated: number;
  /** Loudness range, LU — how much the level varies across the programme. */
  range: number;
  /** True peak in dBTP, measured with 4x oversampling. */
  truePeak: number;
  /** Sample peak in dBFS. */
  peak: number;
  /**
   * Momentary loudness across the file, LUFS per 400 ms block at a 100 ms hop.
   *
   * These are the same gating blocks the integrated figure is computed from, so
   * a graph of them is a picture of the measurement rather than a second,
   * differently-derived approximation of it. Empty when the file is shorter than
   * one block or entirely silent. Blocks below the absolute gate come back as
   * -Infinity, which a caller should skip rather than plot.
   */
  momentary: number[];
  /** Seconds between consecutive momentary values. */
  momentaryStep: number;
}

/**
 * Samples between the points where a sliced measurement may pause. The
 * heaviest loop here, the true-peak oversampler, gets through this many in a
 * few milliseconds.
 */
const CHUNK = 1 << 15;

/**
 * Relative cost of each stage per sample and channel, from timing them on a
 * 10-minute song in Chromium (weighting 360 ms, blocks 210, range 150, true
 * peak 2790, sample peak 90). Only the progress figure uses these, so that it
 * moves at an even pace.
 */
const COST = { weighting: 3.4, blocks: 2, range: 1.4, truePeak: 26, peak: 0.8 };

/** Work done so far, as a share of the whole. */
class Progress {
  private done = 0;

  constructor(private readonly total: number) {}

  /** Counts `units` more as done and returns the share done, 0..1. */
  add(units: number): number {
    this.done += units;
    return this.total > 0 ? Math.min(1, this.done / this.total) : 1;
  }
}

/**
 * Measures integrated loudness, loudness range and true peak in one pass.
 */
export function measureLoudness(buffer: AudioBuffer): LoudnessResult {
  return runAll(loudnessSteps(buffer));
}

/**
 * measureLoudness a slice at a time, so the page keeps painting and taking
 * input while a long file is measured. The result is identical.
 */
export function measureLoudnessSliced(
  buffer: AudioBuffer,
  options?: SliceOptions
): Promise<LoudnessResult> {
  return runSliced(loudnessSteps(buffer), options);
}

/** Weighted mean square of one block, summed across channels. */
function blockPowerAt(
  weighted: Float32Array[],
  channels: number,
  start: number,
  blockSamples: number
): number {
  let total = 0;
  for (let c = 0; c < channels; c += 1) {
    const w = channelWeight(c, channels);
    if (w === 0) continue;
    const data = weighted[c];
    let sum = 0;
    for (let i = start; i < start + blockSamples; i += 1) sum += data[i] * data[i];
    total += w * (sum / blockSamples);
  }
  return total;
}

/**
 * The loudness measurement as steps that may pause every `chunk` samples.
 *
 * `chunk` only decides where the pauses fall. Every stage keeps its running
 * state across a pause (the filters their last samples, the sums their
 * position), so any chunk gives the same numbers as one unbroken pass.
 */
export function* loudnessSteps(
  buffer: AudioBuffer,
  chunk = CHUNK
): Steps<LoudnessResult> {
  const rate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const whole = channels * length;
  const progress = new Progress(
    whole * (COST.weighting + COST.blocks + COST.range + COST.truePeak + COST.peak)
  );

  const shelf = shelvingFilter(rate);
  const hp = highpassFilter(rate);

  // K-weighting, the shelf and then the high-pass, a stretch at a time. The
  // shelf's output is only kept for the stretch the high-pass is reading.
  const weighted: Float32Array[] = [];
  const shelved = new Float32Array(Math.min(chunk, length));
  for (let c = 0; c < channels; c += 1) {
    const input = buffer.getChannelData(c);
    const out = new Float32Array(length);
    const shelfState = biquadState();
    const hpState = biquadState();
    for (let from = 0; from < length; from += chunk) {
      const to = Math.min(length, from + chunk);
      runBiquad(input, from, to, shelved, 0, shelf, shelfState);
      runBiquad(shelved, 0, to - from, out, from, hp, hpState);
      yield progress.add(COST.weighting * (to - from));
    }
    weighted.push(out);
  }

  const blockSamples = Math.round(rate * 0.4);
  const stepSamples = Math.round(rate * 0.1);

  if (length < blockSamples) {
    // Too short for a single gating block; fall back to plain mean square so
    // the number is still indicative rather than -Infinity.
    let sum = 0;
    let count = 0;
    for (let c = 0; c < channels; c += 1) {
      const w = channelWeight(c, channels);
      const data = weighted[c];
      for (let i = 0; i < data.length; i += 1) sum += w * data[i] * data[i];
      count += data.length;
    }
    const ms = count === 0 ? 0 : sum / (count / channels);
    progress.add(whole * (COST.blocks + COST.range));
    return {
      integrated: ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity,
      range: 0,
      truePeak: yield* truePeakSteps(buffer, chunk, progress),
      peak: yield* peakSteps(buffer, chunk, progress),
      momentary: [],
      momentaryStep: 0.1,
    };
  }

  // Weighted mean square per block, summed across channels.
  const blockPower: number[] = [];
  let sincePause = 0;
  for (let start = 0; start + blockSamples <= length; start += stepSamples) {
    blockPower.push(blockPowerAt(weighted, channels, start, blockSamples));
    sincePause += stepSamples;
    if (sincePause >= chunk) {
      yield progress.add(COST.blocks * channels * sincePause);
      sincePause = 0;
    }
  }

  const loudnessOf = (power: number): number =>
    power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity;

  // Stage 1: absolute gate at -70 LUFS drops true silence.
  const aboveAbsolute = blockPower.filter((p) => loudnessOf(p) > -70);
  if (aboveAbsolute.length === 0) {
    progress.add(whole * COST.range);
    return {
      integrated: -Infinity,
      range: 0,
      truePeak: yield* truePeakSteps(buffer, chunk, progress),
      peak: yield* peakSteps(buffer, chunk, progress),
      momentary: [],
      momentaryStep: 0.1,
    };
  }

  const mean = (values: number[]): number =>
    values.reduce((a, b) => a + b, 0) / values.length;

  // Stage 2: relative gate 10 LU below the ungated mean, which is what stops
  // long quiet passages dragging the measurement down.
  const relativeThreshold = loudnessOf(mean(aboveAbsolute)) - 10;
  const gated = aboveAbsolute.filter((p) => loudnessOf(p) > relativeThreshold);
  const integrated = loudnessOf(mean(gated.length > 0 ? gated : aboveAbsolute));

  const range = yield* loudnessRangeSteps(weighted, channels, rate, length, chunk, progress);
  // The weighted copy is as big as the file, and true peak reads the original.
  weighted.length = 0;

  return {
    integrated,
    momentary: blockPower.map(loudnessOf),
    momentaryStep: stepSamples / rate,
    range,
    truePeak: yield* truePeakSteps(buffer, chunk, progress),
    peak: yield* peakSteps(buffer, chunk, progress),
  };
}

/** EBU R128 loudness range: the 10th-to-95th percentile spread of 3s blocks. */
function* loudnessRangeSteps(
  weighted: Float32Array[],
  channels: number,
  rate: number,
  length: number,
  chunk: number,
  progress: Progress
): Steps<number> {
  const blockSamples = Math.round(rate * 3);
  const stepSamples = Math.round(rate * 1);
  if (length < blockSamples) {
    progress.add(COST.range * channels * length);
    return 0;
  }

  const levels: number[] = [];
  let sincePause = 0;
  for (let start = 0; start + blockSamples <= length; start += stepSamples) {
    const total = blockPowerAt(weighted, channels, start, blockSamples);
    if (total > 0) levels.push(-0.691 + 10 * Math.log10(total));
    sincePause += stepSamples;
    if (sincePause >= chunk) {
      yield progress.add(COST.range * channels * sincePause);
      sincePause = 0;
    }
  }

  const above = levels.filter((l) => l > -70);
  if (above.length < 2) return 0;

  const meanPower =
    above.reduce((a, l) => a + 10 ** (l / 10), 0) / above.length;
  const threshold = 10 * Math.log10(meanPower) - 20;
  const kept = above.filter((l) => l > threshold).sort((a, b) => a - b);
  if (kept.length < 2) return 0;

  const at = (p: number): number =>
    kept[Math.min(kept.length - 1, Math.max(0, Math.round(p * (kept.length - 1))))];

  return at(0.95) - at(0.1);
}

/** The largest absolute sample in data[from, to), or `peak` if none is larger. */
function samplePeak(data: Float32Array, from: number, to: number, peak: number): number {
  for (let i = from; i < to; i += 1) {
    const v = Math.abs(data[i]);
    if (v > peak) peak = v;
  }
  return peak;
}

export function peakDb(buffer: AudioBuffer): number {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    peak = samplePeak(data, 0, data.length, peak);
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

function* peakSteps(buffer: AudioBuffer, chunk: number, progress: Progress): Steps<number> {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let from = 0; from < data.length; from += chunk) {
      const to = Math.min(data.length, from + chunk);
      peak = samplePeak(data, from, to, peak);
      yield progress.add(COST.peak * (to - from));
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/** Taps each side of the point being reconstructed. */
const TRUE_PEAK_REACH = 8;

/**
 * The three in-between phases of a 4x oversampler: a Hann-windowed sinc,
 * centred at 1/4, 2/4 and 3/4 of a sample, taps from -REACH+1 to +REACH.
 */
const TRUE_PEAK_PHASES: Float64Array[] = [1, 2, 3].map((step) => {
  const taps = new Float64Array(2 * TRUE_PEAK_REACH);
  for (let k = -TRUE_PEAK_REACH + 1; k <= TRUE_PEAK_REACH; k += 1) {
    const d = step / 4 - k;
    const window = 0.5 + 0.5 * Math.cos((Math.PI * d) / TRUE_PEAK_REACH);
    taps[k + TRUE_PEAK_REACH - 1] = (Math.sin(Math.PI * d) / (Math.PI * d)) * window;
  }
  return taps;
});

/**
 * True peak: the signal between samples can exceed the highest sample, which
 * is why a file that looks safe at 0 dBFS can still clip a converter.
 *
 * 4x oversampling as BS.1770 describes, with a real reconstruction filter.
 * This was a Catmull-Rom cubic through the neighbours, which is not one: it
 * smooths away inter-sample peaks above about an eighth of the sample rate.
 * The EBU Tech 3341 12 kHz tones (-6.02 dBTP) read -7.09 and -6.75, outside
 * the +0.2/-0.4 dB the test allows, and a real master at +0.65 dBTP read
 * +0.13. That is the difference between the meter warning about a -1 dBTP
 * ceiling and staying quiet, and the normalizer's ceiling being kept.
 */
export function truePeakDb(buffer: AudioBuffer): number {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    peak = truePeakOf(data, 0, data.length, peak);
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/**
 * The largest absolute value in data[from, to), samples and the three points
 * reconstructed after each, or `peak` if none is larger. The filter reads up to
 * TRUE_PEAK_REACH samples either side of the range, so ranges can be done in
 * any order and pieces.
 */
function truePeakOf(data: Float32Array, from: number, to: number, peak: number): number {
  const reach = TRUE_PEAK_REACH;
  const n = data.length;

  for (let i = from; i < to; i += 1) {
    const sample = Math.abs(data[i]);
    if (sample > peak) peak = sample;
    if (i + 1 >= n) break;

    // Only the edges need the bounds check; the middle of the file is the
    // tight loop.
    const inside = i - reach + 1 >= 0 && i + reach < n;
    for (const taps of TRUE_PEAK_PHASES) {
      let v = 0;
      if (inside) {
        for (let k = 0; k < taps.length; k += 1) v += data[i - reach + 1 + k] * taps[k];
      } else {
        for (let k = 0; k < taps.length; k += 1) {
          const j = i - reach + 1 + k;
          if (j >= 0 && j < n) v += data[j] * taps[k];
        }
      }
      const abs = Math.abs(v);
      if (abs > peak) peak = abs;
    }
  }

  return peak;
}

function* truePeakSteps(buffer: AudioBuffer, chunk: number, progress: Progress): Steps<number> {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let from = 0; from < data.length; from += chunk) {
      const to = Math.min(data.length, from + chunk);
      peak = truePeakOf(data, from, to, peak);
      yield progress.add(COST.truePeak * (to - from));
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/**
 * Scales to hit a target integrated loudness. Optionally holds true peak below
 * a ceiling, which is what broadcast and streaming delivery specs require.
 */
export function normalizeLoudness(
  buffer: AudioBuffer,
  targetLufs = -14,
  peakCeilingDb = -1
): { buffer: AudioBuffer; applied: number; measured: LoudnessResult } {
  const measured = measureLoudness(buffer);
  if (!Number.isFinite(measured.integrated)) {
    return { buffer, applied: 0, measured };
  }

  let gain = targetLufs - measured.integrated;

  // Turning up to hit the target must not push peaks past the ceiling.
  const headroom = peakCeilingDb - measured.truePeak;
  if (Number.isFinite(headroom) && gain > headroom) gain = headroom;

  return { buffer: applyGain(buffer, gain), applied: gain, measured };
}

export interface TempoResult {
  bpm: number;
  /** 0..1 — how clearly the autocorrelation peaked. */
  confidence: number;
  /**
   * Seconds between beats at the reported BPM, and seconds from the start of the
   * file to the first one.
   *
   * Autocorrelation finds the beat *period* on its own; the phase has to be
   * recovered separately, by asking which alignment of a pulse train at that
   * period collects the most onset energy. Both are needed to draw a grid over
   * the waveform, which is the only way to tell "120 BPM" from "120 BPM, and
   * here is where the beats are" — the second can be checked by eye, the first
   * has to be believed. Zero when nothing was detected.
   */
  beatPeriod: number;
  beatOffset: number;
}

/**
 * Tempo by onset autocorrelation.
 *
 * An energy envelope is built from short frames, differentiated to emphasise
 * attacks, then correlated against itself. The lag with the strongest
 * correlation inside a musical range is the beat period.
 */
export function detectTempo(buffer: AudioBuffer, minBpm = 60, maxBpm = 200): TempoResult {
  const rate = buffer.sampleRate;
  const frame = Math.max(1, Math.round(rate * 0.01)); // 10 ms
  const frames = Math.floor(buffer.length / frame);
  if (frames < 64) return { bpm: 0, confidence: 0, beatPeriod: 0, beatOffset: 0 };

  const channels = buffer.numberOfChannels;
  const energy = new Float32Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    const start = f * frame;
    for (let c = 0; c < channels; c += 1) {
      const data = buffer.getChannelData(c);
      for (let i = start; i < start + frame; i += 1) sum += data[i] * data[i];
    }
    energy[f] = Math.sqrt(sum / (frame * channels));
  }

  // Half-wave rectified difference: rises count as onsets, decays don't.
  const onset = new Float32Array(frames);
  let mean = 0;
  for (let f = 1; f < frames; f += 1) {
    const d = energy[f] - energy[f - 1];
    onset[f] = d > 0 ? d : 0;
    mean += onset[f];
  }
  mean /= frames;
  for (let f = 0; f < frames; f += 1) onset[f] = Math.max(0, onset[f] - mean);

  // How percussive the material is at all. A sustained tone has essentially no
  // onset energy, and autocorrelating that noise floor still produces a
  // confident-looking peak — so strength has to gate the confidence, or the
  // tool reports "120 BPM, high confidence" for a file with no beat in it.
  let energyMean = 0;
  for (let f = 0; f < frames; f += 1) energyMean += energy[f];
  energyMean /= frames;

  let onsetMean = 0;
  for (let f = 0; f < frames; f += 1) onsetMean += onset[f];
  onsetMean /= frames;

  const flux = energyMean > 1e-8 ? onsetMean / energyMean : 0;

  const framesPerSecond = rate / frame;
  const minLag = Math.floor((60 / maxBpm) * framesPerSecond);
  const maxLag = Math.ceil((60 / minBpm) * framesPerSecond);
  if (maxLag >= frames) return { bpm: 0, confidence: 0, beatPeriod: 0, beatOffset: 0 };

  /**
   * A [1 2 1] blur before correlating.
   *
   * A click's onset is a single frame wide, so a beat period that falls between
   * two whole frames (90 BPM is 66.7) splits its correlation across both lags,
   * while some multiple of it that happens to land on a whole frame (3 beats =
   * 200) keeps all of it. Without the blur, that rounding alone is enough to
   * pick the wrong lag.
   */
  const smooth = new Float32Array(frames);
  for (let f = 0; f < frames; f += 1) {
    const left = onset[f - 1] ?? onset[f];
    const right = onset[f + 1] ?? onset[f];
    smooth[f] = (left + 2 * onset[f] + right) / 4;
  }

  const harmonics = [1, 2, 4];
  const longest = Math.min(frames - 1, maxLag * 4 + 2);
  const acf = new Float64Array(longest + 1);
  for (let lag = minLag; lag <= longest; lag += 1) {
    let sum = 0;
    for (let f = 0; f + lag < frames; f += 1) sum += smooth[f] * smooth[f + lag];
    acf[lag] = sum / (frames - lag);
  }

  /** The strongest lag within `slack` frames of `centre`, as [lag, value]. */
  const peakNear = (centre: number, slack: number): [number, number] => {
    let lag = 0;
    let value = 0;
    const last = Math.min(longest, Math.round(centre + slack));
    for (let l = Math.max(1, Math.round(centre - slack)); l <= last; l += 1) {
      if (acf[l] > value) {
        value = acf[l];
        lag = l;
      }
    }
    return [lag, value];
  };

  /**
   * Each candidate beat is scored by its own lag plus the half-bar and bar lags
   * it implies (Percival & Tzanetakis' harmonic enhancement).
   *
   * Picking the single strongest lag fails on syncopated music. Anything on a
   * sixteenth-note grid correlates at every multiple of the sixteenth, and a
   * 3+3+2 figure, the commonest syncopation in pop, puts the most coincidences
   * at three sixteenths: a 92 BPM acoustic song read as 120. The real beat is
   * the lag whose doubles also line up: the 3-sixteenth lag doubles to a beat
   * and a half and quadruples to three beats, neither of which repeats. Each
   * multiple k is allowed k/2 frames of slack for the rounding of the lag, and
   * a period that is not a whole number of frames gets one frame more.
   */
  const scoreAt = (period: number): number => {
    const extra = Number.isInteger(period) ? 0 : 1;
    let score = 0;
    for (const k of harmonics) score += peakNear(period * k, (k >> 1) + extra)[1];
    return score;
  };

  let bestLag = 0;
  let bestScore = 0;
  let total = 0;
  let count = 0;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const score = scoreAt(lag);
    total += score;
    count += 1;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (bestLag === 0 || bestScore <= 0) return { bpm: 0, confidence: 0, beatPeriod: 0, beatOffset: 0 };

  const average = total / count;
  // How much the winning lag stands out from every other candidate.
  const contrast = Math.min(1, Math.max(0, 1 - average / bestScore));
  // Percussive enough to have a tempo at all. 0.06 sits comfortably between
  // sustained material (~0.01) and anything with real transients (~0.2+).
  const strength = Math.min(1, flux / 0.06);
  const confidence = contrast * strength;

  /**
   * The period to a fraction of a frame, from where each harmonic actually
   * peaks.
   *
   * A whole-frame lag is up to half a frame out, which is 0.75% at 90 BPM. That
   * reads 90.9 for a 91.0 song, and over a three-minute track the grid drifts
   * two beats off the music. The bar lag pins the period four times as finely
   * as the beat lag, so each peak, refined by a parabola through it and its
   * neighbours, votes in proportion to its strength and its multiple.
   */
  const vertex = (lag: number): number => {
    if (lag < 2 || lag >= longest) return lag;
    const a = acf[lag - 1];
    const b = acf[lag];
    const c = acf[lag + 1];
    const curve = a - 2 * b + c;
    return curve < 0 ? lag + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / curve)) : lag;
  };
  let weighted = 0;
  let weight = 0;
  for (const k of harmonics) {
    const [lag, value] = peakNear(bestLag * k, k >> 1);
    if (lag === 0) continue;
    weighted += value * vertex(lag);
    weight += value * k;
  }
  const beatLag = weight > 0 ? weighted / weight : bestLag;

  let bpm = (60 * framesPerSecond) / beatLag;

  /**
   * Autocorrelation happily locks onto a multiple of the beat; fold into the
   * range most music actually sits in.
   *
   * A slow reading is two beats taken as one, or three: 180 BPM reads as 60,
   * and doubling that gives 120, a tempo that is not in the music at all. So
   * a reading below 70 is tripled when a third of its period correlates better
   * than half of it.
   */
  const triple = bpm < 70 && bpm * 3 <= maxBpm && scoreAt(beatLag / 3) > scoreAt(beatLag / 2);
  if (triple) {
    bpm *= 3;
  } else {
    while (bpm < 70) bpm *= 2;
    while (bpm > 180) bpm /= 2;
  }

  /**
   * Phase: which alignment of a pulse train at the beat period lands on the
   * most onset energy.
   *
   * Tried against the folded BPM rather than bestLag, so the grid matches the
   * number on screen. Halving the tempo doubles the spacing, and a grid drawn
   * at the un-folded period would be twice as dense as the reading it claims to
   * illustrate.
   *
   * Read from a [1 2 3 2 1] blur of the onsets. An onset is one frame wide and
   * the pulse train lands on whole frames, so on the raw onsets a period change
   * of a third of a millisecond decides which beats hit their onset and which
   * miss it by one frame. On a 3+3+2 song, where the off-beat collects as much
   * kick as the beat does, that was enough to put the grid on the "and".
   */
  const blurred = new Float32Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    let taps = 0;
    for (let d = -2; d <= 2; d += 1) {
      const value = onset[f + d];
      if (value === undefined) continue;
      sum += value * (3 - Math.abs(d));
      taps += 3 - Math.abs(d);
    }
    blurred[f] = sum / taps;
  }

  const period = (60 / bpm) * framesPerSecond;
  let bestOffset = 0;
  let bestPhase = -1;
  for (let offset = 0; offset < Math.ceil(period); offset += 1) {
    let sum = 0;
    for (let at = offset; at < frames; at += period) {
      sum += blurred[Math.round(at)] ?? 0;
    }
    if (sum > bestPhase) {
      bestPhase = sum;
      bestOffset = offset;
    }
  }

  return {
    bpm: Math.round(bpm * 10) / 10,
    confidence,
    beatPeriod: 60 / bpm,
    beatOffset: bestOffset / framesPerSecond,
  };
}

export interface WaveformData {
  columns: number;
  /** Interleaved min, max per column — the outer hull of the signal. */
  peaks: Float32Array;
  /** RMS per column — the perceived body of the signal. */
  rms: Float32Array;
}

/**
 * Reduces a buffer to per-column peak and RMS in a single pass.
 *
 * Both are needed to draw a waveform that reads accurately. Peak alone is what
 * makes cheap waveforms look like solid blocks: a single stray sample stretches
 * the whole column to full height, so a quiet passage with one click in it
 * looks as loud as a chorus. RMS traces the energy the ear actually follows.
 * Drawing the hull and the body together is what every serious editor does.
 */
export function computeWaveform(
  buffer: AudioBuffer,
  columns: number,
  fromSample = 0,
  toSample = buffer.length
): WaveformData {
  const scan = new WaveformScan(buffer, columns, fromSample, toSample);
  scan.step();
  return scan.data;
}

/**
 * How long one slice of a WaveformScan may hold the main thread when it is
 * drawn a frame at a time. Short enough that the frame, paint included, stays
 * well under the 50 ms the browser counts as a long animation frame.
 */
export const SCAN_SLICE_MS = 12;

/**
 * computeWaveform a slice of columns at a time.
 *
 * One pass over a 54-minute stereo file is about 290 million sample reads, and
 * done in one go it held the main thread for about 400 ms in the frame that
 * first drew the file. Columns do not depend on each other, so the pass can stop
 * after any column and carry on later: the caller draws the columns that are
 * done, lets the browser take input and paint, and asks for more. Every column
 * is computed by the same code as before, so the finished data is identical,
 * value for value, to a single computeWaveform call.
 */
export class WaveformScan {
  readonly data: WaveformData;
  readonly buffer: AudioBuffer;
  /** The samples read, [first, last). */
  readonly first: number;
  readonly last: number;
  /** Samples per column. Below 1 when there are more columns than samples. */
  readonly perColumn: number;
  private readonly channels: Float32Array[];
  private next = 0;

  constructor(buffer: AudioBuffer, columns: number, fromSample = 0, toSample = buffer.length) {
    const width = Math.max(1, Math.floor(columns));
    this.data = {
      columns: width,
      peaks: new Float32Array(width * 2),
      rms: new Float32Array(width),
    };

    this.buffer = buffer;
    this.first = Math.max(0, Math.min(buffer.length - 1, Math.floor(fromSample)));
    this.last = Math.max(this.first + 1, Math.min(buffer.length, Math.ceil(toSample)));
    this.perColumn = (this.last - this.first) / width;

    // Hoist channel references: getChannelData is a getter, and calling it
    // inside the sample loop dominates the profile on long files.
    this.channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c += 1) {
      this.channels.push(buffer.getChannelData(c));
    }
  }

  /** Columns finished so far, counted from the left. */
  get filled(): number {
    return this.next;
  }

  get done(): boolean {
    return this.next >= this.data.columns;
  }

  /**
   * Whether `other` reads the same samples into the same columns. The data
   * depends on nothing else, so a scan that matches can stand in for this one
   * whole: the overview reuses the full view this way.
   */
  sameColumns(other: WaveformScan): boolean {
    return (
      other.buffer === this.buffer &&
      other.data.columns === this.data.columns &&
      other.first === this.first &&
      other.last === this.last
    );
  }

  /** First sample of column `x`, as step() reads it. */
  columnStart(x: number): number {
    return this.first + Math.floor(x * this.perColumn);
  }

  /** One past the last sample of column `x`, as step() reads it. */
  columnEnd(x: number): number {
    return x === this.data.columns - 1
      ? this.last
      : Math.min(this.last, this.first + Math.floor((x + 1) * this.perColumn));
  }

  /** The column that reads sample `i`, clamped to the scan. */
  columnAt(i: number): number {
    const lastColumn = this.data.columns - 1;
    let x = Math.min(lastColumn, Math.max(0, Math.floor((i - this.first) / this.perColumn)));
    // The floors in columnStart can put a boundary one column either side.
    while (x < lastColumn && this.columnStart(x + 1) <= i) x += 1;
    while (x > 0 && this.columnStart(x) > i) x -= 1;
    return x;
  }

  /**
   * Scans columns until `budgetMs` has passed, or to the end without a budget.
   * The clock is read once per column, which on a file long enough to need a
   * budget is a few hundred thousand samples apart. Returns whether the scan is
   * complete.
   */
  step(budgetMs = Infinity): boolean {
    const { peaks, rms, columns: width } = this.data;
    const { channels: data, first, last, perColumn } = this;
    const channels = data.length;
    const timed = Number.isFinite(budgetMs);
    const deadline = timed ? performance.now() + budgetMs : 0;

    for (let x = this.next; x < width; x += 1) {
      const start = first + Math.floor(x * perColumn);
      // The last column absorbs any rounding remainder so no sample is skipped.
      const end =
        x === width - 1 ? last : Math.min(last, first + Math.floor((x + 1) * perColumn));

      let min = 0;
      let max = 0;
      let sumSquares = 0;
      let count = 0;

      // Zoomed in far enough that a column covers less than one sample, every
      // column still has to report something: read the sample it lands on
      // rather than leaving a gap where an empty range would.
      if (end <= start) {
        const i = Math.min(last - 1, start);
        for (let c = 0; c < channels; c += 1) {
          const v = data[c][i];
          if (v < min) min = v;
          if (v > max) max = v;
          sumSquares += v * v;
        }
        peaks[x * 2] = min;
        peaks[x * 2 + 1] = max;
        rms[x] = Math.sqrt(sumSquares / channels);
      } else {
        for (let c = 0; c < channels; c += 1) {
          const channel = data[c];
          for (let i = start; i < end; i += 1) {
            const v = channel[i];
            if (v < min) min = v;
            if (v > max) max = v;
            sumSquares += v * v;
          }
          count += end - start;
        }

        peaks[x * 2] = min;
        peaks[x * 2 + 1] = max;
        rms[x] = count > 0 ? Math.sqrt(sumSquares / count) : 0;
      }

      this.next = x + 1;
      if (timed && performance.now() >= deadline) break;
    }

    return this.done;
  }
}

/** Columns [start, end) that have data to draw. */
export type WaveformRun = [number, number];

/**
 * Fills `out` with what to draw for a scan that has not finished: its own
 * columns as far as it has got, and past that the same stretch of time read off
 * the finest of `sources` (other scans of the same buffer, at any width or
 * range) that has read all of it. This is what a DAW does while it redraws: the
 * old picture moved to where it now belongs, coarser where the source is, and
 * never blank where something has been measured.
 *
 * A borrowed column takes the extremes of every source column that overlaps it,
 * so its hull is never smaller than the true one, only wider at the edges.
 * Returns the runs of columns that have data; the rest nothing has read yet.
 */
export function standInWaveform(
  target: WaveformScan,
  sources: WaveformScan[],
  out: WaveformData
): WaveformRun[] {
  const { columns, peaks: ownPeaks, rms: ownRms } = target.data;
  const { peaks, rms } = out;
  const filled = target.filled;
  peaks.set(ownPeaks.subarray(0, filled * 2));
  rms.set(ownRms.subarray(0, filled));
  const runs: WaveformRun[] = filled > 0 ? [[0, filled]] : [];

  const usable = sources.filter(
    (source) => source !== target && source.buffer === target.buffer && source.filled > 0
  );
  if (usable.length === 0) return runs;

  for (let x = filled; x < columns; x += 1) {
    const start = target.columnStart(x);
    // A column narrower than a sample reads the one it lands on, as step() does.
    const end = Math.max(start + 1, target.columnEnd(x));

    let best: WaveformScan | null = null;
    for (const source of usable) {
      if (start < source.first || end > source.last) continue;
      if (source.columnAt(end - 1) >= source.filled) continue;
      if (!best || source.perColumn < best.perColumn) best = source;
    }
    if (!best) continue;

    const { peaks: hull, rms: body } = best.data;
    const first = best.columnAt(start);
    const last = best.columnAt(end - 1);
    let min = 0;
    let max = 0;
    let squares = 0;
    for (let c = first; c <= last; c += 1) {
      if (hull[c * 2] < min) min = hull[c * 2];
      if (hull[c * 2 + 1] > max) max = hull[c * 2 + 1];
      squares += body[c] * body[c];
    }
    peaks[x * 2] = min;
    peaks[x * 2 + 1] = max;
    rms[x] = Math.sqrt(squares / (last - first + 1));

    const run = runs[runs.length - 1];
    if (run && run[1] === x) run[1] = x + 1;
    else runs.push([x, x + 1]);
  }

  return runs;
}

/**
 * Downsamples to min/max pairs per pixel column for waveform drawing.
 * Drawing from these instead of raw samples is what keeps a one-hour file
 * rendering in a frame.
 */
export function computePeaks(buffer: AudioBuffer, columns: number): Float32Array {
  const width = Math.max(1, Math.floor(columns));
  const out = new Float32Array(width * 2);
  const channels = buffer.numberOfChannels;
  const samplesPerColumn = buffer.length / width;

  for (let x = 0; x < width; x += 1) {
    const start = Math.floor(x * samplesPerColumn);
    const end = Math.min(buffer.length, Math.floor((x + 1) * samplesPerColumn));
    let min = 0;
    let max = 0;

    for (let c = 0; c < channels; c += 1) {
      const data = buffer.getChannelData(c);
      for (let i = start; i < end; i += 1) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }

    out[x * 2] = min;
    out[x * 2 + 1] = max;
  }

  return out;
}

/** Silence with the same shape — used for previews and tests. */
export function silentBuffer(
  seconds: number,
  sampleRate = 44100,
  channels = 2
): AudioBuffer {
  return createBuffer(channels, Math.max(1, Math.round(seconds * sampleRate)), sampleRate);
}

/** Sine tone generator, used by the sample-file affordance and the test suite. */
export function toneBuffer(
  seconds: number,
  frequency = 440,
  sampleRate = 44100,
  channels = 2,
  amplitudeDb = -6
): AudioBuffer {
  const length = Math.max(1, Math.round(seconds * sampleRate));
  const buffer = createBuffer(channels, length, sampleRate);
  const amp = gainFactor(amplitudeDb);
  for (let c = 0; c < channels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.sin((2 * Math.PI * frequency * i) / sampleRate) * amp;
    }
  }
  return buffer;
}
