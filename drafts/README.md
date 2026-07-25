# Parked work

## audio-transcriber.astro, subtitle-generator.astro

Complete pages for the two Whisper tools, plus `src/lib/ai/transcribe.ts` which
they use. Both are finished and neither is wired up, because transcription does
not work and shipping a broken tool is worse than shipping none.

## The failure

`ke._b is not a function`, thrown from inside transformers.js after every file
has loaded successfully. On a later run the same failure appeared as
`ke.$b is not a function` — the property name changes when Vite re-optimises its
dependency pre-bundle, which is itself the useful clue: this is a genuinely
missing method on an object inside the bundled library, not a name we control.

## Ruled out

- **Not a missing file.** Every model file returns 200 from our own origin:
  `config.json`, `tokenizer.json`, `tokenizer_config.json`,
  `preprocessor_config.json`, `generation_config.json`, and both quantized ONNX
  graphs.
- **Not the wasm path.** The runtime binary returns 200 from `/ort/<version>/`,
  so `env.backends.onnx.wasm.wasmPaths` is being honoured.
- **Not us clobbering the backend object.** `env.backends.onnx.wasm` already
  exists with `wasmPaths` and `proxy` keys before we touch it, and the `??=`
  does not replace it.
- **Not the ONNX Runtime version split.** This looked like the answer and was
  not. Installing `onnxruntime-web` for the separation tools had hoisted a third
  `onnxruntime-common` to the top of `node_modules` beside transformers'
  own nested pair, so the web build could resolve against a version of common it
  was not built for. An npm `overrides` block now forces exactly one
  `onnxruntime-web` and one `onnxruntime-common` across the whole tree — which is
  correct regardless, and is worth keeping — but the error survived it.
- **Not main-thread blocking.** Setting `env.backends.onnx.wasm.proxy = true` to
  run the runtime in its own worker changed nothing except the minified property
  name in the message.

## Worth trying next, cheapest first

1. Build the pipeline from `dist/transformers.web.js` with Vite's dependency
   optimisation disabled for that package (`optimizeDeps.exclude`). If the error
   goes away, it is an esbuild pre-bundling interaction rather than a library bug,
   and excluding it is the whole fix.
2. Try transformers.js 3.8.1, the last 3.x. Every version pins a dev prerelease
   of the runtime, so that is normal for the package and not itself suspicious,
   but 4.2.0 is recent enough that a regression is plausible.
3. Reproduce outside Astro entirely — a bare Vite app with just transformers.js
   and this model. That separates "the library is broken here" from "our build is
   breaking the library", which is the question everything above keeps circling.
4. Failing all that, implement Whisper directly on the `onnxruntime-web` already
   used for separation. It is several hundred lines — mel filterbank, byte-level
   BPE, the encoder-decoder loop with its KV cache, timestamp token parsing — but
   it removes the dependency and its version tangle entirely, and the numeric
   groundwork it needs (FFT, STFT) is already here and verified against PyTorch.

## What is already done and does not need redoing

The R2 layout and upload, the worker route, the model files already sitting in
the bucket, the SRT and VTT writers with their timestamp handling, the paragraph
splitter, the setup panel integration, and both pages including their SEO copy.
Only the call into transformers.js is broken.

---

## The mixer on the acapella extractor

`src/lib/ai/stem-panel.ts` and `StemPanel.astro` are live on the vocal remover and
the song splitter, both verified. Mounting the same panel on the acapella
extractor freezes the tab — no error, no console output, the page simply stops
responding, reproducibly and in production as well as locally.

What makes it strange is that the two pages are structurally identical: same
ToolShell props, same `results`, same `defaultFormat`, same single-buffer return,
one `<StemPanel />` each, one `mountStemPanel` call each. The only difference is
which of the two stems is listed first and which is returned to the export bar.
Reverting the mount restores the tool to +18.55 dB and a clean pass, which
confirms the panel is the cause without explaining it.

Worth trying: mounting the panel with the stems in the same order as the vocal
remover (instrumental first), which would isolate whether ordering matters at all;
and moving the mount after the return value is handed back rather than before it.
