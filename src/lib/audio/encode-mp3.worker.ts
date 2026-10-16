/**
 * The MP3 encode, off the main thread.
 *
 * lamejs takes about 20 s to encode a 10-minute stereo song at 192 kbps, and
 * on the main thread that was 20 s of tasks near 100 ms each: the page painted
 * a few times a second and input waited. Slicing it finer on the main thread
 * does not work, because one lamejs call is the smallest step that keeps the
 * bytes the same, and one call alone reached 49 ms at 192 kbps and 51 ms at
 * 64. Here the calls hold nothing up, and terminating the worker stops the
 * encode at once.
 *
 * The page sends the file a piece at a time and the next piece after each
 * progress message, so the worker holds two pieces at most rather than a
 * second copy of the whole file.
 */
import { Mp3Encoder } from '@breezystack/lamejs';
import { encodeBlocks } from './mp3-blocks';

export type Mp3Request =
  | { type: 'start'; channels: number; sampleRate: number; bitrate: number }
  | { type: 'piece'; left: Float32Array; right?: Float32Array }
  | { type: 'end' };

export type Mp3Response =
  | { type: 'progress'; samples: number }
  | { type: 'done'; blob: Blob }
  | { type: 'error'; message: string };

function post(message: Mp3Response): void {
  (self as unknown as Worker).postMessage(message);
}

let encoder: Mp3Encoder | null = null;
let parts: Uint8Array[] = [];
let samples = 0;

self.onmessage = (event: MessageEvent<Mp3Request>) => {
  const message = event.data;
  try {
    if (message.type === 'start') {
      encoder = new Mp3Encoder(message.channels, message.sampleRate, message.bitrate);
      parts = [];
      samples = 0;
    } else if (!encoder) {
      throw new Error('No encode was started.');
    } else if (message.type === 'piece') {
      encodeBlocks(encoder, message.left, message.right, parts);
      samples += message.left.length;
      post({ type: 'progress', samples });
    } else {
      const tail = encoder.flush();
      if (tail.length > 0) parts.push(tail);
      const blob = new Blob(parts as BlobPart[], { type: 'audio/mpeg' });
      encoder = null;
      parts = [];
      post({ type: 'done', blob });
    }
  } catch (err) {
    encoder = null;
    parts = [];
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
