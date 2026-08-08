/**
 * Regression cover for the result player's transport arithmetic.
 *
 * The player schedules every stem a fraction of a second into the future so the
 * sources cannot drift apart. That lead-in is a window in which the context
 * clock has not yet reached the scheduled start, and the position maths has to
 * survive being asked for a time inside it — a stop landing there used to hand
 * the next `start()` a negative offset, which throws and never recovers.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { StemPlayer } from '../../src/lib/ai/stem-player';

/** Every source created through the fake context, in creation order. */
let sources: FakeSource[] = [];

class FakeParam {
  value = 1;
  cancelScheduledValues(): void {}
  setValueAtTime(): void {}
  linearRampToValueAtTime(): void {}
}

class FakeGain {
  gain = new FakeParam();
  connect<T>(node: T): T {
    return node;
  }
  disconnect(): void {}
}

class FakeSource {
  buffer: AudioBuffer | null = null;
  onended: (() => void) | null = null;
  started: { when: number; offset: number } | null = null;

  connect<T>(node: T): T {
    return node;
  }
  disconnect(): void {}

  /** Mirrors the browser: a negative offset is a RangeError, not a clamp. */
  start(when = 0, offset = 0): void {
    if (offset < 0) {
      throw new RangeError(
        `Failed to execute 'start' on 'AudioBufferSourceNode': ` +
          `The offset provided (${offset}) is less than the minimum bound (0).`
      );
    }
    this.started = { when, offset };
  }
  stop(): void {}
}

class FakeContext {
  currentTime = 0;
  state = 'running';
  destination = {};
  createGain(): FakeGain {
    return new FakeGain();
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource();
    sources.push(source);
    return source;
  }
  async resume(): Promise<void> {
    this.state = 'running';
  }
  async close(): Promise<void> {}
}

function stem(seconds: number) {
  const rate = 48000;
  return {
    id: 'result',
    name: 'Result',
    buffer: new AudioBuffer({
      numberOfChannels: 1,
      length: Math.round(rate * seconds),
      sampleRate: rate,
    }),
  };
}

const globals = globalThis as Record<string, unknown>;
let context: FakeContext;

beforeEach(() => {
  sources = [];
  context = new FakeContext();
  globals.AudioContext = function AudioContextShim(this: unknown) {
    return context;
  };
  globals.requestAnimationFrame = (): number => 1;
  globals.cancelAnimationFrame = (): void => {};
});

afterEach(() => {
  delete globals.AudioContext;
  delete globals.requestAnimationFrame;
  delete globals.cancelAnimationFrame;
});

describe('StemPlayer position during the scheduling lead-in', () => {
  it('does not report a negative time when stopped before playback starts', async () => {
    const player = new StemPlayer([stem(2)]);
    await player.play();

    // The clock has not advanced past the scheduled start yet: this is the
    // person hitting play and pause again inside the same tenth of a second.
    player.stop();

    expect(player.state().time).toBeGreaterThanOrEqual(0);
  });

  it('can play again after being stopped inside the lead-in', async () => {
    const player = new StemPlayer([stem(2)]);
    await player.play();
    player.stop();

    await expect(player.play()).resolves.toBeUndefined();
    expect(sources.at(-1)?.started?.offset).toBeGreaterThanOrEqual(0);
  });

  it('holds the seeked position when stopped inside the lead-in', async () => {
    const player = new StemPlayer([stem(10)]);
    player.seek(4);
    await player.play();
    player.stop();

    // Not 3.98: no audio was heard, so the playhead has not moved.
    expect(player.state().time).toBeCloseTo(4, 5);
  });

  it('still advances the position once the clock passes the start', async () => {
    const player = new StemPlayer([stem(10)]);
    await player.play();

    context.currentTime = 1.02;
    expect(player.state().time).toBeCloseTo(1, 5);

    player.stop();
    expect(player.state().time).toBeCloseTo(1, 5);
  });
});
