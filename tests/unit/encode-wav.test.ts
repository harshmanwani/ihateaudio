import { describe, it, expect } from 'vitest';
import { encodeWav, fitsIn16Bits, wavSize } from '../../src/lib/audio/encode-wav';
import { createBuffer } from '../../src/lib/audio/dsp';
import { detectSampleRate } from '../../src/lib/audio/decode';

const RATE = 44100;

async function view(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

function ascii(dv: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(dv.getUint8(offset + i));
  return out;
}

describe('encodeWav header', () => {
  it('writes a valid RIFF/WAVE header', async () => {
    const buffer = createBuffer(2, RATE, RATE);
    const dv = await view(encodeWav(buffer));

    expect(ascii(dv, 0, 4)).toBe('RIFF');
    expect(ascii(dv, 8, 4)).toBe('WAVE');
    expect(ascii(dv, 12, 4)).toBe('fmt ');
    expect(ascii(dv, 36, 4)).toBe('data');

    expect(dv.getUint32(16, true)).toBe(16); // fmt chunk size
    expect(dv.getUint16(20, true)).toBe(1); // PCM
    expect(dv.getUint16(22, true)).toBe(2); // channels
    expect(dv.getUint32(24, true)).toBe(RATE);
    expect(dv.getUint16(34, true)).toBe(16); // bit depth
  });

  it('declares sizes that match the actual payload', async () => {
    const buffer = createBuffer(2, 1000, RATE);
    const blob = encodeWav(buffer);
    const dv = await view(blob);

    const dataBytes = dv.getUint32(40, true);
    expect(dataBytes).toBe(1000 * 2 * 2);
    expect(dv.getUint32(4, true)).toBe(36 + dataBytes);
    expect(blob.size).toBe(44 + dataBytes);
  });

  it('marks 32-bit output as IEEE float, not PCM', async () => {
    const dv = await view(encodeWav(createBuffer(1, 100, RATE), { bitDepth: 32 }));
    expect(dv.getUint16(20, true)).toBe(3);
    expect(dv.getUint16(34, true)).toBe(32);
  });

  it('writes 24-bit samples three bytes wide', async () => {
    const blob = encodeWav(createBuffer(1, 100, RATE), { bitDepth: 24 });
    expect(blob.size).toBe(44 + 100 * 3);
  });

  it('sets the right MIME type', () => {
    expect(encodeWav(createBuffer(1, 10, RATE)).type).toBe('audio/wav');
  });
});

describe('encodeWav samples', () => {
  it('round-trips sample values through 16-bit', async () => {
    const buffer = createBuffer(1, 4, RATE);
    const data = buffer.getChannelData(0);
    data[0] = 0;
    data[1] = 0.5;
    data[2] = -0.5;
    data[3] = 1;

    const dv = await view(encodeWav(buffer));
    expect(dv.getInt16(44, true)).toBe(0);
    expect(dv.getInt16(46, true)).toBeCloseTo(16383, -1);
    expect(dv.getInt16(48, true)).toBeCloseTo(-16384, -1);
    expect(dv.getInt16(50, true)).toBe(32767);
  });

  it('uses the full negative range rather than wasting a step', async () => {
    // int16 runs -32768..32767. Scaling both sides by 32767 makes full-scale
    // negative peaks measurably quieter than positive ones.
    const buffer = createBuffer(1, 1, RATE);
    buffer.getChannelData(0)[0] = -1;

    const dv = await view(encodeWav(buffer));
    expect(dv.getInt16(44, true)).toBe(-32768);
  });

  it('clamps out-of-range samples instead of wrapping', async () => {
    const buffer = createBuffer(1, 2, RATE);
    buffer.getChannelData(0)[0] = 2.5;
    buffer.getChannelData(0)[1] = -2.5;

    const dv = await view(encodeWav(buffer));
    expect(dv.getInt16(44, true)).toBe(32767);
    expect(dv.getInt16(46, true)).toBe(-32768);
  });

  it('interleaves channels', async () => {
    const buffer = createBuffer(2, 2, RATE);
    buffer.getChannelData(0).fill(0.5);
    buffer.getChannelData(1).fill(-0.5);

    const dv = await view(encodeWav(buffer));
    expect(dv.getInt16(44, true)).toBeGreaterThan(0); // L
    expect(dv.getInt16(46, true)).toBeLessThan(0); // R
    expect(dv.getInt16(48, true)).toBeGreaterThan(0); // L
  });
});

/*
 * Decoding a 16-bit file and writing it straight back must give the same
 * file, or "lossless" is a lie. The decoders differ, so both conventions are
 * driven through every one of the 65,536 values. Chrome multiplies a positive
 * int16 by the float32 nearest 1 / 32767 and a negative one by 1 / 32768
 * (matched against decodeAudioData for every value); Firefox and Safari
 * divide both by 32768.
 */
describe('encodeWav 16-bit round trip', () => {
  const chrome = (k: number) => (k < 0 ? k / 32768 : Math.fround(k * Math.fround(1 / 32767)));
  const symmetric = (k: number) => k / 32768;

  async function roundTrip(decode: (k: number) => number): Promise<number[]> {
    const buffer = createBuffer(1, 65536, RATE);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < 65536; i += 1) data[i] = decode(i - 32768);
    const dv = await view(encodeWav(buffer));
    const changed: number[] = [];
    for (let i = 0; i < 65536; i += 1) {
      if (dv.getInt16(44 + i * 2, true) !== i - 32768) changed.push(i - 32768);
    }
    return changed;
  }

  it("returns every value unchanged through Chrome's decode", async () => {
    // Truncating instead of rounding changed 16,639 of these, all positive.
    expect(await roundTrip(chrome)).toEqual([]);
  });

  it('returns every value through a symmetric decode, bar the top 64 steps', async () => {
    // Before rounding: 32,767 changed, half the file, all biased downwards.
    const changed = await roundTrip(symmetric);
    expect(changed.length).toBeLessThanOrEqual(64);
    // The only casualties are where the two conventions share a float32.
    for (const k of changed) expect(k).toBeGreaterThan(32700);
  });

  it('rounds rather than truncating a value between two steps', async () => {
    const buffer = createBuffer(1, 2, RATE);
    buffer.getChannelData(0)[0] = 100.9 / 32768;
    buffer.getChannelData(0)[1] = -100.9 / 32768;
    const dv = await view(encodeWav(buffer));
    expect(dv.getInt16(44, true)).toBe(101);
    expect(dv.getInt16(46, true)).toBe(-101);
  });
});

describe('encodeWav 24-bit round trip', () => {
  it('returns 24-bit values unchanged, including the far negative half', async () => {
    // Scaling by 8388607 moved every sample beyond half scale by a step.
    const step = 97;
    const count = Math.floor(16777216 / step);
    const buffer = createBuffer(1, count, RATE);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < count; i += 1) data[i] = (i * step - 8388608) / 8388608;
    const dv = await view(encodeWav(buffer, { bitDepth: 24 }));
    let changed = 0;
    for (let i = 0; i < count; i += 1) {
      const at = 44 + i * 3;
      let v = dv.getUint8(at) | (dv.getUint8(at + 1) << 8) | (dv.getUint8(at + 2) << 16);
      if (v & 0x800000) v -= 0x1000000;
      if (v !== i * step - 8388608) changed += 1;
    }
    expect(changed).toBe(0);
  });

  it('clamps full scale positive to the largest 24-bit value', async () => {
    const buffer = createBuffer(1, 1, RATE);
    buffer.getChannelData(0)[0] = 1;
    const dv = await view(encodeWav(buffer, { bitDepth: 24 }));
    expect(dv.getUint8(44) | (dv.getUint8(45) << 8) | (dv.getUint8(46) << 16)).toBe(0x7fffff);
  });
});

describe('fitsIn16Bits', () => {
  it('accepts audio decoded from 16 bits, by either convention', () => {
    const buffer = createBuffer(2, 4000, RATE);
    for (let c = 0; c < 2; c += 1) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i += 1) {
        const k = Math.round(Math.sin(i / 7) * 30000);
        data[i] = c === 0 ? k / 32768 : k < 0 ? k / 32768 : Math.fround(k * Math.fround(1 / 32767));
      }
    }
    expect(fitsIn16Bits(buffer)).toBe(true);
  });

  it('rejects audio with more resolution than 16 bits', () => {
    const buffer = createBuffer(1, 4000, RATE);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.round(Math.sin(i / 7) * 8e6) / 8388608;
    expect(fitsIn16Bits(buffer)).toBe(false);
  });

  it('treats silence as fitting', () => {
    expect(fitsIn16Bits(createBuffer(1, 100, RATE))).toBe(true);
  });
});

describe('wavSize', () => {
  it('predicts the exact encoded size', () => {
    expect(wavSize(1000, 2, 16)).toBe(44 + 1000 * 2 * 2);
    expect(wavSize(1000, 1, 24)).toBe(44 + 1000 * 3);
    expect(wavSize(1000, 2, 32)).toBe(44 + 1000 * 2 * 4);
  });

  it('agrees with what encodeWav actually produces', () => {
    const buffer = createBuffer(2, 500, RATE);
    expect(encodeWav(buffer).size).toBe(wavSize(500, 2, 16));
  });
});

describe('detectSampleRate', () => {
  it('reads the rate back out of our own WAV header', async () => {
    for (const rate of [22050, 44100, 48000]) {
      const blob = encodeWav(createBuffer(1, 100, rate));
      expect(detectSampleRate(await blob.arrayBuffer())).toBe(rate);
    }
  });

  it('returns null for data it cannot parse rather than guessing', () => {
    expect(detectSampleRate(new ArrayBuffer(4))).toBeNull();
    expect(detectSampleRate(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)).toBeNull();
  });

  it('reads MPEG audio only when a second frame follows the first', () => {
    // MPEG-1 Layer III, 128 kbps, 44.1 kHz: 417-byte frames.
    const header = [0xff, 0xfb, 0x90, 0x00];
    const two = new Uint8Array(1024);
    two.set(header, 0);
    two.set(header, 417);
    expect(detectSampleRate(two.buffer)).toBe(44100);

    // The same header alone could be any two bytes of compressed data.
    const one = new Uint8Array(1024);
    one.set(header, 0);
    expect(detectSampleRate(one.buffer)).toBeNull();
  });

  it('does not read an AAC stream as MPEG audio', () => {
    // ADTS headers at 44.1 kHz pass a bare frame-sync check and used to read
    // as 22.05 kHz, so the file was decoded at half its rate.
    const bytes = new Uint8Array(4096);
    for (let at = 0; at + 7 < bytes.length; at += 371) {
      bytes.set([0xff, 0xf1, 0x50, 0x80, 0x2e, 0x7f, 0xfc], at);
    }
    expect(detectSampleRate(bytes.buffer)).toBeNull();
  });

  it('reads a FLAC STREAMINFO rate', () => {
    // fLaC + metadata block header + STREAMINFO with 44100 at bit offset 80.
    const bytes = new Uint8Array(64);
    bytes.set([0x66, 0x4c, 0x61, 0x43], 0); // "fLaC"
    // 44100 = 0xAC44 -> 20 bits starting at byte 18.
    bytes[18] = 0x0a;
    bytes[19] = 0xc4;
    bytes[20] = 0x40;
    expect(detectSampleRate(bytes.buffer)).toBe(44100);
  });
});
