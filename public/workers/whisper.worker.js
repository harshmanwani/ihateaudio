/**
 * Whisper transcription, in a worker the bundler never touches.
 *
 * This file lives in public/ on purpose. Letting Vite pre-bundle transformers.js
 * makes the library spawn its own worker referencing module ids that belong to the
 * main bundle and do not exist in worker scope; what surfaces is a missing method
 * deep inside the bundle, with a generated name that changes on every rebuild, and
 * nothing about it points at bundling. Served statically and imported by URL, the
 * library resolves against real files and the problem does not arise.
 *
 * Being in a worker also matters on its own account: transcription is a minute of
 * solid arithmetic on a long recording, and on the main thread that is a minute of
 * frozen page with no progress bar and no cancel.
 *
 * Protocol, all messages carrying the job id:
 *   in : { type: 'transcribe', id, pcm, modelDir, libUrl, wasmUrl, host, timestamps }
 *   out: { type: 'progress', id, stage: 'model' | 'listening', ratio, loaded?, total? }
 *   out: { type: 'done', id, text, chunks }
 *   out: { type: 'error', id, message }
 */

let pipelinePromise = null;
let loadedFor = null;

/**
 * Builds the pipeline, importing the library by the URL the page supplied.
 *
 * Dynamic import rather than a static one so the version lives in a single place —
 * the generated constant the page reads — instead of being hard-coded here where it
 * would silently rot.
 */
async function getPipeline(config, onProgress) {
  const key = `${config.libUrl}|${config.modelDir}`;
  if (pipelinePromise && loadedFor === key) return pipelinePromise;

  loadedFor = key;
  pipelinePromise = (async () => {
    const { pipeline, env } = await import(config.libUrl);

    // Our own origin, never huggingface.co. The privacy page says no third party
    // learns which tool you opened, and that has to cover the weights too.
    env.remoteHost = config.host;
    env.remotePathTemplate = '{model}';
    env.allowLocalModels = false;
    env.allowRemoteModels = true;

    const wasm = env.backends.onnx.wasm;
    // A directory, not a single file: this version picks its runtime binary by
    // capability at load time, choosing the SIMD build where available and the
    // plain one otherwise, so both sit alongside the library.
    wasm.wasmPaths = config.wasmDir;
    // Already off the UI thread, so there is nothing to gain from the runtime
    // spawning further workers, and the threaded build needs helper files the dist
    // bundle does not ship.
    wasm.numThreads = 1;
    wasm.proxy = false;

    /**
     * transformers.js reports progress per file, and each new file restarts at
     * zero. Reporting that directly makes the bar rewind several times, so bytes
     * are aggregated across files instead.
     *
     * Aggregating alone is not enough: files are discovered progressively, so early
     * on the denominator is one small config file and the bar reads 100% while
     * forty megabytes are still to come. A high-water mark stops it going backwards
     * once the real total appears.
     */
    const perFile = new Map();
    let highWater = 0;

    return pipeline('automatic-speech-recognition', config.modelDir, {
      // This version selects the quantized graphs with a boolean rather than the
      // dtype string later releases use. It is what the 41 MB figure refers to.
      quantized: true,
      progress_callback: (event) => {
        if (!event || !event.file) return;
        if (event.status === 'progress') {
          perFile.set(event.file, { loaded: event.loaded || 0, total: event.total || 0 });
        } else if (event.status === 'done') {
          const previous = perFile.get(event.file);
          if (previous && previous.total) {
            perFile.set(event.file, { loaded: previous.total, total: previous.total });
          }
        } else {
          return;
        }

        let loaded = 0;
        let total = 0;
        for (const entry of perFile.values()) {
          loaded += entry.loaded;
          total += entry.total;
        }
        if (!total) return;

        const denominator = Math.max(total, config.expectedBytes || 0);
        // Held short of 1 until the pipeline actually resolves, so a full bar always
        // means ready rather than "the bytes we know about so far have arrived".
        const ratio = Math.min(0.99, loaded / denominator);
        highWater = Math.max(highWater, ratio);
        onProgress('model', highWater, { loaded, total: denominator });
      },
    });
  })().catch((error) => {
    // A failed build must not be remembered, or every retry resolves to the same
    // rejection for the life of the worker.
    pipelinePromise = null;
    loadedFor = null;
    throw error;
  });

  return pipelinePromise;
}

self.addEventListener('message', async ({ data }) => {
  if (!data || data.type !== 'transcribe') return;
  const { id } = data;

  const post = (message) => self.postMessage({ id, ...message });

  try {
    const asr = await getPipeline(data, (stage, ratio, bytes) =>
      post({ type: 'progress', stage, ratio, ...bytes })
    );

    const audio = new Float32Array(data.pcm);
    const seconds = audio.length / 16000;
    // 30-second windows with a 5-second stride means roughly one processed chunk
    // per 25 seconds of audio, which is what makes a progress estimate possible.
    const expected = Math.max(1, Math.ceil(seconds / 25));
    let done = 0;

    post({ type: 'progress', stage: 'listening', ratio: 0 });

    const result = await asr(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: data.timestamps ? true : false,
      chunk_callback: () => {
        done += 1;
        post({ type: 'progress', stage: 'listening', ratio: Math.min(0.98, done / expected) });
      },
    });

    const chunks = (result.chunks || []).map((chunk) => ({
      text: (chunk.text || '').trim(),
      start: chunk.timestamp?.[0] ?? 0,
      end: chunk.timestamp?.[1] ?? null,
    }));

    post({ type: 'done', text: result.text || '', chunks });
  } catch (error) {
    post({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
