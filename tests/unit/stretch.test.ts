import { describe, it, expect } from 'vitest';
import {
  timeStretch,
  pitchShift,
  changeTempo,
  semitoneRatio,
} from '../../src/lib/audio/stretch';
import { createBuffer, peakOf } from '../../src/lib/audio/dsp';
import { toneBuffer } from '../../src/lib/audio/analysis';

const RATE = 44100;

/**
 * Estimates fundamental frequency by counting zero crossings. Crude, but
 * entirely sufficient to prove that pitch did or did not move, which is the
 * whole contract of these functions.
 */
function estimateFrequency(buffer: AudioBuffer): number {
  const data = buffer.getChannelData(0);
  // Skip the first and last 10% — WSOLA's window edges are not representative.
  const start = Math.floor(data.length * 0.1);
  const end = Math.floor(data.length * 0.9);

  let crossings = 0;
  for (let i = start + 1; i < end; i += 1) {
    if (data[i - 1] <= 0 && data[i] > 0) crossings += 1;
  }
  const seconds = (end - start) / buffer.sampleRate;
  return crossings / seconds;
}

describe('semitoneRatio', () => {
  it('maps octaves to doubling and halving', () => {
    expect(semitoneRatio(0)).toBeCloseTo(1, 6);
    expect(semitoneRatio(12)).toBeCloseTo(2, 6);
    expect(semitoneRatio(-12)).toBeCloseTo(0.5, 6);
    expect(semitoneRatio(7)).toBeCloseTo(1.4983, 3);
  });
});

describe('timeStretch', () => {
  it('is a no-op at factor 1', () => {
    const source = toneBuffer(2, 440, RATE, 1, -6);
    expect(timeStretch(source, 1).length).toBe(source.length);
  });

  it('lengthens by the factor', () => {
    const out = timeStretch(toneBuffer(2, 440, RATE, 1, -6), 2);
    expect(out.duration).toBeGreaterThan(3.5);
    expect(out.duration).toBeLessThan(4.5);
  });

  it('shortens by the factor', () => {
    const out = timeStretch(toneBuffer(4, 440, RATE, 1, -6), 0.5);
    expect(out.duration).toBeGreaterThan(1.5);
    expect(out.duration).toBeLessThan(2.5);
  });

  it('holds pitch while changing length — the entire point', () => {
    const source = toneBuffer(3, 440, RATE, 1, -6);
    const stretched = timeStretch(source, 1.5);
    expect(estimateFrequency(stretched)).toBeGreaterThan(400);
    expect(estimateFrequency(stretched)).toBeLessThan(480);
  });

  it('keeps the level roughly steady rather than doubling it at the overlaps', () => {
    // Window normalization is what prevents overlap-add from stacking gain.
    const source = toneBuffer(3, 440, RATE, 1, -6);
    const out = timeStretch(source, 1.5);
    expect(peakOf(out)).toBeLessThan(peakOf(source) * 1.6);
    expect(peakOf(out)).toBeGreaterThan(peakOf(source) * 0.4);
  });

  it('produces no NaN or Infinity', () => {
    const out = timeStretch(toneBuffer(2, 440, RATE, 2, -6), 1.7);
    const data = out.getChannelData(0);
    for (let i = 0; i < data.length; i += 97) {
      expect(Number.isFinite(data[i])).toBe(true);
    }
  });

  it('clamps extreme factors', () => {
    const out = timeStretch(toneBuffer(1, 440, RATE, 1, -6), 100);
    expect(out.duration).toBeLessThan(6);
  });

  it('preserves the channel count', () => {
    expect(timeStretch(toneBuffer(2, 440, RATE, 2, -6), 1.4).numberOfChannels).toBe(2);
  });
});

describe('changeTempo', () => {
  it('speeds up without moving pitch', () => {
    const source = toneBuffer(4, 440, RATE, 1, -6);
    const faster = changeTempo(source, 2);

    expect(faster.duration).toBeGreaterThan(1.5);
    expect(faster.duration).toBeLessThan(2.5);
    expect(estimateFrequency(faster)).toBeGreaterThan(400);
    expect(estimateFrequency(faster)).toBeLessThan(480);
  });

  it('slows down without moving pitch', () => {
    const slower = changeTempo(toneBuffer(2, 440, RATE, 1, -6), 0.5);
    expect(slower.duration).toBeGreaterThan(3.5);
    expect(estimateFrequency(slower)).toBeGreaterThan(400);
    expect(estimateFrequency(slower)).toBeLessThan(480);
  });
});

describe('pitchShift', () => {
  it('is a no-op at zero semitones', () => {
    const source = toneBuffer(2, 440, RATE, 1, -6);
    expect(pitchShift(source, 0).length).toBe(source.length);
  });

  it('raises pitch by an octave while holding duration', () => {
    const source = toneBuffer(3, 440, RATE, 1, -6);
    const up = pitchShift(source, 12);

    expect(estimateFrequency(up)).toBeGreaterThan(760);
    expect(estimateFrequency(up)).toBeLessThan(1040);
    // Duration must survive the stretch-then-resample round trip.
    expect(up.duration).toBeGreaterThan(source.duration * 0.85);
    expect(up.duration).toBeLessThan(source.duration * 1.15);
  });

  it('lowers pitch by an octave while holding duration', () => {
    const source = toneBuffer(3, 440, RATE, 1, -6);
    const down = pitchShift(source, -12);

    expect(estimateFrequency(down)).toBeGreaterThan(180);
    expect(estimateFrequency(down)).toBeLessThan(260);
    expect(down.duration).toBeGreaterThan(source.duration * 0.85);
    expect(down.duration).toBeLessThan(source.duration * 1.15);
  });

  it('keeps the output sample rate unchanged', () => {
    expect(pitchShift(toneBuffer(2, 440, RATE, 1, -6), 5).sampleRate).toBe(RATE);
  });

  it('handles an empty-ish buffer without throwing', () => {
    expect(() => pitchShift(createBuffer(1, 64, RATE), 3)).not.toThrow();
  });
});
