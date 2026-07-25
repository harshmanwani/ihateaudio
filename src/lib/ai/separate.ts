/**
 * Main-thread side of separation: resample in, run the worker, resample back.
 *
 * The resampling is not incidental. MDX-Net is a 44.1 kHz model family, and the
 * frequency a bin corresponds to is fixed by the transform size and the sample
 * rate together. Feed it 48 kHz audio and every frequency the network learned
 * shifts by 9%, which does not fail — it just separates noticeably worse, for a
 * reason nothing in the output points at.
 */
import { createBuffer } from '../audio/dsp';
import { MDX_RATE, type MdxModel, type Stem } from './models';
import type { SeparateRequest, SeparateResponse } from './separate.worker';
import { loadModel } from './store';
import type { FetchProgress } from './store';

export interface SeparateStage {
  /** What the UI should be saying right now. */
  phase: 'downloading' | 'starting' | 'separating' | 'finishing';
  /** 0..1 within the current phase, or null when it cannot be known. */
  ratio: number | null;
  /** Bytes, for the download phase. */
  bytes?: FetchProgress;
}

export interface SeparateOptions {
  onStage?: (stage: SeparateStage) => void;
  signal?: AbortSignal;
}

export interface SeparateResult {
  primary?: AudioBuffer;
  complement?: AudioBuffer;
}

/**
 * Resamples with the browser's own resampler.
 *
 * `resampleLinear` in dsp.ts exists for the sample-rate converter tool, where the
 * user asked for exactly that and can hear the result. It is the wrong tool here:
 * linear interpolation has no anti-aliasing filter, so downsampling folds
 * everything above the new Nyquist back down into the audible band as inharmonic
 * junk, and that junk is then fed to a network that has never seen anything like
 * it. OfflineAudioContext resamples with a proper polyphase filter.
 */
async function resample(buffer: AudioBuffer, rate: number): Promise<AudioBuffer> {
  if (buffer.sampleRate === rate) return buffer;

  const frames = Math.max(1, Math.round((buffer.length / buffer.sampleRate) * rate));
  const context = new OfflineAudioContext(buffer.numberOfChannels, frames, rate);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  return context.startRendering();
}

/** Deinterleaved stereo, duplicating a mono source into both sides. */
function toStereo(buffer: AudioBuffer): [Float32Array, Float32Array] {
  const left = Float32Array.from(buffer.getChannelData(0));
  const right =
    buffer.numberOfChannels > 1 ? Float32Array.from(buffer.getChannelData(1)) : left.slice();
  return [left, right];
}

function toBuffer(
  channels: [Float32Array, Float32Array],
  rate: number,
  mono: boolean
): AudioBuffer {
  if (mono) {
    // A mono input was duplicated on the way in, so both sides carry the same
    // signal and averaging them back is exact rather than a downmix.
    const out = createBuffer(1, channels[0].length, rate);
    const data = out.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = (channels[0][i]! + channels[1][i]!) * 0.5;
    }
    return out;
  }
  const out = createBuffer(2, channels[0].length, rate);
  out.getChannelData(0).set(channels[0]);
  out.getChannelData(1).set(channels[1]);
  return out;
}

/**
 * Runs one model over one buffer and returns the stems asked for.
 *
 * `want.complement` is the residual, `mix - primary`. It costs nothing extra to
 * compute, which is why the vocal remover and the acapella extractor share a
 * single download.
 */
export async function separate(
  buffer: AudioBuffer,
  model: MdxModel,
  want: { primary: boolean; complement: boolean },
  options: SeparateOptions = {}
): Promise<SeparateResult> {
  const { onStage, signal } = options;

  onStage?.({ phase: 'downloading', ratio: 0 });
  const weights = await loadModel(model, {
    signal,
    onProgress: (bytes) =>
      onStage?.({
        phase: 'downloading',
        ratio: bytes.total ? bytes.loaded / bytes.total : null,
        bytes,
      }),
  });

  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  onStage?.({ phase: 'starting', ratio: null });

  const originalRate = buffer.sampleRate;
  const mono = buffer.numberOfChannels === 1;
  const at441 = await resample(buffer, MDX_RATE);
  const channels = toStereo(at441);

  const worker = new Worker(new URL('./separate.worker.ts', import.meta.url), {
    type: 'module',
  });

  try {
    const stems = await new Promise<{
      primary?: [Float32Array, Float32Array];
      complement?: [Float32Array, Float32Array];
    }>((resolve, reject) => {
      const abort = (): void => {
        // Terminating is the point of doing this in a worker: it stops the
        // arithmetic immediately rather than waiting for the current chunk.
        worker.terminate();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });

      worker.addEventListener('message', (event: MessageEvent<SeparateResponse>) => {
        const message = event.data;
        if (message.type === 'progress') {
          onStage?.({
            phase: 'separating',
            ratio: message.total ? message.done / message.total : null,
          });
        } else if (message.type === 'loaded') {
          onStage?.({ phase: 'separating', ratio: 0 });
        } else if (message.type === 'error') {
          signal?.removeEventListener('abort', abort);
          reject(new Error(message.message));
        } else if (message.type === 'done') {
          signal?.removeEventListener('abort', abort);
          resolve({ primary: message.primary, complement: message.complement });
        }
      });

      worker.addEventListener('error', (event) => {
        signal?.removeEventListener('abort', abort);
        reject(new Error(event.message || 'The AI engine failed to start.'));
      });

      const request: SeparateRequest = { model, weights, channels, want };
      // The weights are deliberately not transferred: store.ts hands out the same
      // ArrayBuffer to every caller, and transferring it would detach the shared
      // copy so the next tool on the page would find 0 bytes. The channels are
      // ours and are transferred.
      worker.postMessage(request, [channels[0].buffer, channels[1].buffer]);
    });

    onStage?.({ phase: 'finishing', ratio: null });

    const result: SeparateResult = {};
    if (stems.primary) {
      result.primary = await restore(stems.primary, originalRate, mono);
    }
    if (stems.complement) {
      result.complement = await restore(stems.complement, originalRate, mono);
    }
    return result;
  } finally {
    worker.terminate();
  }
}

/** Back to the source's own rate and channel count. */
async function restore(
  channels: [Float32Array, Float32Array],
  rate: number,
  mono: boolean
): Promise<AudioBuffer> {
  const at441 = toBuffer(channels, MDX_RATE, mono);
  return rate === MDX_RATE ? at441 : resample(at441, rate);
}

/** Label for a stem, used in filenames and in the results list. */
export function stemLabel(stem: Stem): string {
  switch (stem) {
    case 'instrumental':
      return 'instrumental';
    case 'vocals':
      return 'vocals';
    case 'drums':
      return 'drums';
    case 'bass':
      return 'bass';
    case 'other':
      return 'other';
  }
}
