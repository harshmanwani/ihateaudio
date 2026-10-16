/**
 * MP3 writer. Tier 1 — ~110 KB, loaded on demand.
 *
 * This covers the single most common journey on the site (MP3 in, MP3 out) at
 * a fraction of a percent of ffmpeg's weight, which is the whole reason the
 * trimmer feels instant while competitors spin.
 */
import { audioError } from './errors';
import { resample, setChannels } from './dsp';
import { MP3_PIECE } from './mp3-blocks';
import type { Mp3Request, Mp3Response } from './encode-mp3.worker';

/** Sample rates the MP3 format permits. Anything else must be resampled. */
const MP3_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

export const MP3_BITRATES = [64, 96, 128, 160, 192, 256, 320] as const;
export type Mp3Bitrate = (typeof MP3_BITRATES)[number];

export interface Mp3Options {
  bitrate?: Mp3Bitrate;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

export function nearestMp3Rate(rate: number): number {
  return MP3_RATES.reduce((best, candidate) =>
    Math.abs(candidate - rate) < Math.abs(best - rate) ? candidate : best
  );
}

/** A worker left from the last encode that finished, ready for the next. */
let idle: Worker | null = null;

function spawn(): Worker {
  const worker = new Worker(new URL('./encode-mp3.worker.ts', import.meta.url), {
    type: 'module',
  });
  // A worker that fails to load while it waits must not be handed out: its
  // error event has already fired, and the encode would wait for ever.
  worker.addEventListener('error', () => {
    if (idle === worker) idle = null;
  });
  return worker;
}

function release(worker: Worker): void {
  if (idle) worker.terminate();
  else idle = worker;
}

/** Warms the encoder while the user is still choosing settings. */
export function preloadMp3Encoder(): void {
  if (!idle && typeof Worker !== 'undefined') idle = spawn();
}

/**
 * Encodes in a worker (see encode-mp3.worker.ts). This side only copies the
 * samples across, a piece at a time, as the worker asks for them.
 */
export async function encodeMp3(
  buffer: AudioBuffer,
  options: Mp3Options = {}
): Promise<Blob> {
  const { bitrate = 192, onProgress, signal } = options;
  if (signal?.aborted) throw audioError('cancelled');

  // MP3 only permits certain rates; resample rather than fail.
  const targetRate = nearestMp3Rate(buffer.sampleRate);
  const resampled = targetRate === buffer.sampleRate ? buffer : resample(buffer, targetRate);

  // lamejs handles mono and stereo. Wider is folded to stereo by the speaker
  // downmix: taking the first two channels of a 5.1 film track left out the
  // centre, which is where the dialogue is.
  const source = resampled.numberOfChannels > 2 ? setChannels(resampled, 2) : resampled;
  const channels = source.numberOfChannels;
  const total = source.length;

  const worker = idle ?? spawn();
  idle = null;

  return new Promise<Blob>((resolve, reject) => {
    let sent = 0;

    const send = (): void => {
      if (sent >= total) return;
      const end = Math.min(sent + MP3_PIECE, total);
      const left = source.getChannelData(0).slice(sent, end);
      const right = channels > 1 ? source.getChannelData(1).slice(sent, end) : undefined;
      const message: Mp3Request = { type: 'piece', left, right };
      worker.postMessage(message, right ? [left.buffer, right.buffer] : [left.buffer]);
      sent = end;
      if (sent >= total) worker.postMessage({ type: 'end' } satisfies Mp3Request);
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
          'The MP3 encoder failed to load. Check your connection and reload, or export as WAV instead.'
        )
      );
    };

    const receive = (event: MessageEvent<Mp3Response>): void => {
      const message = event.data;
      if (message.type === 'progress') {
        onProgress?.(message.samples / total);
        send();
      } else if (message.type === 'done') {
        finish();
        release(worker);
        onProgress?.(1);
        resolve(message.blob);
      } else {
        finish();
        worker.terminate();
        reject(audioError('encode-failed'));
      }
    };

    worker.addEventListener('message', receive);
    worker.addEventListener('error', failed);
    signal?.addEventListener('abort', abort, { once: true });

    worker.postMessage({
      type: 'start',
      channels,
      sampleRate: targetRate,
      bitrate,
    } satisfies Mp3Request);
    // Two pieces in flight, so the worker never waits for the next one.
    send();
    send();
  });
}

/** Predicted MP3 size in bytes — constant bitrate plus a small tag allowance. */
export function mp3Size(seconds: number, bitrate: number): number {
  return Math.round((bitrate * 1000 * seconds) / 8) + 512;
}
