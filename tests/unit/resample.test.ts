/**
 * Band-limited resampling, and the places that depend on it.
 *
 * The AI tools used to resample through an OfflineAudioContext on the belief
 * that it filters. In Chrome it interpolates linearly: a 44.1 kHz file through
 * the noise remover came back 5.5 dB down at 15 kHz, and a 48 kHz file reached
 * Whisper with a 10 kHz tone folded to 6 kHz at full level. These pin the
 * replacement's response with pure tones, where the right answer is exact.
 */
import { describe, expect, it } from 'vitest';
import { resampleChannel } from '../../src/lib/audio/resample';
import { setChannels } from '../../src/lib/audio/dsp';
import { toSrt, toVtt, toWhisperInput } from '../../src/lib/ai/transcribe';

function tone(rate: number, freq: number, seconds = 1): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i += 1) out[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** Level of `freq` in dB relative to the 0.5 amplitude of `tone`, away from the edges. */
function levelDb(data: Float32Array, rate: number, freq: number): number {
  const from = Math.round(data.length * 0.25);
  const to = Math.round(data.length * 0.75);
  let re = 0;
  let im = 0;
  for (let i = from; i < to; i += 1) {
    re += data[i]! * Math.cos((2 * Math.PI * freq * i) / rate);
    im += data[i]! * Math.sin((2 * Math.PI * freq * i) / rate);
  }
  return 20 * Math.log10((2 * Math.hypot(re, im)) / (to - from) / 0.5);
}

describe('resampleChannel', () => {
  it('keeps the treble flat between 44.1 and 48 kHz, both ways', () => {
    for (const [from, to] of [
      [44100, 48000],
      [48000, 44100],
    ] as const) {
      for (const freq of [1000, 10000, 15000, 18000]) {
        const out = resampleChannel(tone(from, freq), from, to);
        expect(Math.abs(levelDb(out, to, freq))).toBeLessThan(0.1);
      }
    }
  });

  it('removes what the lower rate cannot hold instead of folding it back', () => {
    // 10 kHz is above 16 kHz's Nyquist and would alias to 6 kHz.
    const out = resampleChannel(tone(48000, 10000), 48000, 16000);
    expect(levelDb(out, 16000, 6000)).toBeLessThan(-60);
  });

  it('lands on the requested length', () => {
    expect(resampleChannel(tone(44100, 440), 44100, 48000).length).toBe(48000);
    expect(resampleChannel(tone(48000, 440), 48000, 44100, 44099).length).toBe(44099);
  });
});

describe('toWhisperInput', () => {
  it('gives Whisper 16 kHz mono without the band above 8 kHz folded into it', async () => {
    const rate = 48000;
    const buffer = new AudioBuffer({ numberOfChannels: 2, length: rate, sampleRate: rate });
    buffer.copyToChannel(tone(rate, 1000), 0);
    buffer.copyToChannel(tone(rate, 10000), 1);

    const out = await toWhisperInput(buffer);
    expect(out.length).toBe(16000);
    // Each channel is half the mono mix, so the 1 kHz tone is 6 dB down. The
    // 10 kHz tone must not reappear at 6 kHz.
    expect(levelDb(out, 16000, 1000)).toBeCloseTo(-6.02, 1);
    expect(levelDb(out, 16000, 6000)).toBeLessThan(-60);
  });
});

describe('subtitle times', () => {
  it('carries a rounded millisecond into the seconds', () => {
    const segments = [{ start: 0, end: 2.9996, text: 'Hello' }];
    expect(toSrt(segments)).toContain('00:00:00,000 --> 00:00:03,000');
    expect(toVtt(segments)).toContain('00:00:00.000 --> 00:00:03.000');
  });
});

describe('setChannels to stereo from surround', () => {
  it('folds the 5.1 centre into both sides rather than dropping it', () => {
    const length = 100;
    const buffer = new AudioBuffer({ numberOfChannels: 6, length, sampleRate: 48000 });
    // Dialogue lives in the centre channel (index 2) and nowhere else.
    buffer.copyToChannel(new Float32Array(length).fill(0.5), 2);

    const stereo = setChannels(buffer, 2);
    expect(stereo.getChannelData(0)[50]).toBeCloseTo(0.5 * Math.SQRT1_2, 5);
    expect(stereo.getChannelData(1)[50]).toBeCloseTo(0.5 * Math.SQRT1_2, 5);
  });
});
