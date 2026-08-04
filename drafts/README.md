# Parked work

Nothing is parked here at the moment.

## Resolved: Whisper transcription

The two Whisper tools shipped. What had blocked them was
`ke._b is not a function`, thrown from inside transformers.js after every file
loaded successfully, with the property name changing on each rebuild.

The fix came in two parts, and only the second one mattered.

**Loading the library as a static file.** Letting Vite pre-bundle transformers.js
makes it spawn a worker referencing module ids from the main bundle that do not
exist in worker scope. The library now lives in `public/lib/transformers/` and is
imported by URL from a worker in `public/workers/`, so no bundler touches it. This
is the approach the CapCut GPT codebase had already settled on after hitting the
same failure under Turbopack.

**Changing library version.** The above alone did not fix it — with the bundler
completely out of the path, `@huggingface/transformers@4.2.0` still failed. That
was read at the time as the version being broken here, and
`@xenova/transformers@2.17.2` was adopted instead.

**That diagnosis was wrong, and the site is back on 4.2.0.** What 4.x failed on
was a missing file, not a broken library. Its standalone build has ONNX Runtime
compiled in with WebGPU support and resolves its WebAssembly to the *asyncify*
variant — `ort-wasm-simd-threaded.asyncify.{mjs,wasm}`. The sync script was
copying v2's `ort-wasm-simd.wasm` and `ort-wasm.wasm`, so the file it actually
wanted 404'd, and what surfaced was:

```
no available backend found. ERR: [wasm] TypeError: Failed to fetch dynamically
imported module: .../ort-wasm-simd-threaded.asyncify.mjs
```

which names the missing file plainly but reads like the backend is unavailable.
Copy that pair in and 4.2.0 runs first try.

It is worth roughly twice the speed: 4.0 s against 2.1 s on thirty seconds of
audio, measured back to back in one tab. Real speech runs about 4.8× faster than
real time, so the "ten minute recording takes a couple of minutes" line in the
setup panel is now true rather than optimistic. The cost is the runtime download,
23.6 MB against 10.5 MB, cached on a versioned path and repaid within one clip.

**WebGPU is still not worth it, for a different reason than recorded here.** The
`.jsep` build at 25.6 MB is over Cloudflare's ceiling, but that never comes up —
the standalone bundle wants asyncify at 23.1 MB, which fits. The real reason is
that it is not faster: 2.45 s against 2.14 s on the q8 weights, because int8 does
not map onto the GPU. The best combination that runs at all, an fp16 encoder with
the q8 decoder, managed 2.06 s — five percent, for six more megabytes and a second
set of weights to host. An fp16 decoder does not load at all: ORT rejects the
merged graph over a subgraph output. whisper-tiny is too small to pay for a GPU,
its decoder being sequential and the launch overhead being most of the work. A
larger model would change that answer; this one does not.

## Resolved: the noise remover

Shipped. The suspicion was right — `RnnoiseWorkletNode` does produce nothing
inside an `OfflineAudioContext` — and so was the second fallback listed here:
calling the wasm frame by frame and skipping the wrapper entirely.

The mechanism turned out to be a race, which is why it looked deterministic. The
packaged processor loads its wasm in an async IIFE from its constructor, and its
`process()` reads:

```js
process(inputs, outputs) {
  return ... || !this.processor || this.processor.process(inputs[0], outputs[0]), true
}
```

Until the wasm finishes instantiating, `this.processor` is undefined, the
expression short-circuits, and **the output array is never written**, so it stays
zeros. On a live AudioContext that is a few milliseconds of silence nobody hears.
`startRendering()` runs the whole file as fast as the machine allows and finishes
long before the wasm is ready, so every frame takes the short-circuit and the
entire result is silence. There is no readiness signal to wait on, so the worklet
had to go.

`src/lib/ai/rnnoise.ts` now instantiates `rnnoise.wasm` directly. It exports
`malloc`, `free` and the four `rnnoise_*` entry points and imports only three
trivial `env` functions, so it needs no Emscripten glue and no audio graph — it
was never anything but a pure frame function. No new dependency: the same wasm the
package already shipped, minus the wrapper.

Three things fell out of doing it this way:

- **Real progress and a working cancel.** `OfflineAudioContext` gives no progress
  events; a plain loop that yields every couple of seconds of audio gives both.
- **The delay was wrong before.** Measured by cross-correlation, RNNoise runs one
  frame (480 samples) behind. The old code blended an undelayed dry path against a
  delayed wet one, so every strength below 100% was a comb filter rather than a
  blend. The output is now shifted back and the blend is real.
- **It is testable in Node.** `tests/unit/rnnoise.test.ts` runs the actual model
  against the fixtures, so "returns silence" can never come back unnoticed.

Verified in a browser on speech with noise: noise-only passages down 15.2 dB, the
voice within 0.23 dB of where it started, 4 seconds of audio in 83 ms.

One loose end: there is no `public/icons3d/noise-remover.png`, so this is the only
AI tool falling back to its glyph. Regenerate with
`FAL_KEY=... node scripts/generate-tool-icons.mjs noise-remover`.

The two guards found on the way here are still in place and still worth keeping:
`reductionDb` returns Infinity rather than 0 for silent output, and `denoise()`
refuses to return a silent buffer — though it now only throws when the *input* had
signal, since a silent file legitimately denoises to a silent file.

## Still open

**The mixer on the acapella extractor.** Mounting the stem panel there freezes the
tab: no error, no console output, the page stops responding. The vocal remover and
the song splitter mount the same panel and are fine.

Eliminated so far:

- **Not stem ordering.** The obvious difference was that this page listed the vocal
  first while the vocal remover lists the instrumental first. Mounting with the
  identical order to the vocal remover still freezes.
- **Not the page structure.** Same ToolShell props, same `results` flag, same
  `defaultFormat`, same single-buffer return, one `<StemPanel />` and one
  `mountStemPanel` call each.
- **Not which buffer is returned to the export bar.** Both pages return a buffer
  that is also held by the panel's player.

Still untried, and the obvious next step: instrument `StemPanel`'s constructor to
find which stage it stops at — the AudioContext, the DOM build, the first
`repaint()`, or the ResizeObserver. Everything so far has been inference from the
outside, and the freeze means the page never gets to report anything, so the
instrumentation has to write somewhere that survives it.
