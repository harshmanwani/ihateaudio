/**
 * Speech or music, on material whose answer is known by construction.
 *
 * The thresholds in classify.ts were set on real recordings that cannot be
 * committed, so these tests build stand-ins instead: a babbling voice from a
 * pulse train and formant filters, and music from tones and drum hits. The
 * voice is crude, but it has the three things the classifier listens for in
 * real speech — a pitch that glides, syllables four or five times a second,
 * consonant hiss between vowels — and the music has what it listens for in
 * songs. If either stand-in drifts across the line, a threshold moved.
 *
 * The cases are the ones that broke the old three-vote version: speech with
 * no pauses, which it called music, and a solo instrument with gaps between
 * phrases, which it called speech.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classify, measure } from '../../src/lib/audio/classify';
import { createBuffer } from '../../src/lib/audio/dsp';

const RATE = 44100;

/** Seeded, so a failure reproduces. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function buffer(channels: Float32Array[]): AudioBuffer {
  const out = createBuffer(channels.length, channels[0]!.length, RATE);
  channels.forEach((data, c) => out.getChannelData(c).set(data));
  return out;
}

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** F1–F3 for five vowels, in Hz. */
const VOWELS = [
  [730, 1090, 2440],
  [270, 2290, 3010],
  [300, 870, 2240],
  [530, 1840, 2480],
  [570, 840, 2410],
];

/**
 * A voice saying nothing in particular.
 *
 * Each syllable is an optional burst of hiss, then a vowel: a pulse train
 * through three formant resonators, with a pitch that slides a few semitones
 * across the syllable and drifts down across the phrase the way speech does.
 * With `pauses` off the phrases run into each other, like a reader who never
 * breathes, which is the case the old classifier got wrong.
 */
function speech(seconds: number, options: { pauses?: boolean; seed?: number } = {}): AudioBuffer {
  const { pauses = true, seed = 1 } = options;
  const rand = random(seed);
  const data = new Float32Array(Math.floor(seconds * RATE));
  let at = 0;
  let phase = 0;

  while (at < data.length) {
    const syllables = 5 + Math.floor(rand() * 8);
    const top = 150 + rand() * 60;
    for (let s = 0; s < syllables && at < data.length; s += 1) {
      if (rand() < 0.6) {
        // Fricative: differenced noise, which tilts it up towards hiss.
        const length = Math.floor((0.04 + rand() * 0.06) * RATE);
        let previous = 0;
        for (let i = 0; i < length && at + i < data.length; i += 1) {
          const noise = rand() * 2 - 1;
          data[at + i] = (noise - previous) * 0.06 * Math.sin((Math.PI * i) / length);
          previous = noise;
        }
        at += length;
      }

      const length = Math.floor((0.12 + rand() * 0.16) * RATE);
      const formants = VOWELS[Math.floor(rand() * VOWELS.length)]!;
      const resonators = formants.map((f, k) => {
        const r = Math.exp((-Math.PI * (60 + 40 * k)) / RATE);
        return { a1: 2 * r * Math.cos((2 * Math.PI * f) / RATE), a2: -r * r, gain: (1 - r) * [1, 0.6, 0.3][k]!, y1: 0, y2: 0 };
      });
      // Declination over the phrase, plus a rise or fall within the syllable.
      const start = top * (1 - (0.3 * s) / syllables);
      const glide = (rand() * 2 - 1) * 4;
      for (let i = 0; i < length && at + i < data.length; i += 1) {
        const t = i / length;
        const f0 = start * 2 ** ((glide * t) / 12);
        phase += f0 / RATE;
        const pulse = phase >= 1 ? 1 : 0;
        if (phase >= 1) phase -= 1;
        let out = 0;
        for (const r of resonators) {
          const y = r.gain * pulse + r.a1 * r.y1 + r.a2 * r.y2;
          r.y2 = r.y1;
          r.y1 = y;
          out += y;
        }
        const envelope = Math.sin(Math.PI * Math.min(1, t * 1.2)) ** 0.7;
        data[at + i] = data[at + i]! + out * 4 * envelope;
      }
      at += length;
    }
    if (pauses) at += Math.floor((0.25 + rand() * 0.35) * RATE);
  }

  return buffer([data]);
}

/** Adds a decaying harmonic tone into `data`. */
function tone(data: Float32Array, start: number, seconds: number, f: number, amp: number, decay: number): void {
  const from = Math.floor(start * RATE);
  const length = Math.min(data.length - from, Math.floor(seconds * RATE));
  for (let i = 0; i < length; i += 1) {
    const t = i / RATE;
    const envelope = Math.min(1, t / 0.005) * Math.exp(-t / decay) * Math.min(1, (seconds - t) / 0.02);
    let v = 0;
    for (let h = 1; h <= 5; h += 1) v += Math.sin(2 * Math.PI * f * h * t) / h;
    data[from + i] = data[from + i]! + v * amp * envelope;
  }
}

function kick(data: Float32Array, start: number): void {
  const from = Math.floor(start * RATE);
  let phase = 0;
  for (let i = 0; i < 0.3 * RATE && from + i < data.length; i += 1) {
    const t = i / RATE;
    phase += (2 * Math.PI * (50 + 100 * Math.exp(-t / 0.03))) / RATE;
    data[from + i] = data[from + i]! + Math.sin(phase) * 0.5 * Math.exp(-t / 0.12);
  }
}

function hit(data: Float32Array, start: number, amp: number, rand: () => number): void {
  const from = Math.floor(start * RATE);
  for (let i = 0; i < 0.1 * RATE && from + i < data.length; i += 1) {
    data[from + i] = data[from + i]! + (rand() * 2 - 1) * amp * Math.exp(-i / RATE / 0.03);
  }
}

/** Kick, snare, bass and chords at 120 BPM, chords a little wider on the right. */
function band(seconds: number): AudioBuffer {
  const left = new Float32Array(seconds * RATE);
  const right = new Float32Array(seconds * RATE);
  const rand = random(4);
  const beat = 0.5;
  const roots = [45, 41, 48, 43];
  for (let b = 0; b * beat < seconds; b += 1) {
    const t = b * beat;
    const root = roots[Math.floor(b / 4) % 4]!;
    if (b % 2 === 0) {
      kick(left, t);
      kick(right, t);
    } else {
      hit(left, t, 0.25, rand);
      hit(right, t, 0.25, rand);
    }
    tone(left, t, beat * 0.9, hz(root - 12), 0.2, 0.4);
    tone(right, t, beat * 0.9, hz(root - 12), 0.2, 0.4);
    if (b % 4 === 0) {
      for (const interval of [12, 16, 19]) {
        tone(left, t, beat * 4, hz(root + interval), 0.05, 1.5);
        tone(right, t, beat * 4, hz(root + interval) * 1.002, 0.05, 1.5);
      }
    }
  }
  return buffer([left, right]);
}

/**
 * One hand on a piano, in mono, with a breath between phrases.
 *
 * The old classifier read this as speech: mono, pauses throughout, uneven
 * levels. All three were true, and none of them was the point.
 */
function piano(seconds: number, detuneCents = 0): AudioBuffer {
  const data = new Float32Array(seconds * RATE);
  const rand = random(1);
  const scale = [60, 62, 64, 65, 67, 69, 71, 72];
  let t = 0.2;
  while (t < seconds - 1) {
    const notes = 4 + Math.floor(rand() * 5);
    for (let n = 0; n < notes && t < seconds - 1; n += 1) {
      const midi = scale[Math.floor(rand() * scale.length)]! + detuneCents / 100;
      tone(data, t, 1.2, hz(midi), 0.25, 0.35);
      t += [0.25, 0.5, 0.5, 0.75][Math.floor(rand() * 4)]!;
    }
    t += 0.6 + rand();
  }
  return buffer([data]);
}

/** Four sustained chords, no beat, no gaps. */
function pad(seconds: number): AudioBuffer {
  const left = new Float32Array(seconds * RATE);
  const right = new Float32Array(seconds * RATE);
  const chords = [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 65]];
  for (let c = 0; c * 4 < seconds; c += 1) {
    for (const midi of chords[c % 4]!) {
      tone(left, c * 4, 4.2, hz(midi), 0.05, 6);
      tone(right, c * 4, 4.2, hz(midi) * 1.003, 0.05, 6);
    }
  }
  return buffer([left, right]);
}

/** The same mono signal on both channels, as most stereo voice files are. */
function dualMono(mono: AudioBuffer): AudioBuffer {
  const data = mono.getChannelData(0);
  return buffer([data.slice(), data.slice()]);
}

function mix(a: AudioBuffer, b: AudioBuffer, gainB: number): AudioBuffer {
  const channels = Math.max(a.numberOfChannels, b.numberOfChannels);
  const length = Math.min(a.length, b.length);
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c += 1) {
    const x = a.getChannelData(Math.min(c, a.numberOfChannels - 1));
    const y = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
    const data = new Float32Array(length);
    for (let i = 0; i < length; i += 1) data[i] = x[i]! + y[i]! * gainB;
    out.push(data);
  }
  return buffer(out);
}

describe('classify', () => {
  it('hears a voice with pauses as speech', () => {
    const result = classify(speech(12));
    expect(result).toMatchObject({ kind: 'speech', confident: true });
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('hears a voice with no pauses as speech', () => {
    // The original bug: no silence and flat dynamics read as music.
    const result = classify(speech(12, { pauses: false, seed: 2 }));
    expect(result).toMatchObject({ kind: 'speech', confident: true });
  });

  it('hears a short clip of speech', () => {
    expect(classify(speech(4, { seed: 3 }))).toMatchObject({ kind: 'speech', confident: true });
  });

  it('does not let a second identical channel change the answer', () => {
    const mono = speech(10, { seed: 4 });
    expect(classify(dualMono(mono))).toEqual(classify(mono));
  });

  it('hears a band as music, and says why', () => {
    const result = classify(band(16));
    expect(result).toMatchObject({ kind: 'music', confident: true });
    expect(result.reasons).toContain('a steady beat');
  });

  it('hears a solo piano with gaps as music', () => {
    // The other old bug: mono, pauses and uneven levels all voted speech.
    const result = classify(piano(16));
    expect(result).toMatchObject({ kind: 'music', confident: true });
    expect(result.reasons).toContain('the pitch sits on musical notes');
  });

  it('hears sustained chords as music', () => {
    expect(classify(pad(16))).toMatchObject({ kind: 'music', confident: true });
  });

  it('finds the notes whatever the tuning', () => {
    // On-grid is measured against the grid the notes themselves imply, so a
    // piano tuned 40 cents flat is as on-grid as one tuned to A440.
    const inTune = measure(piano(12))!;
    const flat = measure(piano(12, -40))!;
    expect(inTune.onNotes).toBeGreaterThan(0.6);
    expect(flat.onNotes).toBeGreaterThan(0.6);
    expect(measure(speech(12))!.onNotes).toBeLessThan(0.15);
  });

  it('measures syllables in speech and not in a pad', () => {
    expect(measure(speech(12))!.syllables).toBeGreaterThan(5);
    expect(measure(pad(12))!.syllables).toBeLessThan(2.5);
  });

  it('measures a beat in a band and not in speech', () => {
    expect(measure(band(12))!.beat).toBeGreaterThan(0.6);
    expect(measure(speech(12))!.beat).toBeLessThan(0.3);
  });

  it('calls a voice over loud music music, not speech', () => {
    // Wrong in the safe direction: a voiceover encoded as music is a bigger
    // file, while a song encoded as speech is ruined.
    const result = classify(mix(dualMono(speech(16, { seed: 5 })), band(16), 1));
    expect(result.kind).toBe('music');
  });

  it('treats every close call as music', () => {
    const cases = [
      speech(6, { seed: 6 }),
      mix(speech(10, { seed: 7 }), piano(10), 0.5),
      mix(speech(10, { seed: 8 }), pad(10), 0.5),
      mix(dualMono(speech(10, { seed: 9 })), band(10), 0.3),
    ];
    for (const audio of cases) {
      const result = classify(audio);
      if (!result.confident) expect(result).toEqual({ kind: 'music', confident: false, reasons: ['not certain'] });
    }
  });

  it('declines to judge a clip under two seconds, or silence', () => {
    expect(classify(speech(1.5))).toEqual({ kind: 'music', confident: false, reasons: ['too short to tell'] });
    const silence = createBuffer(2, RATE * 10, RATE);
    expect(classify(silence)).toEqual({ kind: 'music', confident: false, reasons: ['too quiet to tell'] });
  });

  it('keeps to a main-thread budget on a long file', () => {
    const long = mix(dualMono(speech(120, { seed: 10 })), band(120), 0.2);
    const started = performance.now();
    classify(long);
    // Three 8 s probes whatever the length; the time should not grow with it.
    expect(performance.now() - started).toBeLessThan(250);
  });
});

/**
 * The two fixtures named in the bug: continuous synthetic speech, clean and
 * with noise, which the old version called music. They are not committed, so
 * these run only where they exist.
 */
const FIXTURES = resolve(__dirname, '../fixtures');

function readWav(path: string): AudioBuffer {
  const bytes = readFileSync(path);
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  let offset = 12;
  while (offset < bytes.length - 8) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    if (id === 'data') {
      const frames = Math.floor(size / 2 / channels);
      const out = createBuffer(channels, frames, sampleRate);
      for (let c = 0; c < channels; c += 1) {
        const data = out.getChannelData(c);
        for (let i = 0; i < frames; i += 1) data[i] = bytes.readInt16LE(offset + 8 + (i * channels + c) * 2) / 32768;
      }
      return out;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${path}`);
}

describe.each(['ai-speech.wav', 'ai-noisy.wav'])('classify on %s', (name) => {
  const path = resolve(FIXTURES, name);
  it.skipIf(!existsSync(path))('hears speech', () => {
    expect(classify(readWav(path))).toMatchObject({ kind: 'speech', confident: true });
  });
});
