import { describe, it, expect } from 'vitest';
import { compressorAutoMakeup, compressorCurve, echoTail } from '../../src/lib/audio/effects';

/**
 * Rendering goes through OfflineAudioContext, which Node does not have, so
 * these tests cover the arithmetic the rendering depends on: the static curve
 * the compressor page draws and the length the echo render runs to. The
 * anchor values were measured from a real DynamicsCompressorNode in headless
 * Chromium, as the steady-state output for a constant input, divided by the
 * node's own makeup gain.
 */

describe('compressorCurve', () => {
  const presets = [
    { name: 'voice', threshold: -20, knee: 6, ratio: 4 },
    { name: 'music', threshold: -18, knee: 10, ratio: 3 },
    { name: 'gentle', threshold: -12, knee: 12, ratio: 2 },
    { name: 'heavy', threshold: -28, knee: 3, ratio: 10 },
    { name: 'hard knee', threshold: -30, knee: 0, ratio: 20 },
    { name: 'widest knee', threshold: -40, knee: 40, ratio: 1.5 },
  ];

  for (const p of presets) {
    describe(p.name, () => {
      const curve = compressorCurve(p.threshold, p.knee, p.ratio);

      it('leaves everything up to the threshold untouched', () => {
        for (let level = -90; level <= p.threshold; level += 0.5) {
          expect(curve(level)).toBeCloseTo(level, 9);
        }
      });

      it('puts the knee above the threshold, not across it', () => {
        if (p.knee === 0) return;
        expect(curve(p.threshold + p.knee / 2)).toBeLessThan(p.threshold + p.knee / 2);
        expect(curve(p.threshold + p.knee)).toBeLessThan(p.threshold + p.knee);
      });

      it('holds the ratio above the knee', () => {
        const top = p.threshold + p.knee;
        const slope = (curve(top + 6) - curve(top)) / 6;
        expect(slope).toBeCloseTo(1 / p.ratio, 9);
      });

      it('is continuous and rising everywhere', () => {
        let previous = curve(-90);
        for (let level = -89.9; level <= 0; level += 0.1) {
          const out = curve(level);
          expect(out).toBeGreaterThan(previous);
          expect(out - previous).toBeLessThan(0.1 + 1e-9);
          previous = out;
        }
      });
    });
  }

  it('matches the curve Chromium renders', () => {
    const measured: [number, number, number, number, number][] = [
      // threshold, knee, ratio, input dB, output dB
      [-20, 6, 4, -17, -17.7411],
      [-20, 6, 4, -14, -16.5859],
      [-20, 6, 4, -6, -14.5859],
      [-20, 6, 4, 0, -13.086],
      [-28, 3, 10, -27, -27.2816],
      [-28, 3, 10, -25, -26.7754],
      [-28, 3, 10, -10, -25.2754],
      [-40, 40, 1.5, -30, -30.0488],
      [-40, 40, 1.5, -10, -10.9609],
      [-40, 40, 1.5, 0, -3.0359],
      [-30, 0, 20, -29, -29.9499],
      [-30, 0, 20, -10, -28.9998],
    ];
    for (const [threshold, knee, ratio, input, output] of measured) {
      expect(Math.abs(compressorCurve(threshold, knee, ratio)(input) - output)).toBeLessThan(0.005);
    }
  });

  it('clamps settings to the ranges the node accepts', () => {
    expect(compressorCurve(-150, 6, 4)(-60)).toBeCloseTo(compressorCurve(-100, 6, 4)(-60), 9);
    expect(compressorCurve(-20, 60, 4)(-10)).toBeCloseTo(compressorCurve(-20, 40, 4)(-10), 9);
    expect(compressorCurve(-20, 6, 50)(-10)).toBeCloseTo(compressorCurve(-20, 6, 20)(-10), 9);
  });
});

describe('compressorAutoMakeup', () => {
  it('matches the gain Chromium adds on its own', () => {
    const measured: [number, number, number, number][] = [
      // threshold, knee, ratio, node's own makeup in dB
      [-20, 6, 4, 7.8515],
      [-18, 10, 3, 5.282],
      [-12, 12, 2, 1.7081],
      [-28, 3, 10, 14.5652],
      [-30, 0, 20, 17.0999],
      [-40, 40, 1.5, 1.8215],
    ];
    for (const [threshold, knee, ratio, makeup] of measured) {
      expect(Math.abs(compressorAutoMakeup(threshold, knee, ratio) - makeup)).toBeLessThan(0.005);
    }
  });

  it('is nothing at 1:1', () => {
    expect(compressorAutoMakeup(-20, 6, 1)).toBeCloseTo(0, 1);
  });
});

describe('echoTail', () => {
  /** Level of the last repeat in the tail, relative to the first, in dB. */
  const lastRepeatDb = (delay: number, feedback: number): number => {
    const repeats = Math.round(echoTail(delay, feedback) / delay);
    return 20 * Math.log10(feedback ** (repeats - 1));
  };

  it('runs the repeats down to -60 dB at the top of the feedback range', () => {
    expect(echoTail(0.3, 0.85)).toBeCloseTo(0.3 * 44, 9);
    expect(lastRepeatDb(0.3, 0.85)).toBeLessThanOrEqual(-60);
  });

  it('stops at the first repeat past -60 dB, not later', () => {
    for (const feedback of [0.2, 0.35, 0.5, 0.72, 0.75, 0.85]) {
      const last = lastRepeatDb(0.25, feedback);
      expect(last).toBeLessThanOrEqual(-60);
      expect(last - 20 * Math.log10(feedback)).toBeGreaterThan(-60);
    }
  });

  it('clamps feedback where the effect does', () => {
    expect(echoTail(0.3, 0.99)).toBe(echoTail(0.3, 0.85));
  });

  it('gives a single repeat without feedback', () => {
    expect(echoTail(0.4, 0)).toBe(0.4);
  });
});
