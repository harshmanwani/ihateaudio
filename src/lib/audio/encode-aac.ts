/**
 * M4A, M4R and AAC without the 31 MB ffmpeg core.
 *
 * This is ffmpeg's own AAC encoder, from the release the core is built from,
 * compiled on its own (scripts/aac-encoder/build.sh): about 170 KB gzipped,
 * with no SIMD, plus a plain JavaScript build for browsers whose CSP stops
 * WebAssembly. The export router uses it wherever the core cannot run or has
 * failed to, which is what iPhones on iOS 15 and other older browsers need to
 * make a ringtone at all.
 */
import { audioError } from './errors';
import { resample, setChannels } from './dsp';
import { describeError } from './diagnose';
import { AAC_CHANNELS, nearestAacRate } from './aac-stream';
import type { AacEngine, AacRequest, AacResponse } from './encode-aac.worker';
import glueUrl from './aac/aac-encoder.mjs?url';
import wasmUrl from './aac/aac-encoder.wasm?url';
import jsUrl from './aac/aac-encoder-js.mjs?url';

export type AacContainer = 'mp4' | 'adts';

export interface AacOptions {
  /** kbps, as for the ffmpeg path. */
  bitrate?: number;
  /** 'mp4' for .m4a and .m4r, 'adts' for raw .aac. */
  container?: AacContainer;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

/** Samples per channel sent to the worker at a time: about 1.5 s at 44.1 kHz. */
const PIECE = 1024 * 64;

/** A worker left from the last encode that finished, ready for the next. */
let idle: Worker | null = null;

/** Which build the last encode ran on, for the report. */
let lastEngine: AacEngine | null = null;

export function aacEngine(): AacEngine | null {
  return lastEngine;
}

function spawn(): Worker {
  const worker = new Worker(new URL('./encode-aac.worker.ts', import.meta.url), {
    type: 'module',
  });
  worker.addEventListener('error', () => {
    if (idle === worker) idle = null;
  });
  return worker;
}

function release(worker: Worker): void {
  if (idle) worker.terminate();
  else idle = worker;
}

export async function encodeAac(buffer: AudioBuffer, options: AacOptions = {}): Promise<Blob> {
  const { bitrate = 192, container = 'mp4', onProgress, signal } = options;
  if (signal?.aborted) throw audioError('cancelled');

  // ffmpeg's format negotiation does the same two things for the core:
  // resample to a rate AAC has, and fit the channels to a layout it knows.
  const rate = nearestAacRate(buffer.sampleRate);
  const resampled = rate === buffer.sampleRate ? buffer : resample(buffer, rate);
  const source = AAC_CHANNELS.has(resampled.numberOfChannels) ? resampled : setChannels(resampled, 2);
  const channels = source.numberOfChannels;
  const total = source.length;

  const worker = idle ?? spawn();
  idle = null;

  return new Promise<Blob>((resolve, reject) => {
    let sent = 0;

    const send = (): void => {
      if (sent >= total) return;
      const end = Math.min(sent + PIECE, total);
      const planes: Float32Array[] = [];
      for (let c = 0; c < channels; c += 1) planes.push(source.getChannelData(c).slice(sent, end));
      const message: AacRequest = { type: 'piece', planes };
      worker.postMessage(message, planes.map((plane) => plane.buffer));
      sent = end;
      if (sent >= total) worker.postMessage({ type: 'end' } satisfies AacRequest);
    };

    const finish = (): void => {
      worker.removeEventListener('message', receive);
      worker.removeEventListener('error', failed);
      signal?.removeEventListener('abort', abort);
    };

    const abort = (): void => {
      finish();
      worker.terminate();
      reject(audioError('cancelled'));
    };

    const failed = (event: ErrorEvent): void => {
      event.preventDefault();
      finish();
      worker.terminate();
      reject(
        audioError(
          'encode-failed',
          'The AAC encoder failed to load. Check your connection and press the button again, or choose MP3 instead.',
          { stage: 'aac-worker', ...describeError(event.error ?? event.message) }
        )
      );
    };

    const receive = (event: MessageEvent<AacResponse>): void => {
      const message = event.data;
      if (message.type === 'progress') {
        onProgress?.(message.samples / total);
        send();
      } else if (message.type === 'done') {
        finish();
        release(worker);
        lastEngine = message.engine;
        onProgress?.(1);
        resolve(message.blob);
      } else {
        finish();
        worker.terminate();
        const detail = {
          stage: `aac-${message.stage}`,
          aac_engine: message.engine ?? 'none',
          ...describeError({ name: message.name, message: message.message }),
        };
        reject(
          message.stage === 'load'
            ? audioError(
                'encode-failed',
                'The AAC encoder failed to load. Check your connection and press the button again, or choose MP3 instead.',
                detail
              )
            : audioError('encode-failed', undefined, detail)
        );
      }
    };

    worker.addEventListener('message', receive);
    worker.addEventListener('error', failed);
    signal?.addEventListener('abort', abort, { once: true });

    worker.postMessage({
      type: 'start',
      urls: { glue: glueUrl, wasm: wasmUrl, js: jsUrl },
      channels,
      sampleRate: rate,
      bitRate: bitrate * 1000,
      container,
      frames: total,
    } satisfies AacRequest);
    // Two pieces in flight, so the worker never waits for the next one.
    send();
    send();
  });
}
