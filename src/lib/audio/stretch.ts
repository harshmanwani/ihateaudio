/**
 * WSOLA time stretching — change tempo without changing pitch, and change
 * pitch without changing tempo.
 *
 * Naive resampling couples the two: speed a track up and everyone sounds like a
 * chipmunk. WSOLA (Waveform Similarity Overlap-Add) instead slides each
 * analysis window to the position where the waveform best continues what was
 * already written, then overlap-adds. The similarity search is what stops the
 * output developing the metallic warble a fixed-hop OLA produces.
 */
import { createBuffer, cloneBuffer, resampleLinear } from './dsp';

/** Hann window, cached per size — the same few sizes recur constantly. */
const windowCache = new Map<number, Float32Array>();

function hann(size: number): Float32Array {
  const cached = windowCache.get(size);
  if (cached) return cached;
  const w = new Float32Array(size);
  for (let i = 0; i < size; i += 1) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
  }
  windowCache.set(size, w);
  return w;
}

/** Mono sum used only to pick alignment offsets, so stereo stays coherent. */
function monoSum(buffer: AudioBuffer): Float32Array {
  const n = buffer.length;
  const out = new Float32Array(n);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i += 1) out[i] += data[i] / channels;
  }
  return out;
}

/**
 * Finds the offset within +/-radius of `centre` whose samples best match
 * `template`, by normalised cross-correlation.
 */
function bestOffset(
  signal: Float32Array,
  template: Float32Array,
  centre: number,
  radius: number,
  compare: number
): number {
  let bestDelta = 0;
  let bestScore = -Infinity;

  const lo = -radius;
  const hi = radius;

  for (let delta = lo; delta <= hi; delta += 1) {
    const start = centre + delta;
    if (start < 0 || start + compare >= signal.length) continue;

    let dot = 0;
    let energy = 0;
    // Stepping by 2 halves the search cost; at these window sizes the chosen
    // offset is identical in practice.
    for (let i = 0; i < compare; i += 2) {
      const s = signal[start + i];
      dot += s * template[i];
      energy += s * s;
    }
    const score = energy > 1e-9 ? dot / Math.sqrt(energy) : 0;
    if (score > bestScore) {
      bestScore = score;
      bestDelta = delta;
    }
  }

  return centre + bestDelta;
}

/**
 * Stretches to `factor` times the original length, holding pitch constant.
 * factor 2 = half speed, factor 0.5 = double speed.
 */
export function timeStretch(buffer: AudioBuffer, factor: number): AudioBuffer {
  const safe = Math.min(4, Math.max(0.25, factor));
  if (Math.abs(safe - 1) < 0.001) return cloneBuffer(buffer);

  const rate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;

  // ~46ms window at 44.1kHz: long enough to resolve pitch, short enough that
  // transients aren't smeared across a syllable.
  const frame = Math.max(256, Math.round(rate * 0.046));
  const synthesisHop = Math.floor(frame / 2);
  const analysisHop = Math.max(1, Math.round(synthesisHop / safe));
  const radius = Math.floor(synthesisHop / 2);
  const compare = Math.min(frame, synthesisHop);

  const outLength = Math.max(1, Math.ceil(buffer.length * safe) + frame);
  const out = createBuffer(channels, outLength, rate);
  const window = hann(frame);

  const guide = monoSum(buffer);
  const template = new Float32Array(compare);
  // Accumulated window energy per output sample; dividing it out afterwards is
  // what keeps the level flat when overlap density varies.
  const norm = new Float32Array(outLength);

  let analysisPos = 0;
  let writePos = 0;
  let k = 0;

  while (writePos + frame < outLength && analysisPos + frame < buffer.length) {
    if (k > 0) {
      analysisPos = bestOffset(guide, template, k * analysisHop, radius, compare);
      if (analysisPos + frame >= buffer.length) break;
      if (analysisPos < 0) analysisPos = 0;
    }

    for (let c = 0; c < channels; c += 1) {
      const src = buffer.getChannelData(c);
      const dst = out.getChannelData(c);
      for (let i = 0; i < frame; i += 1) {
        dst[writePos + i] += src[analysisPos + i] * window[i];
      }
    }
    for (let i = 0; i < frame; i += 1) norm[writePos + i] += window[i];

    // What naturally follows this frame becomes the next frame's target.
    const nextStart = analysisPos + synthesisHop;
    for (let i = 0; i < compare; i += 1) {
      const idx = nextStart + i;
      template[i] = idx < guide.length ? guide[idx] : 0;
    }

    writePos += synthesisHop;
    k += 1;
  }

  const written = Math.max(1, writePos + frame);
  const trimmed = createBuffer(channels, Math.min(written, outLength), rate);
  for (let c = 0; c < channels; c += 1) {
    const src = out.getChannelData(c);
    const dst = trimmed.getChannelData(c);
    for (let i = 0; i < dst.length; i += 1) {
      const w = norm[i];
      dst[i] = w > 0.001 ? src[i] / w : src[i];
    }
  }

  return trimmed;
}

/** Semitones to a frequency ratio. +12 doubles, -12 halves. */
export function semitoneRatio(semitones: number): number {
  return 2 ** (semitones / 12);
}

/**
 * Shifts pitch by `semitones` while holding duration.
 *
 * Stretch long by the ratio, then resample back down by the same ratio: the
 * two length changes cancel and only the pitch moves.
 */
export function pitchShift(buffer: AudioBuffer, semitones: number): AudioBuffer {
  const clamped = Math.min(24, Math.max(-24, semitones));
  if (Math.abs(clamped) < 0.01) return cloneBuffer(buffer);

  const ratio = semitoneRatio(clamped);
  const stretched = timeStretch(buffer, ratio);
  const shifted = resampleLinear(stretched, buffer.sampleRate / ratio);

  // Relabel at the original rate: the sample count now encodes the shift.
  const out = createBuffer(shifted.numberOfChannels, shifted.length, buffer.sampleRate);
  for (let c = 0; c < shifted.numberOfChannels; c += 1) {
    out.copyToChannel(shifted.getChannelData(c).slice(), c);
  }
  return out;
}

/**
 * Changes tempo while holding pitch. `multiplier` 1.5 = 50% faster.
 * The inverse of timeStretch's factor, phrased the way users think about speed.
 */
export function changeTempo(buffer: AudioBuffer, multiplier: number): AudioBuffer {
  const safe = Math.min(4, Math.max(0.25, multiplier));
  return timeStretch(buffer, 1 / safe);
}
