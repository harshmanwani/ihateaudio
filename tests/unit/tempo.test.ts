/**
 * Tempo detection, including the beat phase the grid is drawn from.
 *
 * The BPM figure has been on the page for a while; the phase is new, and it is
 * the kind of thing that can drift silently — a grid one eighth-note out still
 * looks like a grid, and nobody would notice from the number. Pinning it against
 * a synthesised click track at a known tempo and a known start is the only way
 * that stays true.
 */
import { describe, expect, it } from 'vitest';
import { detectTempo } from '../../src/lib/audio/analysis';

const RATE = 44100;

/**
 * A click track: short decaying tone bursts at a fixed interval.
 *
 * `firstBeat` shifts the whole pattern, which is what exercises the phase
 * search — a detector that assumes beat one is at sample zero passes the tempo
 * assertion and fails this.
 */
function clickTrack(bpm: number, seconds: number, firstBeat = 0): AudioBuffer {
  const length = Math.round(RATE * seconds);
  const buffer = new AudioBuffer({ numberOfChannels: 1, length, sampleRate: RATE });
  const data = buffer.getChannelData(0);
  const period = 60 / bpm;

  for (let beat = 0; ; beat += 1) {
    const at = firstBeat + beat * period;
    if (at >= seconds) break;
    const start = Math.round(at * RATE);
    // ~40 ms of 1.2 kHz decaying fast, which is what a metronome sounds like
    // to an onset detector.
    for (let i = 0; i < RATE * 0.04 && start + i < length; i += 1) {
      const t = i / RATE;
      data[start + i] += Math.sin(2 * Math.PI * 1200 * t) * Math.exp(-35 * t) * 0.7;
    }
  }
  return buffer;
}

describe('detectTempo', () => {
  it('reads a click track at its actual tempo', () => {
    const result = detectTempo(clickTrack(120, 12));
    expect(result.bpm).toBeGreaterThan(118);
    expect(result.bpm).toBeLessThan(122);
    expect(result.confidence).toBeGreaterThan(0.2);
  });

  it('reports a beat period matching the tempo it reported', () => {
    // The grid is drawn from beatPeriod, so the two must not be able to
    // disagree — the folding from half or double time happens after the
    // period is chosen, and this is what catches it if only one of them folds.
    const result = detectTempo(clickTrack(100, 12));
    expect(result.beatPeriod).toBeCloseTo(60 / result.bpm, 6);
  });

  it('finds the phase when the first beat is not at zero', () => {
    const offset = 0.23;
    const result = detectTempo(clickTrack(120, 12, offset));
    const period = result.beatPeriod;

    // The grid may lock onto any beat, so compare modulo the period and allow
    // it to land either side of the wrap.
    const error = Math.abs(((result.beatOffset - offset) % period) + period) % period;
    const wrapped = Math.min(error, period - error);
    // Onset frames are 10 ms, so anything inside a couple of frames is exact.
    expect(wrapped).toBeLessThan(0.03);
  });

  it('puts a beat on the clicks, not between them', () => {
    // The failure this guards against: a phase half a beat out still produces a
    // regular grid, and would pass every test above.
    const bpm = 120;
    const offset = 0.4;
    const buffer = clickTrack(bpm, 12, offset);
    const result = detectTempo(buffer);
    const data = buffer.getChannelData(0);

    const energyAt = (seconds: number): number => {
      const start = Math.round(seconds * RATE);
      let sum = 0;
      for (let i = 0; i < RATE * 0.03; i += 1) sum += (data[start + i] ?? 0) ** 2;
      return sum;
    };

    // Sample the middle of the file so any startup transient is behind us.
    let onBeat = 0;
    let offBeat = 0;
    for (let n = 6; n < 16; n += 1) {
      const beat = result.beatOffset + n * result.beatPeriod;
      onBeat += energyAt(beat);
      offBeat += energyAt(beat + result.beatPeriod / 2);
    }
    expect(onBeat).toBeGreaterThan(offBeat * 10);
  });

  it('returns no grid for material with no beat in it', () => {
    const length = RATE * 6;
    const buffer = new AudioBuffer({ numberOfChannels: 1, length, sampleRate: RATE });
    const data = buffer.getChannelData(0);
    // A sustained tone: no onsets, so nothing to lock onto.
    for (let i = 0; i < length; i += 1) data[i] = Math.sin(2 * Math.PI * 220 * (i / RATE)) * 0.5;

    const result = detectTempo(buffer);
    expect(result.confidence).toBeLessThan(0.15);
  });
});
