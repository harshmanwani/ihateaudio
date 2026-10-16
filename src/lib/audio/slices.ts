/**
 * Whole-file analysis, a slice at a time.
 *
 * Measuring loudness on a 10-minute song is about 3.5 s of arithmetic, and done
 * in one go it froze the page for all of it: no paint, no scrolling, no input.
 * The analyses that need a pass over every sample are written as generators
 * instead. Each `yield` is a point where the work can stop, and the number it
 * yields is the share done so far.
 *
 * `runAll` drives one to the end without stopping, which is the plain
 * synchronous call. `runSliced` stops whenever its time budget is spent, lets
 * the browser take input and paint, and carries on. Both run the same code in
 * the same order, so the result is the same, value for value.
 */

/** Work that may pause at each `yield`. The yielded number is progress, 0..1. */
export type Steps<T> = Generator<number, T, void>;

/** Runs the steps to the end in one go. */
export function runAll<T>(steps: Steps<T>): T {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/**
 * How long one slice may hold the main thread. Short enough that a frame,
 * paint included, stays well under the 50 ms the browser counts as long.
 */
export const SLICE_MS = 12;

/**
 * Ends the current task, so the browser can take input and paint before the
 * next slice.
 *
 * A message to itself, rather than scheduler.yield or a zero timeout. Chrome
 * runs a scheduler.yield continuation ahead of rendering, so a long analysis
 * that yielded that way still painted only every 108 ms, when the renderer
 * forced its way in. A zero timeout is clamped to 4 ms after a few nested
 * calls, which made the same analysis 40% slower, and is throttled in a
 * background tab. A message is neither, and the page paints every frame.
 */
export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export interface SliceOptions {
  /** Stops the work at the next pause. The promise rejects with the reason. */
  signal?: AbortSignal;
  /** Called after each slice with the share done, 0..1. */
  onProgress?: (ratio: number) => void;
  /** Time per slice. Defaults to SLICE_MS; 0 pauses at every yield. */
  sliceMs?: number;
}

function aborted(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The analysis was cancelled.', 'AbortError');
}

/**
 * Runs the steps a slice at a time, yielding to the browser between slices.
 * The clock is read at each `yield`, which the analyses place a few
 * milliseconds of work apart.
 */
export async function runSliced<T>(steps: Steps<T>, options: SliceOptions = {}): Promise<T> {
  const { signal, onProgress, sliceMs = SLICE_MS } = options;
  if (signal?.aborted) throw aborted(signal);

  let ratio = 0;
  for (;;) {
    const until = performance.now() + sliceMs;
    do {
      const next = steps.next();
      if (next.done) {
        onProgress?.(1);
        return next.value;
      }
      ratio = next.value;
    } while (performance.now() < until);

    onProgress?.(ratio);
    await yieldToMain();
    if (signal?.aborted) {
      steps.return(undefined as T);
      throw aborted(signal);
    }
  }
}
