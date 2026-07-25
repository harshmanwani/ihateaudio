# Parked work

## audio-transcriber.astro, subtitle-generator.astro

Complete pages for the two Whisper tools, plus `src/lib/ai/transcribe.ts` which
they use. Both are finished and neither is wired up, because transcription does
not currently work and shipping a broken tool is worse than shipping none.

The failure is `ke._b is not a function`, thrown from inside minified
transformers.js after everything has loaded successfully. What has been ruled
out:

- **Not a missing file.** Every model file returns 200 from our own origin:
  `config.json`, `tokenizer.json`, `tokenizer_config.json`,
  `preprocessor_config.json`, `generation_config.json`, and both quantized ONNX
  graphs.
- **Not the wasm path.** `/ort/1.26.0-dev.20260416-b7804b056c/ort-wasm-simd-threaded.wasm`
  returns 200, so `env.backends.onnx.wasm.wasmPaths` is being honoured and the
  binary that loads is the one matching transformers' pinned runtime rather than
  the 1.27.0 the separation tools use.
- **Not our clobbering the backend object.** `env.backends.onnx.wasm` already
  exists with `wasmPaths` and `proxy` keys before we touch it, and the `??=` does
  not replace it.
- **Not npm hoisting the wrong runtime.** transformers' nested
  `onnxruntime-web@1.26.0-dev` declares `onnxruntime-common@1.24.0-dev` and that
  is exactly what is nested beside it. The version pair looks mismatched and is
  what the package author asked for.

So it is inside the library, after initialisation. The next things worth trying,
roughly in order of cheapness:

1. Drop `dtype: 'q8'` and `device: 'wasm'` and take the defaults, which needs the
   fp32 graphs fetched as well (about 4x the size, so only as a diagnostic).
2. Build the pipeline from an unminified transformers build to get a real stack
   trace instead of `ke._b`.
3. Try a different transformers version. 4.2.0 is what this was written against;
   the error may simply be a regression.
4. Failing all that, implement Whisper directly on the onnxruntime-web we already
   use for separation. It is several hundred lines - mel filterbank, byte-level
   BPE, the encoder-decoder loop with its KV cache, timestamp token parsing - but
   it removes the dependency and its version tangle entirely, and the numeric
   groundwork (FFT, STFT) is already here and verified.

Everything else about these tools is done and tested: the R2 layout, the worker
route, the two-runtime sync, the SRT and VTT writers with their timestamp
handling, and the pages themselves.
