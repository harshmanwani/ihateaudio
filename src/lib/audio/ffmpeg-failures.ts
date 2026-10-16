/**
 * A short memory of failed ffmpeg core loads, so a device that cannot run it is
 * not made to download it again and again.
 *
 * The core is ~31 MB. When loading it fails, the tool used to forget that it had
 * and let the next click fetch all 31 MB again, which failed the same way: two
 * visitors on older iPhones retried five and eight times in a few minutes, over
 * mobile data, and never got a file. The second failure on a device is already
 * strong evidence that a third will fail too, so after `MAX_LOAD_ATTEMPTS` the
 * load is refused without touching the network.
 *
 * The count lives in sessionStorage as well as in memory so that the advice on
 * the error card, "reload the page", does not quietly reset it. It expires after
 * `FAILURE_WINDOW_MS`, so a flaky connection that has since recovered is not
 * locked out for the life of the tab.
 */

/** Load attempts allowed before the core is declared unusable on this device. */
export const MAX_LOAD_ATTEMPTS = 2;

/** How long a recorded failure counts against the device. */
export const FAILURE_WINDOW_MS = 10 * 60 * 1000;

const KEY = 'ihateaudio:ffmpeg-load-failures';

/** The slice of Storage this needs, so tests can supply their own. */
export interface FailureStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface FailureRecord {
  count: number;
  /** Epoch ms of the most recent failure. */
  at: number;
}

let memory: FailureRecord | null = null;

function defaultStore(): FailureStore | null {
  try {
    // Reading the property itself throws in some privacy modes.
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function readStored(store: FailureStore | null): FailureRecord | null {
  if (!store) return null;
  try {
    const raw = store.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FailureRecord>;
    if (typeof parsed.count !== 'number' || typeof parsed.at !== 'number') return null;
    return { count: parsed.count, at: parsed.at };
  } catch {
    return null;
  }
}

/** Whichever of the in-memory and stored records is worse, if still in date. */
function current(store: FailureStore | null, now: number): FailureRecord | null {
  const stored = readStored(store);
  const candidates = [memory, stored].filter(
    (r): r is FailureRecord => r !== null && now - r.at <= FAILURE_WINDOW_MS
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.count > a.count ? b : a));
}

/** How many loads have failed recently on this device. */
export function recentLoadFailures(
  store: FailureStore | null = defaultStore(),
  now: number = Date.now()
): number {
  return current(store, now)?.count ?? 0;
}

/** True once the core has failed enough times that another try is pointless. */
export function loadGivenUp(
  store: FailureStore | null = defaultStore(),
  now: number = Date.now()
): boolean {
  return recentLoadFailures(store, now) >= MAX_LOAD_ATTEMPTS;
}

/** Records one failed load and returns how many are now on record. */
export function recordLoadFailure(
  store: FailureStore | null = defaultStore(),
  now: number = Date.now()
): number {
  const next: FailureRecord = { count: recentLoadFailures(store, now) + 1, at: now };
  memory = next;
  try {
    store?.setItem(KEY, JSON.stringify(next));
  } catch {
    /* Storage full or blocked: the in-memory count still holds for this page. */
  }
  return next.count;
}

/** A successful load proves the device can run the core, so the slate is wiped. */
export function clearLoadFailures(store: FailureStore | null = defaultStore()): void {
  memory = null;
  try {
    store?.removeItem(KEY);
  } catch {
    /* Nothing useful to do if storage refuses. */
  }
}
