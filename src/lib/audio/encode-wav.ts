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
        const s = clampSample(data[c][i]);
        const v = Math.round(s * 8388607);
        view.setUint8(offset, v & 0xff);
        view.setUint8(offset + 1, (v >> 8) & 0xff);
        view.setUint8(offset + 2, (v >> 16) & 0xff);
        offset += 3;
      }
    }
  } else {
    for (let i = 0; i < frames; i += 1) {
      for (let c = 0; c < channels; c += 1) {
        const s = clampSample(data[c][i]);
        // Asymmetric scaling: int16 runs -32768..32767, so the negative side
        // uses a larger multiplier. Using 32767 for both wastes a step and
        // makes full-scale negative peaks measurably quieter.
        view.setInt16(offset, s < 0 ? s * 32768 : s * 32767, true);
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

/** Predicts output size so the export bar can show it before encoding. */
export function wavSize(
  frames: number,
  channels: number,
  bitDepth: WavBitDepth = 16
): number {
  return 44 + frames * channels * (bitDepth / 8);
}
