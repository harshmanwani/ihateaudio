import { describe, it, expect } from 'vitest';
import {
  computeWaveform,
  WaveformScan,
  measureLoudness,
  normalizeLoudness,
  detectTempo,
  peakDb,
  truePeakDb,
  computePeaks,
  standInWaveform,
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

  it('reads the EBU Tech 3341 12 kHz tones within the test tolerance', () => {
    // 48 kHz, 12 kHz at half scale, so the true peak is -6.02 dBTP whatever
    // the phase. At 45 and 60 degrees no sample lands on a crest; the old
    // cubic interpolation read -7.09 and -6.75. The test allows +0.2/-0.4 dB.
    // Faded in and out, because an abrupt start really does overshoot.
    const rate = 48000;
    for (const phase of [Math.PI / 4, Math.PI / 3]) {
      const buffer = createBuffer(1, rate, rate);
      const data = buffer.getChannelData(0);
      const fade = rate / 100;
      for (let i = 0; i < rate; i += 1) {
        const ramp = Math.min(1, i / fade, (rate - 1 - i) / fade);
        data[i] = 0.5 * ramp * Math.sin((2 * Math.PI * 12000 * i) / rate + phase);
      }
      const truePeak = truePeakDb(buffer);
      expect(truePeak).toBeGreaterThan(-6.02 - 0.4);
      expect(truePeak).toBeLessThan(-6.02 + 0.2);
    }
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

describe('WaveformScan', () => {
  /** A scan stepped with no time to spare, which is one column per step. */
  function sliced(...args: ConstructorParameters<typeof WaveformScan>) {
    const scan = new WaveformScan(...args);
    let steps = 0;
    while (!scan.step(0)) {
      steps += 1;
      expect(scan.filled).toBe(steps);
    }
    return { data: scan.data, steps: steps + 1 };
  }

  it('gives the same data a slice at a time as in one pass', () => {
    // Stereo, with a different signal in each channel, so the hull and the
    // body both depend on reading every channel in every slice.
    const buffer = createBuffer(2, RATE * 2, RATE);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    for (let i = 0; i < left.length; i += 1) {
      left[i] = Math.sin(i * 0.05) * (i / left.length);
      right[i] = Math.cos(i * 0.011) * 0.4;
    }

    const cases: [number, number?, number?][] = [
      [97],
      [300, 1234.5, 60321.7],
      // More columns than samples, so every column takes the one-sample path.
      [500, 10, 40],
    ];
    for (const [columns, from, to] of cases) {
      const whole = computeWaveform(buffer, columns, from, to);
      const { data, steps } = sliced(buffer, columns, from, to);
      expect(steps).toBe(columns);
      expect(Array.from(data.peaks)).toEqual(Array.from(whole.peaks));
      expect(Array.from(data.rms)).toEqual(Array.from(whole.rms));
    }
  });

  it('finishes in one step without a budget', () => {
    const scan = new WaveformScan(toneBuffer(1, 440, RATE, 1, -6), 64);
    expect(scan.done).toBe(false);
    expect(scan.step()).toBe(true);
    expect(scan.filled).toBe(64);
  });

  it('maps every sample to the column that reads it', () => {
    const buffer = createBuffer(1, 70000, RATE);
    const cases: [number, number?, number?][] = [[97], [300, 1234.5, 60321.7], [500, 10, 40]];
    for (const [columns, from, to] of cases) {
      const scan = new WaveformScan(buffer, columns, from, to);
      expect(scan.columnStart(0)).toBe(scan.first);
      expect(scan.columnEnd(columns - 1)).toBe(scan.last);
      for (let x = 0; x < columns - 1; x += 1) {
        expect(scan.columnEnd(x)).toBe(scan.columnStart(x + 1));
      }
      for (let i = scan.first; i < scan.last; i += 1) {
        const x = scan.columnAt(i);
        // A column narrower than a sample reads the one it starts on.
        const end = Math.max(scan.columnStart(x) + 1, scan.columnEnd(x));
        expect(i).toBeGreaterThanOrEqual(scan.columnStart(x));
        expect(i).toBeLessThan(end);
      }
    }
  });

  it('knows the full view and the whole-file overview are the same scan', () => {
    const buffer = toneBuffer(3, 440, RATE, 2, -6);
    const overview = new WaveformScan(buffer, 400);
    const fullView = new WaveformScan(buffer, 400, 0, buffer.duration * RATE);
    expect(overview.sameColumns(fullView)).toBe(true);
    overview.step();
    fullView.step();
    expect(Array.from(fullView.data.peaks)).toEqual(Array.from(overview.data.peaks));
    expect(Array.from(fullView.data.rms)).toEqual(Array.from(overview.data.rms));

    expect(overview.sameColumns(new WaveformScan(buffer, 401))).toBe(false);
    expect(overview.sameColumns(new WaveformScan(buffer, 400, 1))).toBe(false);
    const copy = toneBuffer(3, 440, RATE, 2, -6);
    expect(overview.sameColumns(new WaveformScan(copy, 400))).toBe(false);
  });
});

describe('standInWaveform', () => {
  const buffer = createBuffer(2, RATE * 4, RATE);
  for (let c = 0; c < 2; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = Math.sin(i * (0.003 + c * 0.001)) * Math.sin(i * 0.00007) * 0.9;
    }
  }
  const finished = (...args: ConstructorParameters<typeof WaveformScan>): WaveformScan => {
    const scan = new WaveformScan(...args);
    scan.step();
    return scan;
  };
  const scratch = (columns: number) => ({
    columns,
    peaks: new Float32Array(columns * 2),
    rms: new Float32Array(columns),
  });

  it('keeps the columns already scanned and borrows the rest', () => {
    const target = new WaveformScan(buffer, 300, 20000, 90000);
    target.step(0);
    target.step(0);
    const out = scratch(300);
    const runs = standInWaveform(target, [finished(buffer, 300, 20000, 90000)], out);
    expect(runs).toEqual([[0, 300]]);

    // A source with the same columns stands in exactly.
    const truth = computeWaveform(buffer, 300, 20000, 90000);
    expect(Array.from(out.peaks)).toEqual(Array.from(truth.peaks));
    expect(Array.from(out.rms)).toEqual(Array.from(truth.rms));
  });

  it('never draws a borrowed hull smaller than the true one', () => {
    // Zoomed in from the whole file, which is far coarser than the view.
    const target = new WaveformScan(buffer, 400, 31000.4, 77000.9);
    const out = scratch(400);
    const runs = standInWaveform(target, [finished(buffer, 90)], out);
    expect(runs).toEqual([[0, 400]]);

    const truth = computeWaveform(buffer, 400, 31000.4, 77000.9);
    for (let x = 0; x < 400; x += 1) {
      expect(out.peaks[x * 2]).toBeLessThanOrEqual(truth.peaks[x * 2]);
      expect(out.peaks[x * 2 + 1]).toBeGreaterThanOrEqual(truth.peaks[x * 2 + 1]);
    }
  });

  it('takes the finest source that covers a column, and skips what none has read', () => {
    const target = new WaveformScan(buffer, 200, 0, 100000);
    const out = scratch(200);
    // The first half of the range, finely, and nothing past it.
    const fine = finished(buffer, 500, 0, 50000);
    const half = new WaveformScan(buffer, 50, 0, 100000);
    half.step(0);
    const runs = standInWaveform(target, [half, fine], out);
    expect(runs).toEqual([[0, 100]]);

    const truth = computeWaveform(buffer, 200, 0, 100000);
    for (let x = 0; x < 100; x += 1) {
      expect(out.peaks[x * 2 + 1]).toBeCloseTo(truth.peaks[x * 2 + 1], 6);
      expect(out.peaks[x * 2]).toBeCloseTo(truth.peaks[x * 2], 6);
    }
  });

  it('ignores scans of another buffer', () => {
    const target = new WaveformScan(buffer, 100);
    const other = finished(toneBuffer(4, 440, RATE, 2, -6), 100);
    expect(standInWaveform(target, [other], scratch(100))).toEqual([]);
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
