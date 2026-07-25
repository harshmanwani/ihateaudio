/**
 * Separation, off the main thread.
 *
 * This has to be a worker. Separating a four-minute track is minutes of solid
 * arithmetic, and on the main thread that is minutes of a frozen page: no
 * scrolling, no cancel button, no progress bar repainting, and on mobile a browser
 * that may decide the tab has hung and kill it. The worker also gives the cancel
 * button something real to do, since terminating a worker actually stops the work
 * rather than politely asking it to notice a flag.
 */
import { demix, geometry, residual } from './mdx';
import type { MdxModel } from './models';
import { createSession } from './runtime';

export interface SeparateRequest {
  /** Model to run, passed whole so the worker needs no catalogue of its own. */
  model: MdxModel;
  /** Weights, already downloaded, verified and cached by the main thread. */
  weights: ArrayBuffer;
  /** Deinterleaved 44.1 kHz stereo. */
  channels: [Float32Array, Float32Array];
  /** Which stems to send back. Computing only what is wanted halves the copying. */
  want: { primary: boolean; complement: boolean };
}

export type SeparateResponse =
  | { type: 'progress'; done: number; total: number }
  | { type: 'loaded' }
  | { type: 'done'; primary?: [Float32Array, Float32Array]; complement?: [Float32Array, Float32Array] }
  | { type: 'error'; message: string };

function post(message: SeparateResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}

/** Human-readable reason, since the raw runtime errors are not usable as UI. */
function explain(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  // The two failures worth naming specifically, because both have a real cause a
  // visitor can act on and neither says so on its own.
  if (/out of memory|Aborted\(\)|memory access out of bounds/i.test(message)) {
    return (
      'Ran out of memory partway through. This track is long enough that the ' +
      'browser could not hold it all — try a shorter section, or close other tabs.'
    );
  }
  if (/no available backend|wasm|WebAssembly/i.test(message)) {
    return (
      'The AI engine could not start in this browser. It needs WebAssembly, ' +
      'which every current browser has, so this is usually an extension blocking it.'
    );
  }
  return message || 'Separation failed.';
}

self.addEventListener('message', async (event: MessageEvent<SeparateRequest>) => {
  const { model, weights, channels, want } = event.data;
  let session: Awaited<ReturnType<typeof createSession>> | null = null;

  try {
    session = await createSession(weights);
    post({ type: 'loaded' });

    const { frames } = geometry(model);
    const dims = [1, 4, model.dimF, frames] as const;

    const primary = await demix(channels, model, (input) => session!.run(input, dims), {
      onProgress: ({ done, total }) => post({ type: 'progress', done, total }),
    });

    const message: SeparateResponse = { type: 'done' };
    const transfer: Transferable[] = [];

    if (want.primary) {
      message.primary = primary;
      transfer.push(primary[0].buffer, primary[1].buffer);
    }
    if (want.complement) {
      const other = residual(channels, primary);
      message.complement = other;
      transfer.push(other[0].buffer, other[1].buffer);
    }

    // Transferring rather than copying: two stereo Float32Arrays of a four-minute
    // track are about 170 MB, and structured-cloning that would briefly need it
    // twice over.
    post(message, transfer);
  } catch (error) {
    post({ type: 'error', message: explain(error) });
  } finally {
    await session?.release().catch(() => {});
  }
});
