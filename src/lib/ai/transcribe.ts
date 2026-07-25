/**
 * Speech to text with Whisper, running locally.
 *
 * transformers.js does the heavy lifting — the mel filterbank, the byte-level BPE
 * tokenizer, the encoder-decoder loop with its key-value cache, and the parsing of
 * timestamp tokens back into times. Reimplementing that on bare ONNX Runtime is
 * several hundred lines of well-trodden work with a lot of room for subtle mistakes,
 * particularly around timestamps.
 *
 * It is driven from a worker in public/workers/ rather than imported here, and that
 * is the whole reason this file was rewritten. Importing the library lets Vite
 * pre-bundle it, after which it spawns its own worker referencing module ids from
 * the main bundle that do not exist in worker scope — surfacing as a missing method
 * with a generated name that changes on every rebuild. Loading it as a static file
 * by URL avoids the bundler entirely.
 *
 * What is not delegated is where the weights come from. Left alone, transformers.js
 * fetches them from huggingface.co, which would mean opening the transcriber tells a
 * third party you did, on a site whose promise is that nothing leaves your device.
 * The worker is handed our own origin and the library is configured to refuse
 * anything else.
 */
import { MODELS_VERSION, WHISPER } from './models';
import { TRANSFORMERS_VERSION } from './transformers-version';

export interface Segment {
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  /** The whole thing as one block, already tidied of leading spaces. */
  text: string;
  /** Timed chunks, for subtitles. Empty when the model returned none. */
  segments: Segment[];
}

export interface TranscribeStage {
  phase: 'downloading' | 'starting' | 'listening';
  ratio: number | null;
  /** Bytes, during the download phase. */
  loaded?: number;
  total?: number;
}

export interface TranscribeOptions {
  onStage?: (stage: TranscribeStage) => void;
  signal?: AbortSignal;
  /** Ask for per-segment times. Costs a little accuracy for a lot of usefulness. */
  timestamps?: boolean;
}

interface WorkerDone {
  type: 'done';
  text: string;
  chunks: { text: string; start: number; end: number | null }[];
}

type WorkerMessage =
  | { type: 'progress'; stage: 'model' | 'listening'; ratio: number; loaded?: number; total?: number }
  | WorkerDone
  | { type: 'error'; message: string };

/**
 * One worker, kept alive across runs.
 *
 * Building the pipeline means parsing 40 MB of ONNX and standing up the runtime, so
 * throwing the worker away after each transcription would make every run after the
 * first as slow as the first.
 */
let worker: Worker | null = null;
let nextId = 1;

function getWorker(): Worker {
  if (!worker) {
    // A plain URL string, not new URL(..., import.meta.url): the second form is
    // exactly what invites Vite to process the file, which is what this whole
    // arrangement exists to avoid.
    worker = new Worker('/workers/whisper.worker.js', { type: 'module' });
  }
  return worker;
}

/** Drops the worker, freeing the model's wasm heap. Used when a run fails. */
function resetWorker(): void {
  worker?.terminate();
  worker = null;
}

/**
 * Whisper wants 16 kHz mono, and that is not a preference.
 *
 * Its mel filterbank is built for 16 kHz, so the frequency each bin represents is
 * fixed by that rate. Feeding 44.1 kHz audio does not fail; it shifts every
 * frequency the model learned by a factor of nearly three, and the transcript comes
 * back as confident nonsense.
 *
 * OfflineAudioContext resamples with a real anti-aliasing filter, which matters
 * here more than usual because this is a large downsample and linear interpolation
 * would fold everything above 8 kHz back into the speech band.
 */
export async function toWhisperInput(buffer: AudioBuffer): Promise<Float32Array> {
  const frames = Math.max(1, Math.round((buffer.length / buffer.sampleRate) * WHISPER.rate));
  const context = new OfflineAudioContext(1, frames, WHISPER.rate);
  const source = context.createBufferSource();

  // Downmix before rendering rather than after, so the resampler sees one channel.
  if (buffer.numberOfChannels > 1) {
    const mono = context.createBuffer(1, buffer.length, buffer.sampleRate);
    const out = mono.getChannelData(0);
    for (let c = 0; c < buffer.numberOfChannels; c += 1) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < data.length; i += 1) out[i] = out[i]! + data[i]! / buffer.numberOfChannels;
    }
    source.buffer = mono;
  } else {
    source.buffer = buffer;
  }

  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return Float32Array.from(rendered.getChannelData(0));
}

interface RawChunk {
  text?: string;
  timestamp?: [number | null, number | null];
}

/**
 * Turns whatever the pipeline returned into segments with usable times.
 *
 * Whisper emits timestamps as tokens, and it does sometimes omit the closing one —
 * usually on the final chunk, sometimes mid-file after a long silence. A null end
 * is therefore expected rather than exceptional, and is filled from the next
 * chunk's start, or from the audio's own length for the last one.
 */
function toSegments(chunks: RawChunk[], totalSeconds: number): Segment[] {
  const segments: Segment[] = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i]!;
    const text = (chunk.text ?? '').trim();
    if (!text) continue;

    const start = chunk.timestamp?.[0] ?? segments.at(-1)?.end ?? 0;
    let end = chunk.timestamp?.[1] ?? null;

    if (end === null) {
      const nextStart = chunks[i + 1]?.timestamp?.[0];
      end = typeof nextStart === 'number' ? nextStart : totalSeconds;
    }

    // A zero-length or reversed cue is invalid in SRT and makes players skip it.
    if (end <= start) end = Math.min(totalSeconds, start + 1.2);

    segments.push({ start, end, text });
  }

  return segments;
}

export async function transcribe(
  buffer: AudioBuffer,
  options: TranscribeOptions = {}
): Promise<Transcript> {
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const audio = await toWhisperInput(buffer);
  const totalSeconds = buffer.duration;
  const id = nextId++;

  options.onStage?.({ phase: 'downloading', ratio: 0 });

  const active = getWorker();

  return new Promise<Transcript>((resolve, reject) => {
    const cleanup = (): void => {
      active.removeEventListener('message', onMessage);
      active.removeEventListener('error', onError);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = (): void => {
      cleanup();
      // Terminating is the point of doing this in a worker: it stops the
      // arithmetic immediately rather than at the next chunk boundary.
      resetWorker();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    const onError = (event: ErrorEvent): void => {
      cleanup();
      resetWorker();
      reject(new Error(event.message || 'The transcriber failed to start.'));
    };

    const onMessage = (event: MessageEvent<WorkerMessage & { id: number }>): void => {
      const message = event.data;
      // One worker serves every run on the page, so anything for another job is
      // not ours to act on.
      if (message.id !== id) return;

      if (message.type === 'progress') {
        if (message.stage === 'model') {
          options.onStage?.({
            phase: 'downloading',
            ratio: message.ratio,
            loaded: message.loaded,
            total: message.total,
          });
        } else {
          options.onStage?.({ phase: 'listening', ratio: message.ratio });
        }
        return;
      }

      cleanup();

      if (message.type === 'error') {
        resetWorker();
        reject(new Error(message.message));
        return;
      }

      const segments = options.timestamps
        ? toSegments(
            message.chunks.map((chunk) => ({
              text: chunk.text,
              timestamp: [chunk.start, chunk.end] as [number | null, number | null],
            })),
            totalSeconds
          )
        : [];
      const text = (message.text || segments.map((s) => s.text).join(' ')).trim();
      resolve({ text, segments });
    };

    active.addEventListener('message', onMessage);
    active.addEventListener('error', onError);
    options.signal?.addEventListener('abort', onAbort, { once: true });

    active.postMessage(
      {
        type: 'transcribe',
        id,
        pcm: audio.buffer,
        modelDir: WHISPER.dir,
        libUrl: `/lib/transformers/${TRANSFORMERS_VERSION}/transformers.min.js`,
        wasmDir: `/lib/transformers/${TRANSFORMERS_VERSION}/`,
        host: new URL(`/models/${MODELS_VERSION}/`, location.origin).href,
        expectedBytes: 40_843_851,
        timestamps: options.timestamps ?? false,
      },
      // The audio is ours and is transferred; a long recording is tens of
      // megabytes and structured-cloning it would briefly need it twice.
      [audio.buffer]
    );
  });
}

/** `HH:MM:SS,mmm`, which is SRT's format and is not negotiable. */
function srtTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(ms, 3)}`;
}

export function toSrt(segments: Segment[]): string {
  return (
    segments
      .map(
        (segment, i) =>
          `${i + 1}\n${srtTime(segment.start)} --> ${srtTime(segment.end)}\n${segment.text}`
      )
      // SRT wants a blank line between cues and a trailing newline at the end.
      .join('\n\n') + '\n'
  );
}

export function toVtt(segments: Segment[]): string {
  const body = segments
    .map(
      (segment) =>
        // WebVTT uses a full stop for the fraction where SRT uses a comma. Players
        // are unforgiving about it.
        `${srtTime(segment.start).replace(',', '.')} --> ${srtTime(segment.end).replace(',', '.')}\n${segment.text}`
    )
    .join('\n\n');
  return `WEBVTT\n\n${body}\n`;
}

/** Plain text with paragraph breaks where the speaker paused for a while. */
export function toParagraphs(segments: Segment[], fallback: string): string {
  if (segments.length === 0) return fallback;

  const paragraphs: string[] = [];
  let current: string[] = [];

  for (let i = 0; i < segments.length; i += 1) {
    current.push(segments[i]!.text);
    const gap = (segments[i + 1]?.start ?? Infinity) - segments[i]!.end;
    // Two seconds of silence is a paragraph in a transcript. Shorter than that is
    // breathing; much longer and the result is one paragraph per sentence.
    if (gap > 2) {
      paragraphs.push(current.join(' '));
      current = [];
    }
  }
  if (current.length) paragraphs.push(current.join(' '));

  return paragraphs.join('\n\n');
}
