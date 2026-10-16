import { describe, it, expect, beforeEach, vi } from 'vitest';

/*
 * ffmpeg.wasm cannot run under Node. What matters here is the instance's
 * lifecycle: how many runs one gets, and what happens after a trap. Each exec
 * takes its outcome from `plan` (an exit code, or 'trap' for the wasm throwing),
 * and exits 0 once the plan is empty.
 */
const fake = vi.hoisted(() => {
  type Outcome = number | 'trap';
  const plan: Outcome[] = [];
  const instances: FakeFFmpeg[] = [];
  const running = { now: 0, most: 0 };

  class FakeFFmpeg {
    loaded = false;
    terminated = false;
    execs = 0;

    constructor() {
      instances.push(this);
    }

    async load(): Promise<boolean> {
      this.loaded = true;
      return true;
    }

    async writeFile(): Promise<boolean> {
      this.alive();
      return true;
    }

    async readFile(): Promise<Uint8Array> {
      this.alive();
      return new Uint8Array([1, 2, 3]);
    }

    async deleteFile(): Promise<boolean> {
      this.alive();
      return true;
    }

    async exec(): Promise<number> {
      this.alive();
      this.execs += 1;
      running.now += 1;
      running.most = Math.max(running.most, running.now);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running.now -= 1;
      const outcome = plan.shift() ?? 0;
      if (outcome === 'trap') throw 'RuntimeError: memory access out of bounds';
      return outcome;
    }

    on(): void {}
    off(): void {}

    terminate(): void {
      this.terminated = true;
      this.loaded = false;
    }

    private alive(): void {
      if (this.terminated) throw new Error('called FFmpeg.terminate()');
    }
  }

  return { plan, instances, running, FakeFFmpeg };
});

vi.mock('@ffmpeg/ffmpeg', () => ({ FFmpeg: fake.FakeFFmpeg }));
vi.stubGlobal('window', { location: { origin: 'https://ihateaudio.test' } });
// The load-progress prewarm fetches the wasm; it must never reach a network.
vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })));

const { releaseFFmpeg, transcode } = await import('../../src/lib/audio/ffmpeg');

const encode = (onLoadProgress?: (ratio: number) => void): Promise<Blob> =>
  transcode(new Blob([new Uint8Array(8)]), 'in.wav', 'out.ogg', { onLoadProgress });

const execs = (): number[] => fake.instances.map((ff) => ff.execs);

describe('the ffmpeg instance', () => {
  beforeEach(() => {
    releaseFFmpeg();
    fake.instances.length = 0;
    fake.plan.length = 0;
    fake.running.most = 0;
  });

  it('is replaced every 8 runs, before the stack each run loses can trap', async () => {
    // 224 bytes of a 64 KB stack go with every run; mono Opus at 32k trapped on
    // the 19th run of one instance, low-bitrate Vorbis on the 36th.
    for (let i = 0; i < 20; i += 1) await encode();
    expect(execs()).toEqual([8, 8, 4]);
    expect(fake.instances.map((ff) => ff.terminated)).toEqual([true, true, false]);
  });

  it('retries a trap on a used instance once, on a fresh one', async () => {
    fake.plan.push(0, 'trap');
    await encode();
    await expect(encode()).resolves.toBeInstanceOf(Blob);
    expect(execs()).toEqual([2, 1]);
    expect(fake.instances[0]!.terminated).toBe(true);
  });

  it('does not retry a trap on a fresh instance, because the encode itself traps', async () => {
    fake.plan.push('trap');
    await expect(encode()).rejects.toMatchObject({ code: 'encode-failed' });
    expect(execs()).toEqual([1]);
    expect(fake.instances[0]!.terminated).toBe(true);

    // The export after it still gets a clean instance.
    await encode();
    expect(execs()).toEqual([1, 1]);
  });

  it('gives up when the retry traps as well', async () => {
    fake.plan.push(0, 'trap', 'trap');
    await encode();
    await expect(encode()).rejects.toMatchObject({ code: 'encode-failed' });
    expect(execs()).toEqual([2, 1]);
  });

  it('drops the instance after ffmpeg exits with an error, which costs 4.7 KB of stack', async () => {
    fake.plan.push(1);
    await expect(encode()).rejects.toMatchObject({ code: 'encode-failed' });
    expect(fake.instances[0]!.terminated).toBe(true);
    await encode();
    expect(execs()).toEqual([1, 1]);
  });

  it('runs one encode at a time, so an instance is never replaced under a running one', async () => {
    await Promise.all(Array.from({ length: 12 }, () => encode()));
    expect(fake.running.most).toBe(1);
    expect(execs()).toEqual([8, 4]);
  });

  it('reports load progress for the first load only', async () => {
    const progress = vi.fn();
    for (let i = 0; i < 9; i += 1) await encode(progress);
    expect(fake.instances).toHaveLength(2);
    // 0.02 when the load starts and 1 when it is done, once: the replacement
    // loads from the HTTP cache in about 50 ms, and saying "loading the
    // converter" every eighth part would be wrong.
    expect(progress.mock.calls).toEqual([[0.02], [1]]);
  });
});
