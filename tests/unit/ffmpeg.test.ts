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
  /** What each load does, in order: undefined loads, a string is what the worker posts back. */
  const loads: (string | undefined)[] = [];
  const instances: FakeFFmpeg[] = [];
  const running = { now: 0, most: 0 };

  class FakeFFmpeg {
    loaded = false;
    terminated = false;
    execs = 0;
    wasmURL = '';

    constructor() {
      instances.push(this);
    }

    async load(config: { wasmURL: string }): Promise<boolean> {
      this.wasmURL = config.wasmURL;
      const outcome = loads.shift();
      // The library rejects with the string its worker posts, not an Error.
      if (outcome !== undefined) throw outcome;
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

  return { plan, loads, instances, running, FakeFFmpeg };
});

vi.mock('@ffmpeg/ffmpeg', () => ({ FFmpeg: fake.FakeFFmpeg }));
vi.stubGlobal('window', { location: { origin: 'https://ihateaudio.test' } });
// The core's wasm, as far as the loader can tell: it must never reach a network.
const fetchCore = vi.fn(async (..._args: unknown[]) => new Response(new Uint8Array(64)));
vi.stubGlobal('fetch', fetchCore);
// Node has no Worker. One that reads its options says module workers exist.
class ProbeWorker {
  constructor(_url: string, options?: { type?: string }) {
    void options?.type;
    throw new TypeError('not a worker');
  }
}
vi.stubGlobal('Worker', ProbeWorker);

const {
  dropFFmpegCore,
  ffmpegBlocker,
  ffmpegFailed,
  forgetFFmpegFailure,
  loadFFmpeg,
  releaseFFmpeg,
  resetFFmpegSupport,
  transcode,
} = await import('../../src/lib/audio/ffmpeg');

const encode = (onLoadProgress?: (ratio: number) => void): Promise<Blob> =>
  transcode(new Blob([new Uint8Array(8)]), 'in.wav', 'out.ogg', { onLoadProgress });

const execs = (): number[] => fake.instances.map((ff) => ff.execs);

function reset(): void {
  releaseFFmpeg();
  forgetFFmpegFailure();
  dropFFmpegCore();
  resetFFmpegSupport();
  fake.instances.length = 0;
  fake.plan.length = 0;
  fake.loads.length = 0;
  fake.running.most = 0;
  fetchCore.mockClear();
}

describe('the ffmpeg instance', () => {
  beforeEach(reset);

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
    // 0.02 when the load starts, the download, and 1 when it is done, once:
    // the replacement loads from the bytes already here, and saying "loading
    // the converter" every eighth part would be wrong.
    const ratios = progress.mock.calls.map(([ratio]) => ratio as number);
    expect(ratios[0]).toBe(0.02);
    expect(ratios.at(-1)).toBe(1);
    expect(ratios.filter((ratio) => ratio === 1)).toHaveLength(1);
  });

  it('downloads the core once, and replacements load from the same bytes', async () => {
    for (let i = 0; i < 20; i += 1) await encode();
    expect(fake.instances).toHaveLength(3);
    expect(fetchCore).toHaveBeenCalledTimes(1);
    // The worker gets the bytes in hand, not the network URL.
    expect(fake.instances.every((ff) => ff.wasmURL.startsWith('blob:'))).toBe(true);
  });
});

describe('a core that cannot run here', () => {
  beforeEach(reset);

  /*
   * iOS 15 sent ffmpeg-load-failed eight times in five minutes from one person:
   * the core is built with SIMD, Safari compiles SIMD from 16.4, and every
   * press downloaded 31 MB to find that out again.
   */
  it('is refused before anything downloads, with what works instead', async () => {
    const validate = vi.spyOn(WebAssembly, 'validate').mockReturnValue(false);
    try {
      expect(ffmpegBlocker()).toBe('no-simd');
      await expect(encode()).rejects.toMatchObject({
        code: 'ffmpeg-unsupported',
        fix: expect.stringMatching(/MP3 and WAV/),
        detail: expect.objectContaining({ stage: 'support', blocker: 'no-simd' }),
      });
      expect(fetchCore).not.toHaveBeenCalled();
      expect(fake.instances).toHaveLength(0);
    } finally {
      validate.mockRestore();
    }
  });

  it('is refused when the page may not compile WebAssembly at all', () => {
    const compile = vi.spyOn(WebAssembly, 'Module').mockImplementation(() => {
      throw new WebAssembly.CompileError("Refused to create a WebAssembly object because 'unsafe-eval' is not allowed");
    });
    try {
      expect(ffmpegBlocker()).toBe('wasm-blocked');
    } finally {
      compile.mockRestore();
    }
  });

  it('is refused where module workers are not', () => {
    vi.stubGlobal('Worker', class {
      constructor() {
        throw new TypeError('no options read');
      }
    });
    try {
      expect(ffmpegBlocker()).toBe('no-module-worker');
    } finally {
      vi.stubGlobal('Worker', ProbeWorker);
    }
  });
});

describe('a core that fails to load', () => {
  beforeEach(reset);

  it('says which stage failed and how far the download got', async () => {
    fake.loads.push('RuntimeError: Aborted(CompileError: WebAssembly.instantiate(): invalid opcode 253)');
    await expect(loadFFmpeg()).rejects.toMatchObject({
      code: 'ffmpeg-load-failed',
      detail: expect.objectContaining({
        stage: 'load',
        error_name: 'RuntimeError',
        error_message: expect.stringContaining('CompileError'),
        loaded_mb: 0,
        ua_class: expect.any(String),
        device_memory: 'unknown',
      }),
    });
  });

  it('is not downloaded again after the browser refused to compile it', async () => {
    fake.loads.push('RuntimeError: Aborted(CompileError: WebAssembly.instantiate(): invalid opcode 253)');
    await expect(loadFFmpeg()).rejects.toMatchObject({ code: 'ffmpeg-load-failed' });
    for (let i = 0; i < 7; i += 1) {
      await expect(loadFFmpeg()).rejects.toMatchObject({
        code: 'ffmpeg-load-failed',
        detail: expect.objectContaining({ remembered: true }),
      });
    }
    expect(fetchCore).toHaveBeenCalledTimes(1);
    expect(fake.instances).toHaveLength(1);
  });

  it('gets one more try from the bytes already here when the reason may pass', async () => {
    fake.loads.push('TimeoutError: no answer', 'TimeoutError: no answer');
    await expect(loadFFmpeg()).rejects.toMatchObject({
      code: 'ffmpeg-load-failed',
      fix: expect.stringMatching(/will not download again/),
    });
    // The worker that would not start is not left running.
    expect(fake.instances[0]!.terminated).toBe(true);
    await expect(loadFFmpeg()).rejects.toMatchObject({ code: 'ffmpeg-load-failed' });
    await expect(loadFFmpeg()).rejects.toMatchObject({ detail: expect.objectContaining({ remembered: true }) });
    expect(fake.instances).toHaveLength(2);
    expect(fetchCore).toHaveBeenCalledTimes(1);
  });

  it('can be downloaded again after the connection dropped', async () => {
    fetchCore.mockRejectedValueOnce(new TypeError('Load failed'));
    expect(ffmpegFailed()).toBe(false);
    await expect(loadFFmpeg()).rejects.toMatchObject({
      code: 'ffmpeg-load-failed',
      fix: expect.stringMatching(/connection/),
      detail: expect.objectContaining({ stage: 'download', error_name: 'TypeError' }),
    });
    // The light AAC encoder takes M4A and M4R from here on; other formats may retry.
    expect(ffmpegFailed()).toBe(true);
    await expect(loadFFmpeg()).resolves.toBeTruthy();
    expect(fetchCore).toHaveBeenCalledTimes(2);
  });

  it('treats an error page as a failed download, not as the core', async () => {
    fetchCore.mockResolvedValueOnce(new Response('Not found', { status: 404 }));
    await expect(loadFFmpeg()).rejects.toMatchObject({
      detail: expect.objectContaining({ stage: 'download', error_message: 'HTTP 404' }),
    });
    expect(fake.instances.every((ff) => ff.wasmURL === '')).toBe(true);
  });
});
