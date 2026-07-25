/**
 * A minimal AudioBuffer for Node.
 *
 * The DSP and analysis layers only ever touch the AudioBuffer *interface* —
 * channel data, length, sampleRate, duration — never the audio graph. Shimming
 * that interface lets the maths be tested directly and deterministically in
 * Node, which is far faster and more precise than driving a real browser. The
 * graph-dependent code (effects.ts, decode, encoders) is covered by the
 * Playwright suite in a real browser instead.
 */

class NodeAudioBuffer {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  private channels: Float32Array[];

  constructor(options: {
    numberOfChannels: number;
    length: number;
    sampleRate: number;
  }) {
    const { numberOfChannels, length, sampleRate } = options;

    if (!Number.isFinite(length) || length < 1) {
      throw new Error('AudioBuffer length must be at least 1');
    }
    if (sampleRate < 3000 || sampleRate > 768000) {
      throw new Error(`AudioBuffer sampleRate out of range: ${sampleRate}`);
    }

    this.numberOfChannels = numberOfChannels;
    this.length = Math.floor(length);
    this.sampleRate = sampleRate;
    this.channels = Array.from(
      { length: numberOfChannels },
      () => new Float32Array(this.length)
    );
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  getChannelData(index: number): Float32Array {
    const data = this.channels[index];
    if (!data) throw new Error(`No channel at index ${index}`);
    return data;
  }

  copyToChannel(source: Float32Array, index: number, offset = 0): void {
    this.channels[index].set(source.subarray(0, this.length - offset), offset);
  }

  copyFromChannel(destination: Float32Array, index: number, offset = 0): void {
    destination.set(
      this.channels[index].subarray(offset, offset + destination.length)
    );
  }
}

const globals = globalThis as Record<string, unknown>;
globals.AudioBuffer = NodeAudioBuffer;
