/**
 * The MP3 encode loop itself, apart from where it runs.
 *
 * encode-mp3 runs it in a worker and hands it the file a piece at a time; the
 * tests run it in Node. Where lamejs's calls fall is part of the output: at 64
 * and 96 kbps LAME lowers the sample rate, and lamejs's resampler writes
 * different bytes for different call sizes. So a piece always starts a whole
 * number of blocks into the file, and the encoder sees the same calls, block
 * for block, as one pass over the whole file makes.
 */
import type { Mp3Encoder } from '@breezystack/lamejs';

/**
 * Samples per lamejs call. 1152 samples is one MPEG frame; multiples keep the
 * encoder on frame boundaries and avoid an extra copy per block.
 */
export const MP3_BLOCK = 1152 * 16;

/** Samples per piece sent to the worker: about 50 ms of encoding at 192 kbps. */
export const MP3_PIECE = MP3_BLOCK * 4;

export function toInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    let s = input[i];
    if (!Number.isFinite(s)) s = 0;
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    // Rounded: assigning into an Int16Array truncates towards zero, which
    // biases every sample half a step towards silence.
    out[i] = Math.round(s < 0 ? s * 32768 : s * 32767);
  }
  return out;
}

/**
 * Encodes one piece and appends the MP3 bytes to `out`. The piece must start
 * on a block boundary of the file; only the last piece may end off one.
 */
export function encodeBlocks(
  encoder: Pick<Mp3Encoder, 'encodeBuffer'>,
  left: Float32Array,
  right: Float32Array | undefined,
  out: Uint8Array[]
): void {
  const l = toInt16(left);
  const r = right ? toInt16(right) : undefined;
  for (let offset = 0; offset < l.length; offset += MP3_BLOCK) {
    const end = Math.min(offset + MP3_BLOCK, l.length);
    const chunk = encoder.encodeBuffer(l.subarray(offset, end), r ? r.subarray(offset, end) : undefined);
    if (chunk.length > 0) out.push(chunk);
  }
}
