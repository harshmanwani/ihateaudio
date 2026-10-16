/**
 * Buffer-level operations. Pure: every function returns a new AudioBuffer and
 * never mutates its input, so tools can re-run with different settings against
 * the original without re-decoding.
 *
 * Everything here is Tier 0 — plain Web Audio and typed arrays, no downloads.
 */
import { resampleChannel, resampleChannelSteps } from './resample';
import { runAll, runSliced, type SliceOptions, type Steps } from './slices';

export type FadeCurve = 'linear' | 'exponential' | 'logarithmic' | 'scurve';

/**
 * AudioBuffer constructor is well supported, but Safari < 14.1 only exposes
 * createBuffer on a context.
 */
export function createBuffer(
  channels: number,
  length: number,
  sampleRate: number
): AudioBuffer {
  const safeLength = Math.max(1, Math.floor(length));
  if (typeof AudioBuffer === 'function') {
    try {
      return new AudioBuffer({
        numberOfChannels: channels,
        length: safeLength,
        sampleRate,
      });
    } catch {
      /* fall through to the context path */
    }
  }
  const ctx = new OfflineAudioContext(channels, safeLength, sampleRate);
  return ctx.createBuffer(channels, safeLength, sampleRate);
}

/** Deep copy, so callers can mutate freely. */
export function cloneBuffer(buffer: AudioBuffer): AudioBuffer {
  const out = createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    out.copyToChannel(buffer.getChannelData(c).slice(), c);
  }
  return out;
}

/**
 * Extracts [startSec, endSec). Bounds are clamped, and a start past the end
 * yields a single silent sample rather than throwing — callers get something
 * they can always render.
 */
export function slice(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number
): AudioBuffer {
  const rate = buffer.sampleRate;
  const total = buffer.length;
  const from = Math.max(0, Math.min(total, Math.round(startSec * rate)));
  const to = Math.max(from, Math.min(total, Math.round(endSec * rate)));
  const length = Math.max(1, to - from);

  const out = createBuffer(buffer.numberOfChannels, length, rate);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    out.copyToChannel(buffer.getChannelData(c).subarray(from, to), c);
  }
  return out;
}

/** How long the join in `cutOut` crossfades: enough to hide the step, not to hear. */
const CUT_CROSSFADE = 0.01;

/**
 * Removes [startSec, endSec) and joins the remainder.
 *
 * The join is crossfaded. Butting the two ends together left a step wherever
 * the waveform did not happen to cross the same value on both sides, which is
 * almost everywhere: half full scale on a 440 Hz tone, an audible click. The
 * crossfade takes 10 ms off the length.
 */
export function cutOut(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number
): AudioBuffer {
  const head = slice(buffer, 0, startSec);
  const tail = slice(buffer, endSec, buffer.duration);
  if (startSec <= 0) return tail;
  if (endSec >= buffer.duration) return head;
  return concat([head, tail], Math.min(CUT_CROSSFADE, head.duration, tail.duration));
}

export function gainFactor(decibels: number): number {
  return 10 ** (decibels / 20);
}

export function toDecibels(factor: number): number {
  return factor <= 0 ? -Infinity : 20 * Math.log10(factor);
}

/** Multiplies by a constant. `clip` hard-limits to [-1, 1] instead of wrapping. */
export function applyGain(
  buffer: AudioBuffer,
  decibels: number,
  clip = true
): AudioBuffer {
  const factor = gainFactor(decibels);
  const out = createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const src = buffer.getChannelData(c);
    gainRange(src, out.getChannelData(c), 0, src.length, factor, clip);
  }
  return out;
}

function gainRange(
  src: Float32Array,
  dst: Float32Array,
  from: number,
  to: number,
  factor: number,
  clip: boolean
): void {
  for (let i = from; i < to; i += 1) {
    const v = src[i] * factor;
    dst[i] = clip ? (v > 1 ? 1 : v < -1 ? -1 : v) : v;
  }
}

/** Samples between the points where a sliced gain may pause. */
const GAIN_CHUNK = 1 << 18;

/**
 * applyGain as steps that may pause every `chunk` samples. Each sample is
 * scaled on its own, so the output is the same wherever the pauses fall.
 */
export function* gainSteps(
  buffer: AudioBuffer,
  decibels: number,
  clip = true,
  chunk = GAIN_CHUNK
): Steps<AudioBuffer> {
  const factor = gainFactor(decibels);
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const out = createBuffer(channels, length, buffer.sampleRate);
  for (let c = 0; c < channels; c += 1) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let from = 0; from < length; from += chunk) {
      const to = Math.min(length, from + chunk);
      gainRange(src, dst, from, to, factor, clip);
      yield (c * length + to) / (channels * length);
    }
  }
  return out;
}

/**
 * applyGain a slice at a time. An hour of stereo is about half a second of
 * multiplying, which is long enough to drop frames when a preview re-renders.
 */
export function applyGainSliced(
  buffer: AudioBuffer,
  decibels: number,
  options?: SliceOptions & { clip?: boolean }
): Promise<AudioBuffer> {
  return runSliced(gainSteps(buffer, decibels, options?.clip ?? true), options);
}

/**
 * Gain multiplier at `t` (0..1) through a fade.
 *
 * Exported so the fade tool can draw the exact shape it will apply. Anything
 * else would be a second implementation of the same curve, free to drift from
 * this one without either being obviously wrong.
 */
export function curveValue(t: number, curve: FadeCurve): number {
  switch (curve) {
    case 'exponential':
      // Perceptually the "natural" fade: slow at first, then rapid.
      return t * t;
    case 'logarithmic':
      return Math.sqrt(t);
    case 'scurve':
      return t * t * (3 - 2 * t);
    default:
      return t;
  }
}

/** Fades in over the first `seconds` and out over the last `outSeconds`. */
export function applyFade(
  buffer: AudioBuffer,
  inSeconds: number,
  outSeconds: number,
  curve: FadeCurve = 'linear'
): AudioBuffer {
  const out = cloneBuffer(buffer);
  const rate = buffer.sampleRate;
  const total = buffer.length;
  const inLen = Math.min(total, Math.max(0, Math.round(inSeconds * rate)));
  const outLen = Math.min(total - inLen, Math.max(0, Math.round(outSeconds * rate)));

  for (let c = 0; c < out.numberOfChannels; c += 1) {
    const data = out.getChannelData(c);
    for (let i = 0; i < inLen; i += 1) {
      data[i] *= curveValue(i / inLen, curve);
    }
    for (let i = 0; i < outLen; i += 1) {
      const idx = total - outLen + i;
      data[idx] *= curveValue(1 - i / outLen, curve);
    }
  }
  return out;
}

export function reverse(buffer: AudioBuffer): AudioBuffer {
  const out = createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    const n = src.length;
    for (let i = 0; i < n; i += 1) dst[i] = src[n - 1 - i];
  }
  return out;
}

/**
 * Joins buffers end to end. Mismatched sample rates are resolved by resampling
 * everything to the highest rate present, and mismatched channel counts by
 * promoting to the widest — otherwise merging a mono voice note onto a stereo
 * track would silently drop a channel.
 */
export function concat(buffers: AudioBuffer[], crossfadeSec = 0): AudioBuffer {
  const usable = buffers.filter((b) => b.length > 0);
  if (usable.length === 0) return createBuffer(1, 1, 44100);
  if (usable.length === 1 && crossfadeSec <= 0) return cloneBuffer(usable[0]);

  const rate = Math.max(...usable.map((b) => b.sampleRate));
  const channels = Math.max(...usable.map((b) => b.numberOfChannels));
  const parts = usable.map((b) => matchFormat(b, channels, rate));

  const overlap = Math.max(0, Math.round(crossfadeSec * rate));
  const totalLength =
    parts.reduce((sum, b) => sum + b.length, 0) - overlap * (parts.length - 1);

  const out = createBuffer(channels, Math.max(1, totalLength), rate);

  let cursor = 0;
  parts.forEach((part, index) => {
    const fadeIn = index > 0 ? Math.min(overlap, part.length) : 0;
    for (let c = 0; c < channels; c += 1) {
      const src = part.getChannelData(c);
      const dst = out.getChannelData(c);
      for (let i = 0; i < src.length; i += 1) {
        const target = cursor + i;
        if (target >= dst.length) break;
        if (i < fadeIn) {
          // Equal-power crossfade keeps perceived loudness steady through the join.
          const t = fadeIn === 1 ? 1 : i / (fadeIn - 1);
          dst[target] = dst[target] * Math.cos((t * Math.PI) / 2) + src[i] * Math.sin((t * Math.PI) / 2);
        } else {
          dst[target] = src[i];
        }
      }
    }
    cursor += part.length - (index < parts.length - 1 ? overlap : 0);
  });

  return out;
}

/** Brings a buffer to a given channel count and sample rate. */
export function matchFormat(
  buffer: AudioBuffer,
  channels: number,
  sampleRate: number
): AudioBuffer {
  let out = buffer;
  if (out.sampleRate !== sampleRate) out = resample(out, sampleRate);
  if (out.numberOfChannels !== channels) out = setChannels(out, channels);
  return out;
}

/** Mono <-> stereo. Downmix averages; upmix duplicates. */
export function setChannels(buffer: AudioBuffer, channels: number): AudioBuffer {
  if (buffer.numberOfChannels === channels) return cloneBuffer(buffer);
  const out = createBuffer(channels, buffer.length, buffer.sampleRate);

  if (channels === 1) {
    const dst = out.getChannelData(0);
    const n = buffer.numberOfChannels;
    for (let c = 0; c < n; c += 1) {
      const src = buffer.getChannelData(c);
      for (let i = 0; i < src.length; i += 1) dst[i] += src[i] / n;
    }
    return out;
  }

  /**
   * Surround down to stereo by the Web Audio "speakers" rules for the layouts
   * they define. Copying the first two channels kept only front left and right,
   * and a film's 5.1 track lost its centre, which is where the dialogue is.
   */
  const n = buffer.numberOfChannels;
  if (channels === 2 && (n === 4 || n === 6)) {
    const [left, right] = [out.getChannelData(0), out.getChannelData(1)];
    const [l, r] = [buffer.getChannelData(0), buffer.getChannelData(1)];
    if (n === 4) {
      // L R SL SR
      const [sl, sr] = [buffer.getChannelData(2), buffer.getChannelData(3)];
      for (let i = 0; i < left.length; i += 1) {
        left[i] = 0.5 * (l[i] + sl[i]);
        right[i] = 0.5 * (r[i] + sr[i]);
      }
    } else {
      // L R C LFE SL SR; the LFE is left out, as the spec does.
      const [centre, sl, sr] = [buffer.getChannelData(2), buffer.getChannelData(4), buffer.getChannelData(5)];
      for (let i = 0; i < left.length; i += 1) {
        left[i] = l[i] + Math.SQRT1_2 * (centre[i] + sl[i]);
        right[i] = r[i] + Math.SQRT1_2 * (centre[i] + sr[i]);
      }
    }
    return out;
  }

  for (let c = 0; c < channels; c += 1) {
    const source = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
    out.copyToChannel(source.slice(), c);
  }
  return out;
}

export function extractChannel(buffer: AudioBuffer, index: number): AudioBuffer {
  const c = Math.min(Math.max(0, index), buffer.numberOfChannels - 1);
  const out = createBuffer(1, buffer.length, buffer.sampleRate);
  out.copyToChannel(buffer.getChannelData(c).slice(), 0);
  return out;
}

export function swapChannels(buffer: AudioBuffer): AudioBuffer {
  if (buffer.numberOfChannels < 2) return cloneBuffer(buffer);
  const out = createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  out.copyToChannel(buffer.getChannelData(1).slice(), 0);
  out.copyToChannel(buffer.getChannelData(0).slice(), 1);
  for (let c = 2; c < buffer.numberOfChannels; c += 1) {
    out.copyToChannel(buffer.getChannelData(c).slice(), c);
  }
  return out;
}

export function invertPhase(buffer: AudioBuffer): AudioBuffer {
  const out = createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < src.length; i += 1) dst[i] = -src[i];
  }
  return out;
}

/**
 * Sample-rate conversion with a band-limiting filter (resample.ts).
 *
 * This was linear interpolation, on the grounds that its artefacts are
 * inaudible at the ratios these tools use. They are not: at 2x speed or +12
 * semitones, a 15 kHz cymbal came back as a 14 kHz tone at full level, and the
 * file-size tool's drop to 16 kHz put a 10 kHz tone at 6 kHz. Linear
 * interpolation also dulls what it keeps, 3 dB down at 15 kHz from 44.1 to
 * 48 kHz.
 *
 * `length` pins the frame count when a round trip must land exactly.
 */
export function resample(
  buffer: AudioBuffer,
  rate: number,
  length = Math.max(1, Math.round((buffer.length * rate) / buffer.sampleRate))
): AudioBuffer {
  if (rate === buffer.sampleRate && length === buffer.length) return cloneBuffer(buffer);
  const out = createBuffer(buffer.numberOfChannels, length, rate);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    out.copyToChannel(resampleChannel(buffer.getChannelData(c), buffer.sampleRate, rate, length), c);
  }
  return out;
}

/**
 * Playback-rate change: faster means higher, like a record sped up. This is
 * what people mean by "speed up audio" unless they ask to keep the pitch.
 */
export function changeSpeed(buffer: AudioBuffer, rate: number): AudioBuffer {
  return runAll(changeSpeedSteps(buffer, rate));
}

/**
 * changeSpeed as steps that may pause. The share it yields counts every
 * channel.
 */
export function* changeSpeedSteps(buffer: AudioBuffer, rate: number): Steps<AudioBuffer> {
  const safe = Math.min(4, Math.max(0.25, rate));
  if (safe === 1) return cloneBuffer(buffer);
  const from = buffer.sampleRate;
  const to = from / safe;
  const channels = buffer.numberOfChannels;
  // The length resample() gives the new rate. Resampled to it, the data is the
  // right length; labelled with the original rate, it plays back faster rather
  // than simply being a lower-rate file.
  const length = Math.max(1, Math.round((buffer.length * to) / from));
  const out = createBuffer(channels, length, from);
  for (let c = 0; c < channels; c += 1) {
    const steps = resampleChannelSteps(buffer.getChannelData(c), from, to, length);
    for (;;) {
      const next = steps.next();
      if (next.done) {
        out.copyToChannel(next.value, c);
        break;
      }
      yield (c + next.value) / channels;
    }
  }
  return out;
}

/**
 * changeSpeed a slice at a time. On a 10-minute song the resample is three to
 * four seconds of arithmetic, which froze the page when a preview ran it in
 * one go.
 */
export function changeSpeedSliced(
  buffer: AudioBuffer,
  rate: number,
  options?: SliceOptions
): Promise<AudioBuffer> {
  return runSliced(changeSpeedSteps(buffer, rate), options);
}

export function padSilence(
  buffer: AudioBuffer,
  leadSec: number,
  tailSec: number
): AudioBuffer {
  const rate = buffer.sampleRate;
  const lead = Math.max(0, Math.round(leadSec * rate));
  const tail = Math.max(0, Math.round(tailSec * rate));
  if (lead === 0 && tail === 0) return cloneBuffer(buffer);

  const out = createBuffer(buffer.numberOfChannels, buffer.length + lead + tail, rate);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const dst = out.getChannelData(c);
    dst.set(buffer.getChannelData(c), lead);
  }
  return out;
}

export function loop(buffer: AudioBuffer, times: number, gapSec = 0): AudioBuffer {
  const count = Math.max(1, Math.floor(times));
  if (count === 1 && gapSec <= 0) return cloneBuffer(buffer);
  const unit = gapSec > 0 ? padSilence(buffer, 0, gapSec) : buffer;
  return concat(new Array(count).fill(unit));
}

/** Highest absolute sample value across all channels. */
export function peakOf(buffer: AudioBuffer): number {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i += 1) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

export function rmsOf(buffer: AudioBuffer): number {
  let sum = 0;
  let count = 0;
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
    count += data.length;
  }
  return count === 0 ? 0 : Math.sqrt(sum / count);
}

/** Scales so the loudest sample lands at `targetDb` (default -1 dBFS). */
export function normalizePeak(buffer: AudioBuffer, targetDb = -1): AudioBuffer {
  const peak = peakOf(buffer);
  if (peak === 0) return cloneBuffer(buffer);
  const target = gainFactor(targetDb);
  return applyGain(buffer, toDecibels(target / peak));
}

export interface SilenceRegion {
  start: number;
  end: number;
}

/**
 * Finds stretches quieter than `thresholdDb` lasting at least `minSec`.
 * Analysis runs on 20ms windows, which is short enough to catch breaths and
 * long enough not to trigger on individual waveform zero-crossings.
 */
export function findSilence(
  buffer: AudioBuffer,
  thresholdDb = -45,
  minSec = 0.4
): SilenceRegion[] {
  const rate = buffer.sampleRate;
  const window = Math.max(1, Math.floor(rate * 0.02));
  const threshold = gainFactor(thresholdDb);
  const regions: SilenceRegion[] = [];
  const channels = buffer.numberOfChannels;

  let runStart: number | null = null;

  for (let pos = 0; pos < buffer.length; pos += window) {
    const end = Math.min(pos + window, buffer.length);
    let sum = 0;
    let count = 0;
    for (let c = 0; c < channels; c += 1) {
      const data = buffer.getChannelData(c);
      for (let i = pos; i < end; i += 1) sum += data[i] * data[i];
      count += end - pos;
    }
    const rms = count === 0 ? 0 : Math.sqrt(sum / count);

    if (rms < threshold) {
      if (runStart === null) runStart = pos;
    } else if (runStart !== null) {
      const startSec = runStart / rate;
      const endSec = pos / rate;
      if (endSec - startSec >= minSec) regions.push({ start: startSec, end: endSec });
      runStart = null;
    }
  }

  if (runStart !== null) {
    const startSec = runStart / rate;
    const endSec = buffer.length / rate;
    if (endSec - startSec >= minSec) regions.push({ start: startSec, end: endSec });
  }

  return regions;
}

/**
 * Drops silent stretches, leaving `padSec` of room on each side so speech
 * doesn't sound clipped at the joins. A short crossfade hides the seams.
 */
export function removeSilence(
  buffer: AudioBuffer,
  thresholdDb = -45,
  minSec = 0.4,
  padSec = 0.08
): AudioBuffer {
  const regions = findSilence(buffer, thresholdDb, minSec);
  if (regions.length === 0) return cloneBuffer(buffer);

  const keep: SilenceRegion[] = [];
  let cursor = 0;
  for (const region of regions) {
    const cutStart = Math.max(cursor, region.start + padSec);
    const cutEnd = Math.min(buffer.duration, region.end - padSec);
    if (cutEnd <= cutStart) continue;
    if (cutStart > cursor) keep.push({ start: cursor, end: cutStart });
    cursor = cutEnd;
  }
  if (cursor < buffer.duration) keep.push({ start: cursor, end: buffer.duration });
  if (keep.length === 0) return slice(buffer, 0, Math.min(0.1, buffer.duration));

  return concat(
    keep.map((r) => slice(buffer, r.start, r.end)),
    0.005
  );
}

/** Trims leading and trailing quiet without touching the middle. */
export function trimEnds(buffer: AudioBuffer, thresholdDb = -50): AudioBuffer {
  const threshold = gainFactor(thresholdDb);
  const channels = buffer.numberOfChannels;
  const length = buffer.length;

  const loudAt = (i: number): boolean => {
    for (let c = 0; c < channels; c += 1) {
      if (Math.abs(buffer.getChannelData(c)[i]) > threshold) return true;
    }
    return false;
  };

  let start = 0;
  while (start < length && !loudAt(start)) start += 1;
  if (start === length) return slice(buffer, 0, Math.min(0.1, buffer.duration));

  let end = length - 1;
  while (end > start && !loudAt(end)) end -= 1;

  return slice(buffer, start / buffer.sampleRate, (end + 1) / buffer.sampleRate);
}
