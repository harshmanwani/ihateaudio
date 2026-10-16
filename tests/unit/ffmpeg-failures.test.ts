import { describe, it, expect, beforeEach } from 'vitest';
import {
  FAILURE_WINDOW_MS,
  MAX_LOAD_ATTEMPTS,
  clearLoadFailures,
  loadGivenUp,
  recentLoadFailures,
  recordLoadFailure,
  type FailureStore,
} from '../../src/lib/audio/ffmpeg-failures';

/** A Storage stand-in that can be told to misbehave like Safari's private mode. */
function fakeStore(opts: { throwOnWrite?: boolean } = {}): FailureStore & {
  data: Map<string, string>;
} {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      if (opts.throwOnWrite) throw new DOMException('quota', 'QuotaExceededError');
      data.set(k, v);
    },
    removeItem: (k) => void data.delete(k),
  };
}

const T0 = 1_700_000_000_000;

describe('ffmpeg load failure memory', () => {
  let store: ReturnType<typeof fakeStore>;
  beforeEach(() => {
    store = fakeStore();
    clearLoadFailures(store);
  });

  it('starts with nothing on record', () => {
    expect(recentLoadFailures(store, T0)).toBe(0);
    expect(loadGivenUp(store, T0)).toBe(false);
  });

  it('allows one retry, then gives up', () => {
    expect(MAX_LOAD_ATTEMPTS).toBe(2);
    recordLoadFailure(store, T0);
    expect(loadGivenUp(store, T0)).toBe(false);
    recordLoadFailure(store, T0 + 1000);
    expect(loadGivenUp(store, T0 + 2000)).toBe(true);
  });

  it('survives a page reload, because the count is in session storage', () => {
    recordLoadFailure(store, T0);
    recordLoadFailure(store, T0 + 1000);
    // A reload loses module state; the stored record is what is left.
    const reloaded = fakeStore();
    for (const [k, v] of store.data) reloaded.data.set(k, v);
    clearLoadFailures(null); // wipes memory only, as a reload would
    expect(loadGivenUp(reloaded, T0 + 5000)).toBe(true);
  });

  it('forgives failures once the window has passed', () => {
    recordLoadFailure(store, T0);
    recordLoadFailure(store, T0 + 1000);
    expect(loadGivenUp(store, T0 + FAILURE_WINDOW_MS)).toBe(true);
    expect(loadGivenUp(store, T0 + 1000 + FAILURE_WINDOW_MS + 1)).toBe(false);
    // And the next failure starts a fresh count rather than inheriting the old one.
    expect(recordLoadFailure(store, T0 + 2 * FAILURE_WINDOW_MS)).toBe(1);
  });

  it('is wiped by a successful load', () => {
    recordLoadFailure(store, T0);
    recordLoadFailure(store, T0 + 1000);
    clearLoadFailures(store);
    expect(recentLoadFailures(store, T0 + 2000)).toBe(0);
    expect(store.data.size).toBe(0);
  });

  it('still counts within the page when storage refuses writes', () => {
    const broken = fakeStore({ throwOnWrite: true });
    recordLoadFailure(broken, T0);
    recordLoadFailure(broken, T0 + 1000);
    expect(loadGivenUp(broken, T0 + 2000)).toBe(true);
  });

  it('works with no storage at all', () => {
    clearLoadFailures(null);
    recordLoadFailure(null, T0);
    expect(recentLoadFailures(null, T0)).toBe(1);
    recordLoadFailure(null, T0 + 1);
    expect(loadGivenUp(null, T0 + 2)).toBe(true);
  });

  it('ignores a corrupt stored record', () => {
    store.data.set('ihateaudio:ffmpeg-load-failures', '{not json');
    expect(recentLoadFailures(store, T0)).toBe(0);
    store.data.set('ihateaudio:ffmpeg-load-failures', JSON.stringify({ count: 'many' }));
    expect(recentLoadFailures(store, T0)).toBe(0);
  });
});
