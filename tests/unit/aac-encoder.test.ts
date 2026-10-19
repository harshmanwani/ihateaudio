import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { AacStream, nearestAacRate, type AacModule } from '../../src/lib/audio/aac-stream';
import { aacMp4 } from '../../src/lib/audio/mp4-write';
import { mp4AudioTrack } from '../../src/lib/audio/mp4';

/*
 * The committed builds of the light AAC encoder, run as they ship. Both are
 * built for a worker, which needs only `self.location` before it starts; the
 * wasm one is handed its bytes rather than fetching them.
 */
const dir = new URL('../../src/lib/audio/aac/', import.meta.url);

type Create = (options: Record<string, unknown>) => Promise<AacModule>;

async function jsBuild(): Promise<AacModule> {
  const { default: create } = (await import(/* @vite-ignore */ new URL('aac-encoder-js.mjs', dir).href)) as { default: Create };
  return create({});
}

async function wasmBuild(): Promise<AacModule> {
  const bytes = readFileSync(fileURLToPath(new URL('aac-encoder.wasm', dir)));
  const { default: create } = (await import(/* @vite-ignore */ new URL('aac-encoder.mjs', dir).href)) as { default: Create };
  return create({
    instantiateWasm: (imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) => {
      void WebAssembly.instantiate(bytes, imports).then((result) => receive(result.instance));
      return {};
    },
  });
}

function sine(seconds: number, rate: number, channels: number): Float32Array[] {
  return Array.from({ length: channels }, (_, c) => {
    const out = new Float32Array(Math.round(seconds * rate));
    for (let i = 0; i < out.length; i += 1) out[i] = 0.5 * Math.sin((2 * Math.PI * (440 + 110 * c) * i) / rate);
    return out;
  });
}

function encode(module: AacModule, planes: Float32Array[], rate: number, kbps: number, piece = 1 << 20) {
  const stream = new AacStream(module, planes.length, rate, kbps * 1000);
  for (let at = 0; at < planes[0]!.length; at += piece) {
    stream.write(planes.map((plane) => plane.subarray(at, at + piece)));
  }
  return stream.end();
}

const joined = (chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
};

let js: AacModule;
let wasm: AacModule;

beforeAll(async () => {
  (globalThis as { self?: unknown }).self ??= { location: { href: pathToFileURL(fileURLToPath(dir)).href } };
  [js, wasm] = await Promise.all([jsBuild(), wasmBuild()]);
});

describe('the light AAC encoder', () => {
  it('writes AAC-LC with the priming and config ffmpeg gives it', () => {
    const encoded = encode(wasm, sine(2, 44100, 2), 44100, 128);
    expect(encoded.priming).toBe(1024);
    expect(encoded.packetFrames).toBe(1024);
    // Object type 2 (LC), rate index 4 (44.1 kHz), two channels.
    expect([...encoded.config.slice(0, 2)]).toEqual([0x12, 0x10]);
    expect(encoded.sizes.length).toBeGreaterThanOrEqual(Math.ceil((2 * 44100 + 1024) / 1024));
    const kbps = (encoded.bytes * 8) / 2 / 1000;
    expect(kbps).toBeGreaterThan(60);
    expect(kbps).toBeLessThan(150);
  });

  it('is the same encoder in both builds, byte for byte', () => {
    const planes = sine(1.5, 48000, 2);
    const a = encode(wasm, planes, 48000, 192);
    const b = encode(js, planes, 48000, 192);
    expect(b.sizes).toEqual(a.sizes);
    expect(joined(b.chunks)).toEqual(joined(a.chunks));
  });

  it('gives the same packets however the audio is cut into pieces', () => {
    const planes = sine(1, 44100, 1);
    const whole = encode(wasm, planes, 44100, 96);
    const pieces = encode(wasm, planes, 44100, 96, 1000);
    expect(pieces.sizes).toEqual(whole.sizes);
    expect(joined(pieces.chunks)).toEqual(joined(whole.chunks));
  });

  it('takes 5.1, which needs the layout with back surrounds', () => {
    const encoded = encode(wasm, sine(0.5, 48000, 6), 48000, 256);
    expect(encoded.sizes.length).toBeGreaterThan(0);
  });

  it('refuses a channel count it has no layout for, which the caller downmixes', () => {
    expect(() => new AacStream(wasm, 7, 48000, 192000)).toThrow(/refused 7 channels/);
  });

  it('makes a file the site reads back as the audio it was given', async () => {
    const planes = sine(3, 44100, 2);
    const encoded = encode(js, planes, 44100, 160);
    const blob = aacMp4(
      {
        sampleRate: 44100,
        channels: 2,
        config: encoded.config,
        priming: encoded.priming,
        frames: planes[0]!.length,
        packetFrames: encoded.packetFrames,
        sizes: encoded.sizes,
      },
      encoded.chunks as BlobPart[]
    );
    const info = mp4AudioTrack(await blob.arrayBuffer());
    expect(info).toMatchObject({ codec: 'mp4a', rate: 44100, channels: 2, bytes: encoded.bytes });
    expect(info?.seconds).toBeCloseTo(3 + 1024 / 44100, 4);
  });
});

describe('nearestAacRate', () => {
  it('moves a rate AAC lacks to the closest it has', () => {
    expect(nearestAacRate(44100)).toBe(44100);
    expect(nearestAacRate(50000)).toBe(48000);
    expect(nearestAacRate(192000)).toBe(96000);
    expect(nearestAacRate(6000)).toBe(8000);
  });
});
