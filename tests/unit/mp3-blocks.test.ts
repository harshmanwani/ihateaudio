/**
 * The MP3 encode moved into a worker that gets the file a piece at a time.
 * The bytes must not change with it. lamejs writes different bytes for
 * different call sizes where it resamples (64 and 96 kbps), so these check
 * that pieces of whole blocks make the same calls, and the same file, as the
 * one pass over the whole file that encode-mp3 used to make.
 */
import { describe, expect, it } from 'vitest';
import { Mp3Encoder } from '@breezystack/lamejs';
import { encodeBlocks, MP3_BLOCK, MP3_PIECE, toInt16 } from '../../src/lib/audio/mp3-blocks';

const RATE = 44100;

/** A few seconds of tones and noise, the same on every run. */
function channel(seed: number, length: number): Float32Array {
  const out = new Float32Array(length);
  let state = seed;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const noise = state / 2 ** 32 - 0.5;
    out[i] =
      0.3 * Math.sin((2 * Math.PI * (220 + seed) * i) / RATE) +
      0.2 * Math.sin((2 * Math.PI * 3150 * i) / RATE) +
      0.2 * noise;
  }
  return out;
}

const LENGTH = 3 * MP3_PIECE + 12345;
const LEFT = channel(1, LENGTH);
const RIGHT = channel(2, LENGTH);

function joined(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The loop encode-mp3 ran on the main thread before the worker. */
function onePass(bitrate: number, stereo: boolean): Uint8Array {
  const encoder = new Mp3Encoder(stereo ? 2 : 1, RATE, bitrate);
  const left = toInt16(LEFT);
  const right = stereo ? toInt16(RIGHT) : undefined;
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < left.length; offset += MP3_BLOCK) {
    const end = Math.min(offset + MP3_BLOCK, left.length);
    const chunk = encoder.encodeBuffer(
      left.subarray(offset, end),
      right ? right.subarray(offset, end) : undefined
    );
    if (chunk.length > 0) parts.push(chunk);
  }
  parts.push(encoder.flush());
  return joined(parts);
}

function inPieces(bitrate: number, stereo: boolean, piece: number): Uint8Array {
  const encoder = new Mp3Encoder(stereo ? 2 : 1, RATE, bitrate);
  const parts: Uint8Array[] = [];
  for (let start = 0; start < LENGTH; start += piece) {
    const end = Math.min(start + piece, LENGTH);
    encodeBlocks(encoder, LEFT.slice(start, end), stereo ? RIGHT.slice(start, end) : undefined, parts);
  }
  parts.push(encoder.flush());
  return joined(parts);
}

describe('encodeBlocks', () => {
  it.each([
    [192, true],
    [64, true],
    [96, true],
    [64, false],
  ])('writes the one-pass bytes at %i kbps (stereo %s) from pieces of whole blocks', (bitrate, stereo) => {
    const expected = onePass(bitrate, stereo);
    expect(expected.length).toBeGreaterThan(1000);
    expect(inPieces(bitrate, stereo, MP3_PIECE)).toEqual(expected);
    expect(inPieces(bitrate, stereo, MP3_BLOCK)).toEqual(expected);
  });

  it('writes other bytes at 64 kbps when a piece splits a block', () => {
    // Why the pieces are whole blocks: the check above would pass for any
    // piece size if the call size did not matter.
    expect(inPieces(64, true, MP3_PIECE - 1000)).not.toEqual(onePass(64, true));
  });
});

describe('toInt16', () => {
  it('rounds, clamps, and silences what is not a number', () => {
    const out = toInt16(Float32Array.from([0, 0.5, -0.5, 1, -1, 1.5, -1.5, NaN, Infinity]));
    expect(Array.from(out)).toEqual([0, 16384, -16384, 32767, -32768, 32767, -32768, 0, 0]);
  });
});
