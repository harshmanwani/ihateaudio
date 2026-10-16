import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AudioError } from '../../src/lib/audio/errors';

/**
 * loadFFmpeg against a core that will not start.
 *
 * HQ task #157: two visitors on old iPhones pressed Download five and eight times
 * in a few minutes, and every press re-fetched the 31 MB core and failed the same
 * way. What matters here is what the *network* sees, so the fake FFmpeg counts how
 * many times a load is actually attempted.
 */
const attempts = { load: 0, construct: 0 };
let loadOutcome: () => Promise<boolean> = () =>
  Promise.reject('Error: failed to import ffmpeg-core.js');

vi.mock('@ffmpeg/ffmpeg', () => ({
  FFmpeg: class {
    loaded = false;
    constructor() {
      attempts.construct += 1;
    }
    async load() {
      attempts.load += 1;
      const ok = await loadOutcome();
      this.loaded = ok;
      return ok;
    }
    terminate() {}
  },
}));

// Imported after the mock is registered, and re-imported per test for a clean module state.
type FfmpegModule = typeof import('../../src/lib/audio/ffmpeg');
let ffmpeg: FfmpegModule;
let failures: typeof import('../../src/lib/audio/ffmpeg-failures');
let errors: typeof import('../../src/lib/audio/errors');

beforeEach(async () => {
  attempts.load = 0;
  attempts.construct = 0;
  loadOutcome = () => Promise.reject('Error: failed to import ffmpeg-core.js');
  vi.stubGlobal('window', { location: { origin: 'https://ihateaudio.test' } });
  vi.resetModules();
  failures = await import('../../src/lib/audio/ffmpeg-failures');
  failures.clearLoadFailures(null);
  ffmpeg = await import('../../src/lib/audio/ffmpeg');
  errors = await import('../../src/lib/audio/errors');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function failure(): Promise<AudioError> {
  try {
    await ffmpeg.loadFFmpeg();
  } catch (err) {
    expect(err).toBeInstanceOf(errors.AudioError);
    return err as AudioError;
  }
  throw new Error('expected loadFFmpeg to reject');
}

describe('loadFFmpeg when the core will not start', () => {
  it('reports where it failed and what kind of failure it was', async () => {
    const err = await failure();
    expect(err.code).toBe('ffmpeg-load-failed');
    expect(err.detail).toMatchObject({
      stage: 'load',
      cause: 'import-failure',
      prewarm: 'skipped',
      attempt: 1,
      gave_up: false,
    });
    // Capability flags are booleans, so they cannot carry content.
    expect(typeof err.detail.wasm).toBe('boolean');
    expect(typeof err.detail.sab).toBe('boolean');
  });

  it('notes when the download itself had already failed', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Load failed')));
    await expect(ffmpeg.loadFFmpeg(() => {})).rejects.toMatchObject({
      detail: { prewarm: 'failed', stage: 'load' },
    });
  });

  it('gives the usual advice on the first failure, since it may only be the network', async () => {
    const err = await failure();
    expect(err.fix).toMatch(/connection/i);
  });

  it('gives up after the second failure and stops downloading', async () => {
    await failure();
    const second = await failure();
    expect(second.detail).toMatchObject({ attempt: 2, gave_up: true });
    expect(second.fix).not.toMatch(/check your connection/i);
    expect(attempts.load).toBe(2);

    // Every press after that is answered without constructing or loading anything.
    for (let i = 0; i < 6; i += 1) {
      const blocked = await failure();
      expect(blocked.code).toBe('ffmpeg-load-failed');
      expect(blocked.detail).toMatchObject({ stage: 'blocked', gave_up: true });
    }
    expect(attempts.load).toBe(2);
    expect(attempts.construct).toBe(2);
  });

  it('lets a later visit try again once the failures have aged out', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_700_000_000_000);
    await failure();
    await failure();
    expect(attempts.load).toBe(2);

    now.mockReturnValue(1_700_000_000_000 + failures.FAILURE_WINDOW_MS + 5_000);
    loadOutcome = () => Promise.resolve(true);
    const ff = await ffmpeg.loadFFmpeg();
    expect(ff.loaded).toBe(true);
    expect(attempts.load).toBe(3);
    now.mockRestore();
  });

  it('forgets earlier failures once a load succeeds', async () => {
    await failure();
    loadOutcome = () => Promise.resolve(true);
    await ffmpeg.loadFFmpeg();
    expect(failures.recentLoadFailures(null)).toBe(0);
  });

  it('shares one attempt between concurrent callers instead of counting two failures', async () => {
    const results = await Promise.allSettled([ffmpeg.loadFFmpeg(), ffmpeg.loadFFmpeg()]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(attempts.load).toBe(1);
    expect(failures.recentLoadFailures(null)).toBe(1);
  });
});
