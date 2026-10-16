import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuffer } from '../../src/lib/audio/dsp';

// ffmpeg.wasm cannot run under Node, and what matters here is what gets asked
// of it: the arguments and the depth of the WAV it is handed.
const encodeVia = vi.fn(async () => new Blob([new Uint8Array(4)]));
vi.mock('../../src/lib/audio/ffmpeg', () => ({ encodeVia }));

const {
  effectiveKbps,
  estimateSize,
  exportAudio,
  mp3Output,
  outputSampleRate,
  vorbisRange,
  writtenKbps,
} = await import('../../src/lib/audio/export');

/** A stand-in with the shape estimateSize reads, like the export bar builds. */
function proxy(seconds: number, sampleRate: number, channels: number): AudioBuffer {
  return {
    duration: seconds,
    length: Math.round(seconds * sampleRate),
    numberOfChannels: channels,
    sampleRate,
  } as AudioBuffer;
}

describe('mp3Output', () => {
  /*
   * Each row is a real lamejs encode, read back with ffprobe: input rate,
   * channels and requested bitrate, then the rate and bitrate in the file.
   */
  const measured: [number, number, number, number, number][] = [
    [44100, 2, 64, 24000, 64],
    [44100, 2, 96, 32000, 96],
    [44100, 2, 128, 44100, 128],
    [44100, 2, 320, 44100, 320],
    [48000, 2, 64, 24000, 64],
    [48000, 2, 128, 48000, 128],
    [32000, 2, 320, 32000, 320],
    [22050, 2, 128, 22050, 128],
    [22050, 2, 192, 22050, 160],
    [22050, 2, 320, 22050, 160],
    [16000, 2, 64, 16000, 64],
    [16000, 2, 192, 16000, 160],
    [16000, 1, 192, 16000, 160],
    [11025, 2, 64, 11025, 64],
    [8000, 2, 128, 8000, 64],
    [44100, 1, 64, 44100, 64],
    [44100, 1, 128, 44100, 128],
  ];

  it.each(measured)('%i Hz, %i ch at %i kbps → %i Hz, %i kbps', (rate, ch, asked, outRate, outKbps) => {
    expect(mp3Output(rate, asked, ch)).toEqual({ sampleRate: outRate, bitrate: outKbps });
  });

  it('sizes a 22.05 kHz MP3 at what lamejs writes, not at what was asked', () => {
    // A 31 s file asked for at 320 came out at 621,192 bytes; 320 would be twice that.
    const bytes = estimateSize(proxy(31.07, 22050, 2), 'mp3', { bitrate: 320 });
    expect(bytes).toBeGreaterThan(600_000);
    expect(bytes).toBeLessThan(650_000);
  });

  it('reports the rate lamejs drops to', () => {
    expect(outputSampleRate('mp3', 44100, 64, 2)).toBe(24000);
    expect(outputSampleRate('wav', 44100, 64, 2)).toBe(44100);
    expect(outputSampleRate('opus', 44100, 64, 2)).toBe(48000);
  });
});

describe('AAC ceiling', () => {
  it('stops at what the encoder reaches at low rates', () => {
    // Measured: 22.05 kHz mono tops out near 105 kbps, 16 kHz near 79.
    expect(writtenKbps('m4a', 192, 22050, 1)).toBeGreaterThan(95);
    expect(writtenKbps('m4a', 192, 22050, 1)).toBeLessThan(115);
    expect(writtenKbps('m4a', 128, 16000, 1)).toBeLessThan(85);
  });

  it('leaves the request alone where the encoder can meet it', () => {
    expect(writtenKbps('m4a', 128, 44100, 2)).toBe(128);
  });

  it('costs the measured overshoot below the ceiling', () => {
    // ffmpeg's AAC wrote up to 7.5% over at 44.1 kHz and 14.6% over at 16 kHz.
    expect(effectiveKbps('m4a', 96, 44100, 2)).toBeGreaterThanOrEqual(96 * 1.075);
    expect(effectiveKbps('m4a', 64, 16000, 1)).toBeGreaterThanOrEqual(64 * 1.146);
  });
});

describe('FLAC', () => {
  beforeEach(() => encodeVia.mockClear());

  it('is estimated, and written, at 16 bits by default', async () => {
    // A 16-bit stereo song: 5.48 MB as WAV, 3.03 MB as 16-bit FLAC, and 4.68 MB
    // when it was handed to ffmpeg as 24-bit.
    const seconds = 5481458 / 4 / 44100;
    const estimate = estimateSize(proxy(seconds, 44100, 2), 'flac');
    expect(estimate / 3029935).toBeGreaterThan(0.95);
    expect(estimate / 3029935).toBeLessThan(1.05);

    await exportAudio(createBuffer(2, 4410, 44100), 'flac');
    const [, , options] = encodeVia.mock.calls[0] as unknown as [
      AudioBuffer,
      string,
      { args: string[]; bitDepth: number },
    ];
    expect(options.bitDepth).toBe(16);
    expect(options.args).toContain('s16');
  });

  it('is estimated at 24 bits when the export will be 24-bit', () => {
    // A 24-bit stereo recording at 48 kHz, 22 s: 6,336,102 bytes as WAV,
    // 4,665,011 as the 24-bit FLAC the shipped core writes, 2,586,784 at 16.
    const source = proxy(1056000 / 48000, 48000, 2);
    for (const bitDepth of [24, 32] as const) {
      const estimate = estimateSize(source, 'flac', { bitDepth });
      expect(estimate / 4665011).toBeGreaterThan(0.8);
      expect(estimate / 4665011).toBeLessThan(1.2);
    }
    const sixteen = estimateSize(source, 'flac', { bitDepth: 16 });
    expect(sixteen / 2586784).toBeGreaterThan(0.8);
    expect(sixteen / 2586784).toBeLessThan(1.2);
  });

  it('goes to 24 bits only when 24 or 32 is asked for', async () => {
    await exportAudio(createBuffer(2, 4410, 44100), 'flac', { bitDepth: 32 });
    const [, , options] = encodeVia.mock.calls[0] as unknown as [
      AudioBuffer,
      string,
      { args: string[]; bitDepth: number },
    ];
    expect(options.bitDepth).toBe(24);
    expect(options.args).toContain('s32');
  });
});

describe('Opus arguments', () => {
  beforeEach(() => encodeVia.mockClear());

  const argsFor = async (channels: number): Promise<string[]> => {
    await exportAudio(createBuffer(channels, 4800, 48000), 'opus', { bitrate: 96 });
    const call = encodeVia.mock.calls.at(-1) as unknown as [AudioBuffer, string, { args: string[] }];
    return call[2].args;
  };

  it('constrains VBR, which otherwise overshot by up to 26%', async () => {
    const args = await argsFor(1);
    expect(args.join(' ')).toContain('-vbr constrained');
  });

  it('uses 10 ms frames for stereo, which crashed the wasm at 20 ms', async () => {
    expect((await argsFor(2)).join(' ')).toContain('-frame_duration 10');
    expect((await argsFor(6)).join(' ')).toContain('-frame_duration 10');
  });

  it('leaves mono at the default 20 ms frame', async () => {
    expect(await argsFor(1)).not.toContain('-frame_duration');
  });
});

describe('Vorbis', () => {
  beforeEach(() => encodeVia.mockClear());

  /*
   * Each row is the lowest and highest whole kbps libvorbis opened at in the
   * shipped core, with the next kbps out on either side refused: channels,
   * rate, low, high.
   */
  const measured: [number, number, number, number][] = [
    [1, 8000, 8, 42],
    [2, 8000, 12, 84],
    [1, 11025, 12, 50],
    [2, 11025, 16, 100],
    [1, 12000, 12, 50],
    [2, 12000, 16, 100],
    [1, 16000, 16, 100],
    [2, 16000, 24, 200],
    [1, 22050, 16, 90],
    [2, 22050, 30, 180],
    [1, 24000, 16, 90],
    [2, 24000, 30, 180],
    [1, 32000, 30, 190],
    [2, 32000, 36, 380],
    [1, 44100, 32, 240],
    [2, 44100, 45, 500],
    [1, 48000, 32, 240],
    [2, 48000, 45, 500],
    [3, 48000, 96, 720],
    [6, 48000, 84, 1440],
    [3, 8000, 24, 126],
    [3, 16000, 48, 300],
    [3, 22050, 48, 270],
    [3, 32000, 90, 570],
    [6, 8000, 48, 252],
    [6, 16000, 96, 600],
    [6, 22050, 96, 540],
    [6, 32000, 180, 1140],
  ];

  it.each(measured)('%i ch at %i Hz opens from %i to %i kbps', (ch, rate, low, high) => {
    expect(vorbisRange(rate, ch)).toEqual([low, high]);
  });

  it('asks for no more than libvorbis takes at 16 kHz mono', async () => {
    // 128 kbps here made ffmpeg fail to open the encoder and write nothing.
    await exportAudio(createBuffer(1, 1600, 16000), 'ogg', { bitrate: 128 });
    const [, , options] = encodeVia.mock.calls[0] as unknown as [
      AudioBuffer,
      string,
      { args: string[] },
    ];
    expect(options.args).toEqual(['-c:a', 'libvorbis', '-b:a', '100k']);
    expect(writtenKbps('ogg', 128, 16000, 1)).toBe(100);
    expect(effectiveKbps('ogg', 128, 16000, 1)).toBe(100);
    expect(estimateSize(proxy(20, 16000, 1), 'ogg', { bitrate: 128 })).toBe(
      estimateSize(proxy(20, 16000, 1), 'ogg', { bitrate: 100 })
    );
  });

  it('raises a request below the floor', () => {
    // 5.1 at 48 kHz will not go under 84 kbps.
    expect(writtenKbps('ogg', 64, 48000, 6)).toBe(84);
  });

  it('leaves a request it can meet alone', async () => {
    await exportAudio(createBuffer(2, 4410, 44100), 'ogg', { bitrate: 192 });
    const [, , options] = encodeVia.mock.calls[0] as unknown as [
      AudioBuffer,
      string,
      { args: string[] },
    ];
    expect(options.args).toEqual(['-c:a', 'libvorbis', '-b:a', '192k']);
    expect(writtenKbps('ogg', 192, 44100, 2)).toBe(192);
  });

  it('writes a 96 kHz file at 48 kHz, where it has a bitrate mode', async () => {
    // Past 50 kHz libvorbis refused every bitrate.
    await exportAudio(createBuffer(2, 9600, 96000), 'ogg', { bitrate: 192 });
    const [, , options] = encodeVia.mock.calls[0] as unknown as [
      AudioBuffer,
      string,
      { args: string[] },
    ];
    expect(options.args).toEqual(['-c:a', 'libvorbis', '-ar', '48000', '-b:a', '192k']);
    expect(outputSampleRate('ogg', 96000, 192, 2)).toBe(48000);
    expect(vorbisRange(96000, 1)).toEqual([32, 240]);
    expect(vorbisRange(6000, 1)).toEqual([8, 42]);
    expect(outputSampleRate('ogg', 6000, 64, 1)).toBe(8000);
  });
});
