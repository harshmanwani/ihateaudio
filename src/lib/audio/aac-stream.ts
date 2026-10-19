/**
 * Drives the light AAC encoder (scripts/aac-encoder/bridge.c) one piece of
 * audio at a time.
 *
 * Kept apart from the worker so the unit tests can run the committed build
 * itself: the wasm2js variant under Node needs nothing a browser has.
 */

/** The parts of the Emscripten module this uses. */
export interface AacModule {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
  _aac_open(channels: number, sampleRate: number, bitRate: number): number;
  _aac_frame_size(encoder: number): number;
  _aac_priming(encoder: number): number;
  _aac_config(encoder: number): number;
  _aac_config_size(encoder: number): number;
  _aac_plane(encoder: number, channel: number): number;
  _aac_encode(encoder: number, samples: number): number;
  _aac_flush(encoder: number): number;
  _aac_output(encoder: number): number;
  _aac_output_size(encoder: number): number;
  _aac_sizes(encoder: number): number;
  _aac_count(encoder: number): number;
  _aac_take(encoder: number): void;
  _aac_close(encoder: number): void;
}

export interface AacEncoded {
  config: Uint8Array;
  priming: number;
  packetFrames: number;
  sizes: number[];
  /** The packets back to back, in pieces as they came out. */
  chunks: Uint8Array[];
  /** Total bytes across `chunks`. */
  bytes: number;
}

/** Sample rates AAC can carry. */
export const AAC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000,
];

/** The AAC rate closest to `rate`, which ffmpeg's own format negotiation also picks. */
export function nearestAacRate(rate: number): number {
  return AAC_RATES.reduce((best, candidate) =>
    Math.abs(candidate - rate) < Math.abs(best - rate) ? candidate : best
  );
}

/** Channel counts the encoder has a layout for. Others are downmixed first. */
export const AAC_CHANNELS = new Set([1, 2, 3, 4, 5, 6, 8]);

export class AacStream {
  private readonly module: AacModule;
  private readonly encoder: number;
  private readonly channels: number;
  readonly frameSize: number;
  /** Samples written into the encoder's planes and not yet encoded. */
  private pending = 0;
  private readonly sizes: number[] = [];
  private readonly chunks: Uint8Array[] = [];
  private bytes = 0;
  private closed = false;

  constructor(module: AacModule, channels: number, sampleRate: number, bitRate: number) {
    this.module = module;
    this.encoder = module._aac_open(channels, sampleRate, bitRate);
    if (!this.encoder) {
      throw new Error(`The AAC encoder refused ${channels} channels at ${sampleRate} Hz.`);
    }
    this.channels = channels;
    this.frameSize = module._aac_frame_size(this.encoder);
  }

  /** Encodes planar samples, one array per channel, all the same length. */
  write(planes: Float32Array[]): void {
    const length = planes[0]?.length ?? 0;
    let read = 0;
    while (read < length) {
      const take = Math.min(this.frameSize - this.pending, length - read);
      for (let c = 0; c < this.channels; c += 1) {
        // Asked for again each frame: making the frame writable can move it,
        // and growing memory replaces HEAPF32.
        const plane = this.plane(c);
        plane.set(planes[c]!.subarray(read, read + take), this.pending);
      }
      this.pending += take;
      read += take;
      if (this.pending === this.frameSize) this.encode(this.frameSize);
    }
    this.collect();
  }

  /** Encodes what is left, flushes the encoder and frees it. */
  end(): AacEncoded {
    if (this.pending > 0) this.encode(this.pending);
    const flushed = this.module._aac_flush(this.encoder);
    if (flushed < 0) throw new Error(`The AAC encoder failed to flush (${flushed}).`);
    this.collect();

    const { module, encoder } = this;
    const at = module._aac_config(encoder);
    const config = module.HEAPU8.slice(at, at + module._aac_config_size(encoder));
    const priming = module._aac_priming(encoder);
    this.close();
    return {
      config,
      priming,
      packetFrames: this.frameSize,
      sizes: this.sizes,
      chunks: this.chunks,
      bytes: this.bytes,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.module._aac_close(this.encoder);
  }

  private plane(channel: number): Float32Array {
    // Only channel 0 makes the frame writable, so it has to be asked first.
    const pointer = this.module._aac_plane(this.encoder, channel);
    if (!pointer) throw new Error('The AAC encoder could not take more audio.');
    const start = pointer >> 2;
    return this.module.HEAPF32.subarray(start, start + this.frameSize);
  }

  private encode(samples: number): void {
    const result = this.module._aac_encode(this.encoder, samples);
    if (result < 0) throw new Error(`The AAC encoder failed (${result}).`);
    this.pending = 0;
  }

  private collect(): void {
    const { module, encoder } = this;
    const size = module._aac_output_size(encoder);
    if (size === 0) return;
    const out = module._aac_output(encoder);
    this.chunks.push(module.HEAPU8.slice(out, out + size));
    this.bytes += size;
    const count = module._aac_count(encoder);
    const sizes = module._aac_sizes(encoder) >> 2;
    for (let i = 0; i < count; i += 1) this.sizes.push(module.HEAP32[sizes + i]!);
    module._aac_take(encoder);
  }
}
