import { describe, it, expect } from 'vitest';
import {
  createBuffer,
  cloneBuffer,
  slice,
  cutOut,
  applyGain,
  applyFade,
  reverse,
  concat,
  setChannels,
  extractChannel,
  swapChannels,
  invertPhase,
  resampleLinear,
  changeSpeed,
  padSilence,
  loop,
  peakOf,
  rmsOf,
  normalizePeak,
  findSilence,
  removeSilence,
  trimEnds,
  gainFactor,
  toDecibels,
} from '../../src/lib/audio/dsp';

const RATE = 44100;

/** Constant-valued buffer — makes gain and slicing assertions exact. */
function constantBuffer(seconds: number, value = 0.5, channels = 2): AudioBuffer {
  const buffer = createBuffer(channels, Math.round(seconds * RATE), RATE);
  for (let c = 0; c < channels; c += 1) {
    buffer.getChannelData(c).fill(value);
  }
  return buffer;
}

/** Ramps 0..1 across the buffer, so position is recoverable from value. */
function rampBuffer(seconds: number, channels = 1): AudioBuffer {
  const length = Math.round(seconds * RATE);
  const buffer = createBuffer(channels, length, RATE);
  for (let c = 0; c < channels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) data[i] = i / length;
  }
  return buffer;
}

describe('gain conversions', () => {
  it('round-trips between decibels and linear factors', () => {
    expect(gainFactor(0)).toBeCloseTo(1, 6);
    expect(gainFactor(6)).toBeCloseTo(1.9953, 3);
    expect(gainFactor(-6)).toBeCloseTo(0.5012, 3);
    expect(toDecibels(1)).toBeCloseTo(0, 6);
    expect(toDecibels(2)).toBeCloseTo(6.0206, 3);
    expect(toDecibels(0)).toBe(-Infinity);
  });
});

describe('slice', () => {
  it('extracts the requested range at sample accuracy', () => {
    const out = slice(constantBuffer(10), 2, 5);
    expect(out.length).toBe(3 * RATE);
    expect(out.duration).toBeCloseTo(3, 5);
    expect(out.sampleRate).toBe(RATE);
    expect(out.numberOfChannels).toBe(2);
  });

  it('takes the samples from the right offset', () => {
    const out = slice(rampBuffer(10), 5, 6);
    // Value at the ramp's halfway point.
    expect(out.getChannelData(0)[0]).toBeCloseTo(0.5, 3);
  });

  it('clamps out-of-range bounds instead of throwing', () => {
    const source = constantBuffer(5);
    expect(slice(source, -10, 2).duration).toBeCloseTo(2, 3);
    expect(slice(source, 3, 99).duration).toBeCloseTo(2, 3);
    // An inverted range must still produce something renderable.
    expect(slice(source, 4, 1).length).toBeGreaterThanOrEqual(1);
  });

  it('does not mutate its input', () => {
    const source = constantBuffer(3, 0.5);
    slice(source, 0, 1);
    expect(source.getChannelData(0)[0]).toBe(0.5);
    expect(source.length).toBe(3 * RATE);
  });
});

describe('cutOut', () => {
  it('removes the middle and joins the remainder', () => {
    const out = cutOut(constantBuffer(10), 4, 6);
    expect(out.duration).toBeCloseTo(8, 2);
  });

  it('degenerates to a plain slice at the edges', () => {
    const source = constantBuffer(10);
    expect(cutOut(source, 0, 3).duration).toBeCloseTo(7, 2);
    expect(cutOut(source, 7, 10).duration).toBeCloseTo(7, 2);
  });
});

describe('applyGain', () => {
  it('scales by the decibel amount', () => {
    const out = applyGain(constantBuffer(1, 0.25), 6);
    expect(out.getChannelData(0)[0]).toBeCloseTo(0.25 * gainFactor(6), 5);
  });

  it('hard-limits rather than wrapping when clipping', () => {
    const out = applyGain(constantBuffer(1, 0.9), 20);
    expect(out.getChannelData(0)[0]).toBe(1);
  });

  it('can be told not to clip', () => {
    const out = applyGain(constantBuffer(1, 0.9), 20, false);
    expect(out.getChannelData(0)[0]).toBeGreaterThan(1);
  });

  it('handles negative samples symmetrically', () => {
    const out = applyGain(constantBuffer(1, -0.9), 20);
    expect(out.getChannelData(0)[0]).toBe(-1);
  });
});

describe('applyFade', () => {
  it('starts at silence and reaches full level', () => {
    const out = applyFade(constantBuffer(4, 1), 1, 1, 'linear');
    const data = out.getChannelData(0);
    expect(data[0]).toBeCloseTo(0, 3);
    expect(data[Math.floor(RATE * 0.5)]).toBeCloseTo(0.5, 2);
    expect(data[Math.floor(RATE * 2)]).toBeCloseTo(1, 3);
    expect(data[out.length - 1]).toBeCloseTo(0, 2);
  });

  it('leaves the middle untouched', () => {
    const out = applyFade(constantBuffer(10, 0.8), 1, 1);
    expect(out.getChannelData(0)[RATE * 5]).toBeCloseTo(0.8, 5);
  });

  it('never reads past the end when fades exceed the duration', () => {
    const out = applyFade(constantBuffer(1, 1), 5, 5);
    expect(out.length).toBe(RATE);
    expect(Number.isFinite(out.getChannelData(0)[0])).toBe(true);
  });
});

describe('reverse', () => {
  it('mirrors the samples', () => {
    const out = reverse(rampBuffer(1));
    const data = out.getChannelData(0);
    expect(data[0]).toBeCloseTo(1, 2);
    expect(data[data.length - 1]).toBeCloseTo(0, 2);
  });

  it('is its own inverse', () => {
    const source = rampBuffer(1);
    const twice = reverse(reverse(source));
    expect(twice.getChannelData(0)[1000]).toBeCloseTo(
      source.getChannelData(0)[1000],
      6
    );
  });
});

describe('concat', () => {
  it('sums the durations', () => {
    const out = concat([constantBuffer(2), constantBuffer(3), constantBuffer(1)]);
    expect(out.duration).toBeCloseTo(6, 2);
  });

  it('shortens by the overlap when crossfading', () => {
    const out = concat([constantBuffer(2), constantBuffer(2)], 0.5);
    expect(out.duration).toBeCloseTo(3.5, 2);
  });

  it('promotes to the widest channel count so nothing is dropped', () => {
    const out = concat([constantBuffer(1, 0.5, 1), constantBuffer(1, 0.5, 2)]);
    expect(out.numberOfChannels).toBe(2);
  });

  it('resamples to the highest rate present', () => {
    const low = createBuffer(1, 22050, 22050);
    const high = createBuffer(1, 44100, 44100);
    expect(concat([low, high]).sampleRate).toBe(44100);
  });

  it('survives an empty list', () => {
    expect(concat([]).length).toBeGreaterThanOrEqual(1);
  });

  it('holds level steady through an equal-power crossfade', () => {
    const out = concat([constantBuffer(2, 0.5, 1), constantBuffer(2, 0.5, 1)], 1);
    const mid = out.getChannelData(0)[Math.floor(1.5 * RATE)];
    // Equal-power keeps the sum near the source level rather than dipping.
    expect(mid).toBeGreaterThan(0.6);
    expect(mid).toBeLessThan(0.75);
  });
});

describe('channel operations', () => {
  it('averages when downmixing to mono', () => {
    const stereo = createBuffer(2, 100, RATE);
    stereo.getChannelData(0).fill(1);
    stereo.getChannelData(1).fill(0);
    const mono = setChannels(stereo, 1);
    expect(mono.numberOfChannels).toBe(1);
    expect(mono.getChannelData(0)[0]).toBeCloseTo(0.5, 5);
  });

  it('duplicates when upmixing to stereo', () => {
    const stereo = setChannels(constantBuffer(1, 0.4, 1), 2);
    expect(stereo.numberOfChannels).toBe(2);
    expect(stereo.getChannelData(1)[0]).toBeCloseTo(0.4, 5);
  });

  it('extracts and swaps channels', () => {
    const stereo = createBuffer(2, 100, RATE);
    stereo.getChannelData(0).fill(0.2);
    stereo.getChannelData(1).fill(0.8);

    expect(extractChannel(stereo, 1).getChannelData(0)[0]).toBeCloseTo(0.8, 5);
    // Out-of-range index clamps rather than throwing.
    expect(extractChannel(stereo, 9).getChannelData(0)[0]).toBeCloseTo(0.8, 5);

    const swapped = swapChannels(stereo);
    expect(swapped.getChannelData(0)[0]).toBeCloseTo(0.8, 5);
    expect(swapped.getChannelData(1)[0]).toBeCloseTo(0.2, 5);
  });

  it('inverts phase', () => {
    const out = invertPhase(constantBuffer(1, 0.5));
    expect(out.getChannelData(0)[0]).toBeCloseTo(-0.5, 6);
  });
});

describe('resampleLinear', () => {
  it('changes rate and length together, holding duration', () => {
    const out = resampleLinear(constantBuffer(2, 0.5, 1), 22050);
    expect(out.sampleRate).toBe(22050);
    expect(out.length).toBe(22050 * 2);
    expect(out.duration).toBeCloseTo(2, 3);
  });

  it('preserves signal level', () => {
    const out = resampleLinear(constantBuffer(1, 0.5, 1), 48000);
    expect(out.getChannelData(0)[1000]).toBeCloseTo(0.5, 3);
  });

  it('is a no-op at the same rate', () => {
    const out = resampleLinear(constantBuffer(1), RATE);
    expect(out.length).toBe(RATE);
  });
});

describe('changeSpeed', () => {
  it('halves the duration at 2x while keeping the sample rate', () => {
    const out = changeSpeed(constantBuffer(4, 0.5, 1), 2);
    expect(out.sampleRate).toBe(RATE);
    expect(out.duration).toBeCloseTo(2, 1);
  });

  it('doubles the duration at 0.5x', () => {
    const out = changeSpeed(constantBuffer(2, 0.5, 1), 0.5);
    expect(out.duration).toBeCloseTo(4, 1);
  });

  it('clamps absurd rates rather than allocating forever', () => {
    const out = changeSpeed(constantBuffer(1, 0.5, 1), 100);
    expect(out.duration).toBeCloseTo(0.25, 1);
  });
});

describe('padSilence and loop', () => {
  it('adds silence at both ends without touching the content', () => {
    const out = padSilence(constantBuffer(1, 0.5, 1), 0.5, 0.5);
    expect(out.duration).toBeCloseTo(2, 2);
    expect(out.getChannelData(0)[0]).toBe(0);
    expect(out.getChannelData(0)[Math.floor(RATE)]).toBeCloseTo(0.5, 3);
    expect(out.getChannelData(0)[out.length - 1]).toBe(0);
  });

  it('repeats with and without a gap', () => {
    expect(loop(constantBuffer(1, 0.5, 1), 3).duration).toBeCloseTo(3, 2);
    expect(loop(constantBuffer(1, 0.5, 1), 3, 0.5).duration).toBeCloseTo(4.5, 2);
  });
});

describe('levels', () => {
  it('finds the peak across every channel', () => {
    const buffer = createBuffer(2, 100, RATE);
    buffer.getChannelData(0).fill(0.3);
    buffer.getChannelData(1).fill(-0.7);
    expect(peakOf(buffer)).toBeCloseTo(0.7, 6);
  });

  it('computes RMS', () => {
    expect(rmsOf(constantBuffer(1, 0.5, 1))).toBeCloseTo(0.5, 4);
  });

  it('normalizes the peak to the target', () => {
    const out = normalizePeak(constantBuffer(1, 0.1, 1), -1);
    expect(peakOf(out)).toBeCloseTo(gainFactor(-1), 3);
  });

  it('leaves digital silence alone rather than dividing by zero', () => {
    const out = normalizePeak(createBuffer(1, 100, RATE), -1);
    expect(peakOf(out)).toBe(0);
  });
});

describe('silence detection', () => {
  /** loud - quiet - loud, with the quiet section `gap` seconds long. */
  function gappedBuffer(gap: number): AudioBuffer {
    const total = Math.round(4 * RATE);
    const buffer = createBuffer(1, total, RATE);
    const data = buffer.getChannelData(0);
    const gapStart = Math.round(1.5 * RATE);
    const gapEnd = gapStart + Math.round(gap * RATE);
    for (let i = 0; i < total; i += 1) {
      data[i] = i >= gapStart && i < gapEnd ? 0 : Math.sin(i * 0.05) * 0.6;
    }
    return buffer;
  }

  it('finds a gap longer than the minimum', () => {
    const regions = findSilence(gappedBuffer(1), -45, 0.4);
    expect(regions.length).toBe(1);
    expect(regions[0].start).toBeCloseTo(1.5, 1);
    expect(regions[0].end).toBeCloseTo(2.5, 1);
  });

  it('ignores gaps shorter than the minimum', () => {
    expect(findSilence(gappedBuffer(0.1), -45, 0.4).length).toBe(0);
  });

  it('shortens the file by roughly the silence removed', () => {
    const source = gappedBuffer(1);
    const out = removeSilence(source, -45, 0.4, 0.05);
    expect(out.duration).toBeLessThan(source.duration);
    expect(out.duration).toBeGreaterThan(2.8);
  });

  it('returns the original when there is nothing to remove', () => {
    const source = gappedBuffer(0.05);
    expect(removeSilence(source, -45, 0.4).duration).toBeCloseTo(source.duration, 2);
  });

  it('never returns an empty buffer for entirely silent input', () => {
    const out = removeSilence(createBuffer(1, RATE * 3, RATE), -45, 0.4);
    expect(out.length).toBeGreaterThanOrEqual(1);
  });
});

describe('trimEnds', () => {
  it('removes leading and trailing quiet only', () => {
    const buffer = createBuffer(1, RATE * 4, RATE);
    const data = buffer.getChannelData(0);
    for (let i = RATE; i < RATE * 3; i += 1) data[i] = 0.5;

    const out = trimEnds(buffer, -50);
    expect(out.duration).toBeCloseTo(2, 1);
  });

  it('does not return zero length for silent input', () => {
    expect(trimEnds(createBuffer(1, RATE, RATE)).length).toBeGreaterThanOrEqual(1);
  });
});

describe('cloneBuffer', () => {
  it('produces an independent copy', () => {
    const source = constantBuffer(1, 0.5, 2);
    const copy = cloneBuffer(source);
    copy.getChannelData(0)[0] = 0.9;
    expect(source.getChannelData(0)[0]).toBe(0.5);
  });
});
