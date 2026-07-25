import { describe, it, expect } from 'vitest';
import {
  computeWaveform,
  measureLoudness,
  normalizeLoudness,
  detectTempo,
  peakDb,
  truePeakDb,
  computePeaks,
  toneBuffer,
  silentBuffer,
} from '../../src/lib/audio/analysis';
import { createBuffer, applyGain, gainFactor } from '../../src/lib/audio/dsp';

const RATE = 44100;

describe('measureLoudness', () => {
  it('reports -Infinity for digital silence', () => {
    const result = measureLoudness(silentBuffer(5, RATE, 2));
    expect(result.integrated).toBe(-Infinity);
    expect(result.peak).toBe(-Infinity);
  });

  it('tracks gain changes decibel for decibel', () => {
    // The absolute LUFS value depends on K-weighting at the test frequency,
    // but the *relationship* to gain is exact and is what the normalizer
    // depends on being right.
    const base = toneBuffer(5, 1000, RATE, 2, -20);
    const quiet = measureLoudness(base).integrated;
    const loud = measureLoudness(applyGain(base, 6, false)).integrated;

    expect(Number.isFinite(quiet)).toBe(true);
    expect(loud - quiet).toBeCloseTo(6, 1);
  });

  it('is independent of duration for steady material', () => {
    const short = measureLoudness(toneBuffer(3, 1000, RATE, 2, -20)).integrated;
    const long = measureLoudness(toneBuffer(9, 1000, RATE, 2, -20)).integrated;
    expect(short).toBeCloseTo(long, 1);
  });

  it('weights high frequencies above low ones, as K-weighting requires', () => {
    // The shelf adds roughly +4 dB above ~2 kHz, so an identical-amplitude
    // high tone must measure louder than a low one.
    const low = measureLoudness(toneBuffer(4, 200, RATE, 2, -20)).integrated;
    const high = measureLoudness(toneBuffer(4, 6000, RATE, 2, -20)).integrated;
    expect(high).toBeGreaterThan(low);
  });

  it('still returns a number for clips shorter than one gating block', () => {
    const result = measureLoudness(toneBuffer(0.2, 1000, RATE, 2, -20));
    expect(Number.isFinite(result.integrated)).toBe(true);
  });

  it('reports a loudness range near zero for unvarying material', () => {
    const result = measureLoudness(toneBuffer(12, 1000, RATE, 2, -20));
    expect(result.range).toBeLessThan(1);
  });
});

describe('peak measurement', () => {
  it('reports sample peak in dBFS', () => {
    const buffer = createBuffer(1, 100, RATE);
    buffer.getChannelData(0).fill(0.5);
    expect(peakDb(buffer)).toBeCloseTo(-6.02, 1);
  });

  it('finds inter-sample peaks above the sample peak', () => {
    // A sine at a quarter of the sample rate lands its true maximum between
    // samples, which is exactly the case that clips converters.
    const length = 4096;
    const buffer = createBuffer(1, length, RATE);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      data[i] = Math.sin((2 * Math.PI * i) / 4 + Math.PI / 4) * 0.98;
    }
    expect(truePeakDb(buffer)).toBeGreaterThan(peakDb(buffer));
  });

  it('reports -Infinity for silence', () => {
    expect(truePeakDb(silentBuffer(1, RATE, 1))).toBe(-Infinity);
  });
});

describe('normalizeLoudness', () => {
  it('moves a quiet file up to the target', () => {
    const quiet = toneBuffer(6, 1000, RATE, 2, -35);
    const { buffer, applied } = normalizeLoudness(quiet, -14, 0);

    expect(applied).toBeGreaterThan(0);
    expect(measureLoudness(buffer).integrated).toBeCloseTo(-14, 0);
  });

  it('brings a loud file down to the target', () => {
    const loud = toneBuffer(6, 1000, RATE, 2, -6);
    const { buffer, applied } = normalizeLoudness(loud, -20, 0);

    expect(applied).toBeLessThan(0);
    expect(measureLoudness(buffer).integrated).toBeCloseTo(-20, 0);
  });

  it('holds the true-peak ceiling even when that misses the target', () => {
    // A quiet file that would need a huge boost must stop at the ceiling
    // rather than clipping to reach the loudness target.
    const quiet = toneBuffer(6, 1000, RATE, 2, -30);
    const { buffer } = normalizeLoudness(quiet, 0, -1);

    expect(truePeakDb(buffer)).toBeLessThanOrEqual(-0.5);
  });

  it('leaves silence untouched instead of applying infinite gain', () => {
    const { applied } = normalizeLoudness(silentBuffer(3, RATE, 2), -14);
    expect(applied).toBe(0);
  });
});

describe('detectTempo', () => {
  /** Click track: a short burst every beat at the requested tempo. */
  function clickTrack(bpm: number, seconds = 12): AudioBuffer {
    const length = Math.round(seconds * RATE);
    const buffer = createBuffer(1, length, RATE);
    const data = buffer.getChannelData(0);
    const interval = Math.round((60 / bpm) * RATE);
    const burst = Math.round(RATE * 0.02);

    for (let beat = 0; beat * interval < length; beat += 1) {
      const start = beat * interval;
      for (let i = 0; i < burst && start + i < length; i += 1) {
        // Decaying noise burst reads as a percussive onset.
        data[start + i] = (Math.random() * 2 - 1) * (1 - i / burst) * 0.8;
      }
    }
    return buffer;
  }

  it('recovers a known tempo with high confidence', () => {
    const result = detectTempo(clickTrack(120));
    expect(result.bpm).toBeGreaterThan(115);
    expect(result.bpm).toBeLessThan(125);
    expect(result.confidence).toBeGreaterThan(0.8);
  });

  it('recovers a second, different tempo', () => {
    const result = detectTempo(clickTrack(90));
    expect(result.bpm).toBeGreaterThan(86);
    expect(result.bpm).toBeLessThan(94);
  });

  it('folds results into a musical range', () => {
    const result = detectTempo(clickTrack(160));
    expect(result.bpm).toBeGreaterThanOrEqual(70);
    expect(result.bpm).toBeLessThanOrEqual(180);
  });

  it('reports near-zero confidence for material with no beat', () => {
    // A sustained tone has no onsets. Autocorrelating that noise floor still
    // yields a sharp-looking peak, so confidence must be gated on how
    // percussive the material actually is — otherwise the tool confidently
    // reports a tempo for a file that has none.
    const result = detectTempo(toneBuffer(12, 440, RATE, 1, -12));
    expect(result.confidence).toBeLessThan(0.15);
  });

  it('reports zero confidence for silence', () => {
    expect(detectTempo(silentBuffer(12, RATE, 1)).confidence).toBe(0);
  });

  it('gives up gracefully on input that is too short', () => {
    expect(detectTempo(toneBuffer(0.1, 440, RATE, 1)).bpm).toBe(0);
  });
});

describe('computeWaveform', () => {
  it('returns one peak pair and one RMS value per column', () => {
    const data = computeWaveform(toneBuffer(2, 440, RATE, 1, -6), 128);
    expect(data.columns).toBe(128);
    expect(data.peaks.length).toBe(256);
    expect(data.rms.length).toBe(128);
  });

  it('keeps RMS inside the peak hull', () => {
    const data = computeWaveform(toneBuffer(2, 440, RATE, 2, -6), 64);
    for (let x = 0; x < data.columns; x += 1) {
      const min = data.peaks[x * 2];
      const max = data.peaks[x * 2 + 1];
      const hull = Math.max(Math.abs(min), Math.abs(max));
      expect(data.rms[x]).toBeLessThanOrEqual(hull + 1e-6);
    }
  });

  it('reports RMS at the correct level for a sine', () => {
    // A sine's RMS is its amplitude over root two.
    const amplitude = gainFactor(-6);
    const data = computeWaveform(toneBuffer(2, 440, RATE, 1, -6), 32);
    expect(data.rms[16]).toBeCloseTo(amplitude / Math.SQRT2, 2);
  });

  it('separates a loud passage from a quiet one', () => {
    const rate = RATE;
    const buffer = createBuffer(1, rate * 4, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      const t = i / rate;
      const amp = t < 2 ? 0.8 : 0.05;
      data[i] = Math.sin(2 * Math.PI * 300 * t) * amp;
    }

    const wave = computeWaveform(buffer, 100);
    const loud = wave.rms[25];
    const quiet = wave.rms[75];
    expect(loud).toBeGreaterThan(quiet * 8);
  });

  it('distinguishes a lone click from a genuinely loud column', () => {
    // This is the whole reason RMS is drawn alongside peak: one stray sample
    // must not make a quiet stretch look as loud as a chorus.
    const buffer = createBuffer(1, RATE, RATE);
    const data = buffer.getChannelData(0);
    data.fill(0.01);
    data[500] = 1;

    const wave = computeWaveform(buffer, 10);
    // The peak hull reaches full scale...
    expect(wave.peaks[1]).toBeCloseTo(1, 3);
    // ...while the body stays near the real level.
    expect(wave.rms[0]).toBeLessThan(0.05);
  });

  it('scans every sample, including the remainder in the last column', () => {
    // 1000 samples into 3 columns leaves a remainder that naive flooring drops.
    const buffer = createBuffer(1, 1000, RATE);
    const data = buffer.getChannelData(0);
    data[999] = 1;

    const wave = computeWaveform(buffer, 3);
    expect(wave.peaks[2 * 2 + 1]).toBeCloseTo(1, 5);
  });

  it('reports zero for digital silence', () => {
    const wave = computeWaveform(silentBuffer(1, RATE, 2), 16);
    for (let x = 0; x < wave.columns; x += 1) {
      expect(wave.rms[x]).toBe(0);
      expect(wave.peaks[x * 2]).toBe(0);
      expect(wave.peaks[x * 2 + 1]).toBe(0);
    }
  });

  it('handles more columns than samples without producing NaN', () => {
    const wave = computeWaveform(createBuffer(1, 8, RATE), 64);
    for (let x = 0; x < wave.columns; x += 1) {
      expect(Number.isFinite(wave.rms[x])).toBe(true);
      expect(Number.isFinite(wave.peaks[x * 2])).toBe(true);
    }
  });

  it('widens the hull across channels rather than picking one', () => {
    const buffer = createBuffer(2, 100, RATE);
    buffer.getChannelData(0).fill(0.3);
    buffer.getChannelData(1).fill(-0.9);

    const wave = computeWaveform(buffer, 1);
    expect(wave.peaks[0]).toBeCloseTo(-0.9, 5);
    expect(wave.peaks[1]).toBeCloseTo(0.3, 5);
  });
});

describe('computePeaks', () => {
  it('returns a min/max pair per column', () => {
    const peaks = computePeaks(toneBuffer(2, 440, RATE, 1, -6), 100);
    expect(peaks.length).toBe(200);

    for (let i = 0; i < 100; i += 1) {
      expect(peaks[i * 2]).toBeLessThanOrEqual(peaks[i * 2 + 1]);
    }
  });

  it('reflects the signal amplitude', () => {
    const peaks = computePeaks(toneBuffer(1, 440, RATE, 1, -6), 50);
    expect(peaks[21]).toBeCloseTo(gainFactor(-6), 1);
  });

  it('handles more columns than samples without crashing', () => {
    const tiny = createBuffer(1, 10, RATE);
    expect(computePeaks(tiny, 500).length).toBe(1000);
  });
});
