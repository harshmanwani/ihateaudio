import { describe, it, expect } from 'vitest';
import { encodeWav, wavSize } from '../../src/lib/audio/encode-wav';
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
