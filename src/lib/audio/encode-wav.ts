/**
 * WAV writer. Tier 0 — no download, no dependency, works on every browser.
 *
 * This is the fallback that must never fail: when a codec is unavailable or an
 * encoder errors, the user still gets their audio out.
 */
import { audioError } from './errors';

export type WavBitDepth = 16 | 24 | 32;

export interface WavOptions {
  /** 32 writes IEEE float, which is lossless for what the engine holds. */
  bitDepth?: WavBitDepth;
}

/** Encodes an AudioBuffer as a RIFF/WAVE blob. */
export function encodeWav(buffer: AudioBuffer, options: WavOptions = {}): Blob {
  const { bitDepth = 16 } = options;
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const sampleRate = buffer.sampleRate;
  const isFloat = bitDepth === 32;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataBytes = frames * blockAlign;

  // 4 GB is the hard RIFF ceiling — sizes are unsigned 32-bit.
  if (dataBytes > 0xfffffff0) {
    throw audioError(
      'too-large',
      'WAV files cannot exceed 4 GB. Export as MP3, or split the file first.'
    );
  }

  const headerBytes = 44;
  const out = new ArrayBuffer(headerBytes + dataBytes);
  const view = new DataView(out);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');

  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, isFloat ? 3 : 1, true); // 3 = IEEE float, 1 = PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);

  // Pull channel references once; getChannelData is not free inside a hot loop.
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c += 1) data.push(buffer.getChannelData(c));

  let offset = headerBytes;

  if (isFloat) {
    for (let i = 0; i < frames; i += 1) {
      for (let c = 0; c < channels; c += 1) {
        view.setFloat32(offset, data[c][i], true);
        offset += 4;
      }
    }
  } else if (bitDepth === 24) {
    for (let i = 0; i < frames; i += 1) {
      for (let c = 0; c < channels; c += 1) {
        const v = toInt24(clampSample(data[c][i]));
        view.setUint8(offset, v & 0xff);
        view.setUint8(offset + 1, (v >> 8) & 0xff);
        view.setUint8(offset + 2, (v >> 16) & 0xff);
        offset += 3;
      }
    }
  } else {
    for (let i = 0; i < frames; i += 1) {
      for (let c = 0; c < channels; c += 1) {
        view.setInt16(offset, toInt16(clampSample(data[c][i])), true);
        offset += 2;
      }
    }
  }

  return new Blob([out], { type: 'audio/wav' });
}

function clampSample(value: number): number {
  if (value > 1) return 1;
  if (value < -1) return -1;
  return Number.isFinite(value) ? value : 0;
}

/**
 * Float to int16, chosen so a 16-bit file survives decode and re-encode
 * bit for bit. That is what lets a trimmed 16-bit WAV, or a FLAC made from
 * one, honestly be called lossless.
 *
 * Rounding rather than truncating is most of it. DataView.setInt16 truncates
 * towards zero, and a decoded sample is rarely the exact integer it came
 * from, so truncation changed a quarter to a half of all samples by one step
 * and biased the whole file half a step towards silence.
 *
 * The rest is the scale, because browsers disagree on it. Chrome decodes a
 * positive int16 by multiplying it by the float32 nearest 1 / 32767, and a
 * negative one by 1 / 32768 (both checked against decodeAudioData for all
 * 65,536 values); Firefox and Safari divide both by 32768. A negative sample
 * is k / 32768 everywhere, so it scales straight back. A positive one is tried
 * as Chrome's reading first and kept if that reproduces the float exactly;
 * anything else is scaled by 32768 like the negative side, which is also the
 * right reading for audio that never came from an int16 at all. In the top 64
 * steps below full scale the two conventions land on the same float32 and
 * cannot be told apart, and there Chrome's reading wins, so a Firefox decode
 * of a sample that close to clipping can come back one step low.
 */
export function toInt16(sample: number): number {
  if (sample < 0) return Math.max(-32768, Math.round(sample * 32768));
  const chrome = Math.round(sample * 32767);
  if (fromChrome(chrome) === sample) return chrome;
  return Math.min(32767, Math.round(sample * 32768));
}

const INVERSE_32767 = Math.fround(1 / 32767);

/** A positive int16 as Chrome decodes it: a float32 multiply, not a division. */
function fromChrome(k: number): number {
  return Math.fround(k * INVERSE_32767);
}

/**
 * Float to int24. One scale serves every browser here: Chrome widens 24-bit
 * PCM to 32 bits before converting, and the result rounds to the same float32
 * as k / 8388608, which is what everyone else produces.
 */
function toInt24(sample: number): number {
  return Math.max(-8388608, Math.min(8388607, Math.round(sample * 8388608)));
}

/**
 * True when every sample is exactly a value a 16-bit file could have decoded
 * to, i.e. writing it at 16 bits loses nothing.
 *
 * Reads a strided subset, capped at `limit` samples, because the answer is
 * almost never close: a 24-bit recording or a processed signal fails within
 * the first few samples, and a 16-bit source passes everywhere. Silence passes
 * too, which is correct, since zeros fit in any bit depth.
 */
export function fitsIn16Bits(buffer: AudioBuffer, limit = 1_000_000): boolean {
  const total = buffer.length * buffer.numberOfChannels;
  const stride = Math.max(1, Math.floor(total / limit));
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const data = buffer.getChannelData(c);
    for (let i = c % stride; i < data.length; i += stride) {
      const s = data[i]!;
      if (s === 0) continue;
      const k = toInt16(clampSample(s));
      if (Math.fround(k / 32768) !== s && fromChrome(k) !== s) return false;
    }
  }
  return true;
}

/** Predicts output size so the export bar can show it before encoding. */
export function wavSize(
  frames: number,
  channels: number,
  bitDepth: WavBitDepth = 16
): number {
  return 44 + frames * channels * (bitDepth / 8);
}
