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
 * The imported module, kept because the streamer class is needed at call time.
 *
 * v2 reported chunk progress with a `chunk_callback` option on the call. v4 removed
 * it, and the replacement is WhisperTextStreamer, which has to be constructed with
 * the pipeline's own tokenizer — so the module has to outlive the import.
 */
let lib = null;

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
    lib = await import(config.libUrl);
    const { pipeline, env } = lib;

    // Our own origin, never huggingface.co. The privacy page says no third party
    // learns which tool you opened, and that has to cover the weights too.
    env.remoteHost = config.host;
    env.remotePathTemplate = '{model}';
    env.allowLocalModels = false;
    env.allowRemoteModels = true;

    const wasm = env.backends.onnx.wasm;
    // A directory. This build has ONNX Runtime compiled in with WebGPU support and
    // resolves its binary to the asyncify variant, so that is the pair the sync
    // script puts here — pointing this at a directory holding the plain build
    // instead just 404s on ort-wasm-simd-threaded.asyncify.mjs.
    wasm.wasmPaths = config.wasmDir;
    // The binary is the threaded build, but threads need SharedArrayBuffer and that
    // needs the page to be cross-origin isolated, which this site is not. Saying so
    // explicitly beats letting the runtime discover it.
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
      // 'q8' names the same *_quantized.onnx graphs the boolean `quantized: true`
      // selected in v2, so the weights already in R2 are the weights this fetches.
      // It is what the 41 MB figure refers to.
      dtype: 'q8',
      /**
       * WASM rather than WebGPU, and that was measured rather than assumed.
       *
       * WebGPU on these weights is slower: 2.45 s against 2.14 s on thirty seconds
       * of audio, because int8 does not map onto the GPU and the work bounces back.
       * The best combination that does run — an fp16 encoder with the q8 decoder —
       * came to 2.06 s, a five percent gain for six more megabytes of download and
       * a second set of weights to host.
       *
       * whisper-tiny is simply too small to pay for a GPU: the decoder is
       * sequential, one token at a time, and at this size the launch overhead is
       * most of the work. A larger model would change that answer.
       */
      device: 'wasm',
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

    /**
     * Chunk progress, which v4 reports through a streamer rather than a callback.
     *
     * on_chunk_start fires as each window begins, so counting completed windows
     * means counting starts after the first. Without this the bar sat at zero for
     * the whole run and only moved when the transcript appeared, which on a long
     * recording is indistinguishable from being hung.
     */
    const streamer = new lib.WhisperTextStreamer(asr.tokenizer, {
      on_chunk_start: () => {
        post({ type: 'progress', stage: 'listening', ratio: Math.min(0.98, done / expected) });
        done += 1;
      },
      on_chunk_end: () => {
        post({ type: 'progress', stage: 'listening', ratio: Math.min(0.98, done / expected) });
      },
    });

    const result = await asr(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      return_timestamps: data.timestamps ? true : false,
      streamer,
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
