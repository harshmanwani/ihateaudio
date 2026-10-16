import { describe, it, expect } from 'vitest';
import { encodeWav } from '../../src/lib/audio/encode-wav';
import { createBuffer } from '../../src/lib/audio/dsp';
import { readFileFormat, readFormat } from '../../src/lib/audio/decode';

const RATE = 44100;

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz: 417-byte frames. Byte 3 holds the channel mode. */
function mp3Frames(length: number, mode: number) {
  const bytes = new Uint8Array(length);
  for (let at = 0; at + 4 <= length; at += 417) bytes.set([0xff, 0xfb, 0x90, mode << 6], at);
  return bytes;
}

const u16 = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(8 + body.length), ...ascii(type), ...body];
}

/** A one-track moov whose sample entry has this codec, channel count and rate, and no codec config. */
function moov(codec: string, channels: number, rate: number): number[] {
  const entry = box(
    codec,
    [...new Array(6).fill(0), ...u16(1), ...u16(0), ...u16(0), ...u32(0)],
    [...u16(channels), ...u16(16), ...u16(0), ...u16(0), ...u32(rate * 0x10000)]
  );
  const mdhd = box('mdhd', u32(0), u32(0), u32(0), u32(rate), u32(rate * 60), u32(0));
  const hdlr = box('hdlr', u32(0), u32(0), ascii('soun'), new Array(12).fill(0), [0]);
  const stbl = box('stbl', box('stsd', u32(0), u32(1), entry));
  return box('moov', box('trak', box('mdia', mdhd, hdlr, box('minf', stbl))));
}

describe('readFormat', () => {
  it('reads the channel count of our own WAV header', async () => {
    for (const channels of [1, 2, 6]) {
      const blob = encodeWav(createBuffer(channels, 100, 22050));
      expect(readFormat(await blob.arrayBuffer())).toEqual({ rate: 22050, channels });
    }
  });

  it('returns null for a WAV cut off inside its fmt chunk rather than throwing', async () => {
    const bytes = await encodeWav(createBuffer(1, 100, RATE)).arrayBuffer();
    // The rate field runs to byte 28; 26 bytes used to throw a RangeError here.
    expect(readFormat(bytes.slice(0, 26))).toBeNull();
  });

  it('reads an MP3 as mono only in single-channel mode', () => {
    expect(readFormat(mp3Frames(1024, 3).buffer)).toEqual({ rate: 44100, channels: 1 });
    for (const mode of [0, 1, 2]) {
      expect(readFormat(mp3Frames(1024, mode).buffer)).toEqual({ rate: 44100, channels: 2 });
    }
  });

  it('reads the FLAC STREAMINFO channel count', () => {
    const bytes = new Uint8Array(64);
    bytes.set([0x66, 0x4c, 0x61, 0x43], 0); // "fLaC"
    bytes[18] = 0x0a;
    bytes[19] = 0xc4;
    // Low 4 bits of the rate, then channels minus one (1 = stereo).
    bytes[20] = 0x40 | (1 << 1);
    expect(readFormat(bytes.buffer)).toEqual({ rate: 44100, channels: 2 });
  });
});

describe('readFileFormat', () => {
  it('reads a WAV from its first slice', async () => {
    const file = encodeWav(createBuffer(1, RATE * 3, RATE));
    expect(await readFileFormat(file)).toEqual({ rate: RATE, channels: 1 });
  });

  it('finds MP3 frames after an ID3 tag longer than the header window', async () => {
    // Cover art routinely makes the tag hundreds of KB.
    const tagBody = 300 * 1024;
    const id3 = new Uint8Array(10 + tagBody);
    id3.set([0x49, 0x44, 0x33, 4, 0, 0], 0); // "ID3" v2.4, no flags
    id3.set([(tagBody >> 21) & 0x7f, (tagBody >> 14) & 0x7f, (tagBody >> 7) & 0x7f, tagBody & 0x7f], 6);
    const file = new Blob([id3, mp3Frames(4096, 3)]);
    expect(await readFileFormat(file)).toEqual({ rate: 44100, channels: 1 });
  });

  // A recorder writes the moov last, so the header window holds only media.
  const recorded = (codec: string, channels: number, rate: number): Blob => {
    const ftyp = box('ftyp', ascii('M4A '), u32(0), ascii('isom'));
    const mdat = box('mdat', new Array(200 * 1024).fill(0));
    return new Blob([new Uint8Array([...ftyp, ...mdat, ...moov(codec, channels, rate)])]);
  };

  it('finds an MP4 moov that sits after the media data', async () => {
    expect(await readFileFormat(recorded('sowt', 1, 48000))).toEqual({ rate: 48000, channels: 1 });
  });

  it('counts an AAC track as two channels even when it says one', async () => {
    // HE-AAC v2 carries one channel and decodes to two.
    expect(await readFileFormat(recorded('mp4a', 1, 48000))).toEqual({ rate: 48000, channels: 2 });
  });

  it('returns null for a file it cannot place rather than guessing', async () => {
    expect(await readFileFormat(new Blob([new Uint8Array(4096).fill(7)]))).toBeNull();
  });
});
