/**
 * Buffer-level operations. Pure: every function returns a new AudioBuffer and
 * never mutates its input, so tools can re-run with different settings against
 * the original without re-decoding.
 *
 * Everything here is Tier 0 — plain Web Audio and typed arrays, no downloads.
 */

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

/** Removes [startSec, endSec) and joins the remainder. */
export function cutOut(
  buffer: AudioBuffer,
  startSec: number,
  endSec: number
): AudioBuffer {
  const head = slice(buffer, 0, startSec);
  const tail = slice(buffer, endSec, buffer.duration);
  if (startSec <= 0) return tail;
  if (endSec >= buffer.duration) return head;
  return concat([head, tail]);
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
    const dst = out.getChannelData(c);
    for (let i = 0; i < src.length; i += 1) {
      const v = src[i] * factor;
      dst[i] = clip ? (v > 1 ? 1 : v < -1 ? -1 : v) : v;
    }
  }
  return out;
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
  if (out.sampleRate !== sampleRate) out = resampleLinear(out, sampleRate);
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
 * Linear-interpolation resampler. Used for format matching and for
 * speed-with-pitch changes, where the artefacts are inaudible at the ratios
 * these tools use. Format conversion proper goes through the encoder.
 */
export function resampleLinear(buffer: AudioBuffer, rate: number): AudioBuffer {
  if (rate === buffer.sampleRate) return cloneBuffer(buffer);
  const ratio = rate / buffer.sampleRate;
  const length = Math.max(1, Math.round(buffer.length * ratio));
  const out = createBuffer(buffer.numberOfChannels, length, rate);

  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const src = buffer.getChannelData(c);
    const dst = out.getChannelData(c);
    const last = src.length - 1;
    for (let i = 0; i < length; i += 1) {
      const pos = i / ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = src[Math.min(idx, last)];
      const b = src[Math.min(idx + 1, last)];
      dst[i] = a + (b - a) * frac;
    }
  }
  return out;
}

/**
 * Playback-rate change: faster means higher, like a record sped up. This is
 * what people mean by "speed up audio" unless they ask to keep the pitch.
 */
export function changeSpeed(buffer: AudioBuffer, rate: number): AudioBuffer {
  const safe = Math.min(4, Math.max(0.25, rate));
  if (safe === 1) return cloneBuffer(buffer);
  const resampled = resampleLinear(buffer, buffer.sampleRate / safe);
  // The data is now the right length; relabel it at the original rate so it
  // plays back faster rather than simply being a lower-rate file.
  const out = createBuffer(resampled.numberOfChannels, resampled.length, buffer.sampleRate);
  for (let c = 0; c < resampled.numberOfChannels; c += 1) {
    out.copyToChannel(resampled.getChannelData(c).slice(), c);
  }
  return out;
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
