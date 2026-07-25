/**
 * Speech to text with Whisper, running locally.
 *
 * transformers.js does the heavy lifting — the mel filterbank, the byte-level BPE
 * tokenizer, the encoder-decoder loop with its key-value cache, and the parsing of
 * timestamp tokens back into times. Reimplementing that on top of bare ONNX Runtime
 * was the alternative and it is several hundred lines of well-trodden work with a
 * lot of room for subtle mistakes, particularly around timestamps.
 *
 * What is not delegated is where the model comes from. Left alone, transformers.js
 * fetches weights from huggingface.co, which would mean that opening the
 * transcriber tells a third party you did — on a site whose promise is that nothing
 * leaves your device. So the host is repointed at our own origin, and the whole
 * library is configured to refuse anything else.
 */
import { WHISPER } from './models';
import { ORT_TRANSFORMERS_VERSION } from './ort-version';
import { MODELS_VERSION } from './models';

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

/** The pipeline is expensive to build and safe to keep, so it is built once. */
let pipelinePromise: Promise<unknown> | null = null;

async function getPipeline(
  options: TranscribeOptions
): Promise<(input: Float32Array, config: Record<string, unknown>) => Promise<unknown>> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers');

      // Our origin, not huggingface.co. `remotePathTemplate` is flattened because
      // the default expects a hub-shaped path with a revision in it, and R2 holds
      // the files under a plain directory.
      env.remoteHost = new URL(`/models/${MODELS_VERSION}/`, location.origin).href;
      env.remotePathTemplate = '{model}';
      env.allowLocalModels = false;
      env.allowRemoteModels = true;

      // transformers.js pins its own onnxruntime-web, so this must be that
      // version's binary rather than the one the separation tools use. The glue and
      // the .wasm have to match or it fails inside emscripten talking about a
      // missing export.
      //
      // The wasm backend object is created lazily, so it may not exist yet. Missing
      // it entirely would silently fall back to fetching the binary from a CDN,
      // which is the one outcome this whole arrangement exists to prevent — so it
      // is created rather than skipped.
      const onnx = env.backends.onnx as {
        wasm?: { wasmPaths?: unknown; numThreads?: number };
      };
      onnx.wasm ??= {};
      onnx.wasm.wasmPaths = {
        wasm: `/ort/${ORT_TRANSFORMERS_VERSION}/ort-wasm-simd-threaded.wasm`,
      };
      onnx.wasm.numThreads =
        typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated
          ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1))
          : 1;

      return pipeline('automatic-speech-recognition', WHISPER.dir, {
        // The quantized graphs, which is what the 41 MB figure refers to. The
        // float32 pair is four times the size for a difference that does not
        // survive contact with a phone recording.
        dtype: 'q8',
        device: 'wasm',
        progress_callback: (event: {
          status?: string;
          loaded?: number;
          total?: number;
          progress?: number;
        }) => {
          if (event.status === 'progress' && event.total) {
            options.onStage?.({
              phase: 'downloading',
              ratio: (event.loaded ?? 0) / event.total,
              loaded: event.loaded,
              total: event.total,
            });
          } else if (event.status === 'ready') {
            options.onStage?.({ phase: 'starting', ratio: null });
          }
        },
      });
    })().catch((error: unknown) => {
      // A failed build must not be cached, or every retry resolves to the same
      // rejection for the life of the page.
      pipelinePromise = null;
      throw error;
    });
  }
  return pipelinePromise as Promise<
    (input: Float32Array, config: Record<string, unknown>) => Promise<unknown>
  >;
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
  const run = await getPipeline(options);
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

  const audio = await toWhisperInput(buffer);
  const totalSeconds = buffer.duration;

  options.onStage?.({ phase: 'listening', ratio: null });

  /**
   * Whisper reasons over 30-second windows. Anything longer has to be chunked, and
   * the stride is what stops a word being cut in half at a boundary: the model sees
   * overlapping context on each side and the library stitches the results.
   */
  const output = (await run(audio, {
    chunk_length_s: WHISPER.windowSeconds,
    stride_length_s: 5,
    return_timestamps: options.timestamps ?? false,
  })) as { text?: string; chunks?: RawChunk[] };

  const segments = options.timestamps ? toSegments(output.chunks ?? [], totalSeconds) : [];
  const text = (output.text ?? segments.map((s) => s.text).join(' ')).trim();

  return { text, segments };
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
