/**
 * Measurement: loudness (ITU-R BS.1770-4), true peak, and tempo.
 *
 * The LUFS implementation is the real thing — K-weighting, 400 ms blocks at 75%
 * overlap, and both gating stages — because "normalize to -14 LUFS" is only
 * useful if the number matches what Spotify, YouTube and Auphonic measure.
 */
import { createBuffer, gainFactor, applyGain } from './dsp';

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

function runBiquad(input: Float32Array, f: Biquad): Float32Array {
  const out = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;

  for (let i = 0; i < input.length; i += 1) {
    const x0 = input[i];
    const y0 = f.b0 * x0 + f.b1 * x1 + f.b2 * x2 - f.a1 * y1 - f.a2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
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
}

/**
 * Measures integrated loudness, loudness range and true peak in one pass.
 */
export function measureLoudness(buffer: AudioBuffer): LoudnessResult {
  const rate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;

  const shelf = shelvingFilter(rate);
  const hp = highpassFilter(rate);

  const weighted: Float32Array[] = [];
  for (let c = 0; c < channels; c += 1) {
    weighted.push(runBiquad(runBiquad(buffer.getChannelData(c), shelf), hp));
  }

  const blockSamples = Math.round(rate * 0.4);
  const stepSamples = Math.round(rate * 0.1);

  if (buffer.length < blockSamples) {
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
    return {
      integrated: ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity,
      range: 0,
      truePeak: truePeakDb(buffer),
      peak: peakDb(buffer),
    };
  }

  // Weighted mean square per block, summed across channels.
  const blockPower: number[] = [];
  for (let start = 0; start + blockSamples <= buffer.length; start += stepSamples) {
    let total = 0;
    for (let c = 0; c < channels; c += 1) {
      const w = channelWeight(c, channels);
      if (w === 0) continue;
      const data = weighted[c];
      let sum = 0;
      for (let i = start; i < start + blockSamples; i += 1) sum += data[i] * data[i];
      total += w * (sum / blockSamples);
    }
    blockPower.push(total);
  }

  const loudnessOf = (power: number): number =>
    power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity;

  // Stage 1: absolute gate at -70 LUFS drops true silence.
  const aboveAbsolute = blockPower.filter((p) => loudnessOf(p) > -70);
  if (aboveAbsolute.length === 0) {
    return {
      integrated: -Infinity,
      range: 0,
      truePeak: truePeakDb(buffer),
      peak: peakDb(buffer),
    };
  }

  const mean = (values: number[]): number =>
    values.reduce((a, b) => a + b, 0) / values.length;

  // Stage 2: relative gate 10 LU below the ungated mean, which is what stops
  // long quiet passages dragging the measurement down.
  const relativeThreshold = loudnessOf(mean(aboveAbsolute)) - 10;
  const gated = aboveAbsolute.filter((p) => loudnessOf(p) > relativeThreshold);
  const integrated = loudnessOf(mean(gated.length > 0 ? gated : aboveAbsolute));

  return {
    integrated,
    range: loudnessRange(weighted, channels, rate, buffer.length),
    truePeak: truePeakDb(buffer),
    peak: peakDb(buffer),
  };
}

/** EBU R128 loudness range: the 10th-to-95th percentile spread of 3s blocks. */
function loudnessRange(
  weighted: Float32Array[],
  channels: number,
  rate: number,
  length: number
): number {
  const blockSamples = Math.round(rate * 3);
  const stepSamples = Math.round(rate * 1);
  if (length < blockSamples) return 0;

  const levels: number[] = [];
  for (let start = 0; start + blockSamples <= length; start += stepSamples) {
    let total = 0;
    for (let c = 0; c < channels; c += 1) {
      const w = channelWeight(c, channels);
      if (w === 0) continue;
      const data = weighted[c];
      let sum = 0;
      for (let i = start; i < start + blockSamples; i += 1) sum += data[i] * data[i];
      total += w * (sum / blockSamples);
    }
    if (total > 0) levels.push(-0.691 + 10 * Math.log10(total));
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

export function peakDb(buffer: AudioBuffer): number {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i += 1) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/**
 * True peak: the signal between samples can exceed the highest sample, which
 * is why a file that looks safe at 0 dBFS can still clip a converter. 4x
 * oversampling catches most of it.
 */
export function truePeakDb(buffer: AudioBuffer): number {
  let peak = 0;
  const factor = 4;

  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    const n = data.length;
    for (let i = 0; i < n - 1; i += 1) {
      const a = data[i];
      const b = data[i + 1];
      // Cubic-ish interpolation between neighbours approximates the
      // reconstructed analogue waveform well enough for a warning.
      const prev = i > 0 ? data[i - 1] : a;
      const next = i < n - 2 ? data[i + 2] : b;
      for (let s = 0; s < factor; s += 1) {
        const t = s / factor;
        const t2 = t * t;
        const t3 = t2 * t;
        const v =
          0.5 *
          (2 * a +
            (-prev + b) * t +
            (2 * prev - 5 * a + 4 * b - next) * t2 +
            (-prev + 3 * a - 3 * b + next) * t3);
        const abs = Math.abs(v);
        if (abs > peak) peak = abs;
      }
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
  if (frames < 64) return { bpm: 0, confidence: 0 };

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
  if (maxLag >= frames) return { bpm: 0, confidence: 0 };

  let bestLag = 0;
  let bestScore = 0;
  let total = 0;
  let count = 0;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let sum = 0;
    for (let f = 0; f + lag < frames; f += 1) sum += onset[f] * onset[f + lag];
    const score = sum / (frames - lag);
    total += score;
    count += 1;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (bestLag === 0 || bestScore <= 0) return { bpm: 0, confidence: 0 };

  const average = total / count;
  // How much the winning lag stands out from every other candidate.
  const contrast = Math.min(1, Math.max(0, 1 - average / bestScore));
  // Percussive enough to have a tempo at all. 0.06 sits comfortably between
  // sustained material (~0.01) and anything with real transients (~0.2+).
  const strength = Math.min(1, flux / 0.06);
  const confidence = contrast * strength;

  let bpm = (60 * framesPerSecond) / bestLag;

  // Autocorrelation happily locks onto half or double time; fold into the
  // range most music actually sits in.
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;

  return { bpm: Math.round(bpm * 10) / 10, confidence };
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
  columns: number
): WaveformData {
  const width = Math.max(1, Math.floor(columns));
  const peaks = new Float32Array(width * 2);
  const rms = new Float32Array(width);
  const channels = buffer.numberOfChannels;
  const length = buffer.length;

  // Hoist channel references: getChannelData is a getter, and calling it
  // inside the sample loop dominates the profile on long files.
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c += 1) data.push(buffer.getChannelData(c));

  const perColumn = length / width;

  for (let x = 0; x < width; x += 1) {
    const start = Math.floor(x * perColumn);
    // The last column absorbs any rounding remainder so no sample is skipped.
    const end = x === width - 1 ? length : Math.min(length, Math.floor((x + 1) * perColumn));

    let min = 0;
    let max = 0;
    let sumSquares = 0;
    let count = 0;

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

  return { columns: width, peaks, rms };
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
