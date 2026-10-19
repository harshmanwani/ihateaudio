import { describe, expect, it } from 'vitest';
import { aacAdts, aacMp4, readConfig, type AacTrack } from '../../src/lib/audio/mp4-write';
import { boxes, fourcc, mp4AudioTrack } from '../../src/lib/audio/mp4';

/*
 * The writer against the site's own reader, plus the fields the reader does
 * not look at but players do: the edit list, the last packet's duration and
 * the chunk offsets.
 */

/** AAC-LC, 44.1 kHz, stereo: what ffmpeg's encoder writes as its config. */
const CONFIG = new Uint8Array([0x12, 0x10]);

function track(count: number, frames: number, sizes?: number[]): AacTrack {
  return {
    sampleRate: 44100,
    channels: 2,
    config: CONFIG,
    priming: 1024,
    frames,
    packetFrames: 1024,
    sizes: sizes ?? Array.from({ length: count }, (_, i) => 100 + (i % 7)),
  };
}

/** Packets whose every byte is their own index, so an offset can be checked by reading it. */
function payload(sizes: ArrayLike<number>): Uint8Array<ArrayBuffer> {
  const out: number[] = [];
  for (let i = 0; i < sizes.length; i += 1) out.push(...new Array(sizes[i]).fill(i & 0xff));
  return new Uint8Array(out);
}

async function bytesOf(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer());
}

function find(view: DataView, path: string[]): { at: number; end: number } {
  let start = 0;
  let end = view.byteLength;
  for (const type of path) {
    const skip = type === 'mp4a' ? 8 : 0;
    const box = boxes(view, start + skip, end).find((b) => b.type === type);
    if (!box) throw new Error(`no ${type}`);
    start = box.at;
    end = box.end;
  }
  return { at: start, end };
}

const STBL = ['moov', 'trak', 'mdia', 'minf', 'stbl'];

describe('aacMp4', () => {
  it('reads back as the AAC track it describes', async () => {
    const t = track(432, 441000);
    const blob = aacMp4(t, [payload(t.sizes)]);
    expect(blob.type).toBe('audio/mp4');
    const buffer = await blob.arrayBuffer();
    const info = mp4AudioTrack(buffer);
    expect(info).toMatchObject({ codec: 'mp4a', rate: 44100, channels: 2 });
    expect(info?.bytes).toBe(Array.from(t.sizes).reduce((a, b) => a + b, 0));
    // The media is the priming plus the audio, not 432 whole packets.
    expect(info?.seconds).toBeCloseTo((1024 + 441000) / 44100, 6);
  });

  it('puts the moov first, so playback can start before the end arrives', async () => {
    const view = await bytesOf(aacMp4(track(10, 9000), [payload(track(10, 9000).sizes)]));
    expect(boxes(view, 0, view.byteLength).map((b) => b.type)).toEqual(['ftyp', 'moov', 'mdat']);
  });

  /*
   * macOS read the first version of this file as 2112 samples of priming and
   * cut 17 ms off the end, because every packet claimed a full 1024. ffmpeg
   * shortens the last one to the samples it carries, and Apple reads that.
   */
  it('gives the last packet only the samples it carries, and skips the priming', async () => {
    const view = await bytesOf(aacMp4(track(432, 441000), [payload(track(432, 441000).sizes)]));
    const stts = find(view, [...STBL, 'stts']);
    expect(view.getUint32(stts.at + 4)).toBe(2);
    expect([view.getUint32(stts.at + 8), view.getUint32(stts.at + 12)]).toEqual([431, 1024]);
    expect([view.getUint32(stts.at + 16), view.getUint32(stts.at + 20)]).toEqual([1, 680]);

    const elst = find(view, ['moov', 'trak', 'edts', 'elst']);
    // One entry: 10 000 ms of audio, starting 1024 samples into the media.
    expect(view.getUint32(elst.at + 8)).toBe(10000);
    expect(view.getInt32(elst.at + 12)).toBe(1024);
  });

  it('points every chunk offset at its own packets', async () => {
    const t = track(200, 200 * 1024 - 2000);
    const view = await bytesOf(aacMp4(t, [payload(t.sizes)]));
    const stco = find(view, [...STBL, 'stco']);
    const stsc = find(view, [...STBL, 'stsc']);
    const chunks = view.getUint32(stco.at + 4);
    expect(chunks).toBe(Math.ceil(200 / 64));
    // 64 a chunk, then the 8 left over.
    expect(view.getUint32(stsc.at + 4)).toBe(2);
    expect(view.getUint32(stsc.at + 12)).toBe(64);
    expect(view.getUint32(stsc.at + 20)).toBe(4);
    expect(view.getUint32(stsc.at + 24)).toBe(8);
    for (let c = 0; c < chunks; c += 1) {
      const offset = view.getUint32(stco.at + 8 + c * 4);
      expect(view.getUint8(offset), `chunk ${c}`).toBe((c * 64) & 0xff);
    }
  });

  it('states the real channel count, which mp4.ts reads', async () => {
    const mono = { ...track(10, 9000), channels: 1, config: new Uint8Array([0x12, 0x08]) };
    const info = mp4AudioTrack(await aacMp4(mono, [payload(mono.sizes)]).arrayBuffer());
    expect(info?.channels).toBe(1);
  });

  it('marks every packet as needing the one before it, as ffmpeg does', async () => {
    const view = await bytesOf(aacMp4(track(10, 9000), [payload(track(10, 9000).sizes)]));
    const sgpd = find(view, [...STBL, 'sgpd']);
    expect(fourcc(view, sgpd.at + 4)).toBe('roll');
    expect(view.getInt16(sgpd.at + 16)).toBe(-1);
  });
});

describe('aacAdts', () => {
  it('puts a 7-byte header naming the stream in front of every packet', async () => {
    const t = track(3, 2000, [5, 300, 9]);
    const view = await bytesOf(aacAdts(t, payload(t.sizes)));
    expect(view.byteLength).toBe(5 + 300 + 9 + 3 * 7);
    let at = 0;
    for (const size of [5, 300, 9]) {
      expect(view.getUint16(at) & 0xfff6).toBe(0xfff0);
      // Profile LC (1), rate index 4 (44.1 kHz), channel configuration 2.
      expect(view.getUint8(at + 2) >> 6).toBe(1);
      expect((view.getUint8(at + 2) >> 2) & 0x0f).toBe(4);
      expect(((view.getUint8(at + 2) & 1) << 2) | (view.getUint8(at + 3) >> 6)).toBe(2);
      const length = ((view.getUint8(at + 3) & 3) << 11) | (view.getUint8(at + 4) << 3) | (view.getUint8(at + 5) >> 5);
      expect(length).toBe(size + 7);
      at += length;
    }
  });
});

describe('readConfig', () => {
  it('reads an AudioSpecificConfig', () => {
    expect(readConfig(new Uint8Array([0x11, 0x90]))).toEqual({ objectType: 2, rateIndex: 3, channelConfig: 2 });
  });
});
