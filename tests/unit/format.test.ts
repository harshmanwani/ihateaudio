import { describe, it, expect } from 'vitest';
import {
  timecode,
  duration,
  parseTimecode,
  filesize,
  db,
  baseName,
  extensionOf,
  outputName,
  clamp,
  pct,
  channelLabel,
  sampleRateLabel,
} from '../../src/lib/format';

describe('timecode', () => {
  it('formats minutes and centiseconds', () => {
    expect(timecode(0)).toBe('0:00.00');
    expect(timecode(74.5)).toBe('1:14.50');
    expect(timecode(9.99)).toBe('0:09.99');
  });

  it('adds an hours field only when needed', () => {
    expect(timecode(3725.5)).toBe('1:02:05.50');
    expect(timecode(59, true)).toBe('0:00:59.00');
  });

  it('clamps nonsense rather than rendering NaN into the UI', () => {
    expect(timecode(-5)).toBe('0:00.00');
    expect(timecode(NaN)).toBe('0:00.00');
    expect(timecode(Infinity)).toBe('0:00.00');
  });
});

describe('duration', () => {
  it('rounds to whole seconds', () => {
    expect(duration(0)).toBe('0:00');
    expect(duration(65)).toBe('1:05');
    expect(duration(3661)).toBe('1:01:01');
  });

  it('carries a rounded 60 into the next unit', () => {
    // 59.7s must read 1:00, never 0:60.
    expect(duration(59.7)).toBe('1:00');
    expect(duration(3599.8)).toBe('1:00:00');
  });
});

describe('parseTimecode', () => {
  it('accepts the formats a user would actually type', () => {
    expect(parseTimecode('90')).toBe(90);
    expect(parseTimecode('1:30')).toBe(90);
    expect(parseTimecode('1:30.5')).toBe(90.5);
    expect(parseTimecode('01:02:03')).toBe(3723);
    expect(parseTimecode('  1:30  ')).toBe(90);
  });

  it('rejects anything it cannot parse instead of guessing', () => {
    expect(parseTimecode('')).toBeNull();
    expect(parseTimecode('abc')).toBeNull();
    expect(parseTimecode('1:2:3:4')).toBeNull();
    expect(parseTimecode('-5')).toBeNull();
    expect(parseTimecode('1:30:')).toBeNull();
  });

  it('round-trips with timecode', () => {
    for (const seconds of [0, 1.25, 61.5, 3725.5]) {
      expect(parseTimecode(timecode(seconds))).toBeCloseTo(seconds, 2);
    }
  });
});

describe('filesize', () => {
  it('scales through the units', () => {
    expect(filesize(0)).toBe('0 B');
    expect(filesize(512)).toBe('512 B');
    expect(filesize(1024)).toBe('1.0 KB');
    expect(filesize(1536)).toBe('1.5 KB');
    expect(filesize(1024 * 1024 * 5.5)).toBe('5.5 MB');
    expect(filesize(1024 * 1024 * 1024 * 2)).toBe('2.0 GB');
  });

  it('drops the decimal above ten to keep columns narrow', () => {
    expect(filesize(1024 * 25)).toBe('25 KB');
  });
});

describe('db', () => {
  it('signs the value and uses a real minus sign', () => {
    expect(db(3)).toBe('+3.0 dB');
    expect(db(-6.5)).toBe('−6.5 dB');
    expect(db(0)).toBe('0.0 dB');
    expect(db(-Infinity)).toBe('−∞ dB');
  });
});

describe('filenames', () => {
  it('splits base and extension', () => {
    expect(baseName('song.mp3')).toBe('song');
    expect(baseName('my.song.final.wav')).toBe('my.song.final');
    expect(baseName('noext')).toBe('noext');
    expect(baseName('/path/to/song.mp3')).toBe('song');
    expect(extensionOf('song.MP3')).toBe('mp3');
    expect(extensionOf('noext')).toBe('');
  });

  it('does not stack the same suffix on repeat runs', () => {
    expect(outputName('song.mp3', 'trimmed', 'mp3')).toBe('song-trimmed.mp3');
    // Re-running the trimmer on its own output must not give
    // song-trimmed-trimmed.mp3.
    expect(outputName('song-trimmed.mp3', 'trimmed', 'mp3')).toBe(
      'song-trimmed.mp3'
    );
    expect(outputName('song-TRIMMED.mp3', 'trimmed', 'wav')).toBe(
      'song-TRIMMED.wav'
    );
  });

  it('falls back to a usable name when there is none', () => {
    expect(outputName('', 'trimmed', 'mp3')).toBe('audio-trimmed.mp3');
  });
});

describe('clamp and pct', () => {
  it('clamps and treats NaN as the low bound', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(50, 0, 10)).toBe(10);
    expect(clamp(NaN, 2, 10)).toBe(2);
  });

  it('maps a value onto 0..100 without dividing by zero', () => {
    expect(pct(5, 0, 10)).toBe(50);
    expect(pct(-1, 0, 10)).toBe(0);
    expect(pct(11, 0, 10)).toBe(100);
    expect(pct(5, 5, 5)).toBe(0);
  });
});

describe('labels', () => {
  it('names channel counts and sample rates', () => {
    expect(channelLabel(1)).toBe('Mono');
    expect(channelLabel(2)).toBe('Stereo');
    expect(channelLabel(6)).toBe('6 channels');
    expect(sampleRateLabel(44100)).toBe('44.1 kHz');
    expect(sampleRateLabel(48000)).toBe('48 kHz');
  });
});
