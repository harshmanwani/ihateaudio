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
was the decisive evidence that the version itself was broken here rather than the
build. `@xenova/transformers@2.17.2`, the configuration proven in production in
CapCut GPT, works.

Worth knowing: 2.17.2 is the older name and major of the same project, not an
older model — the weights are the same Whisper `tiny.en`. What it lacks is WebGPU
and fine-grained dtype control. WebGPU is moot here anyway, because it needs the
`.jsep` runtime build at 25.6 MB, over Cloudflare's 25 MiB per-asset ceiling.

If a future tool needs WebGPU or a newer architecture, revisiting 4.x is a version
bump plus an API adjustment rather than a rewrite — the worker structure is what
makes that cheap.

## The noise remover

`noise-remover.astro` is complete, as is `src/lib/ai/denoise.ts`. It is parked
because it returns **silence**, not cleaned audio.

Measured: input RMS 0.119, output RMS 0.000, over a fixture of speech with pink
noise mixed in. The file is the right length and a perfectly valid WAV.

The cause is almost certainly that `RnnoiseWorkletNode` produces nothing inside an
`OfflineAudioContext`. At full strength the dry path is muted, so an empty wet path
means an empty result, and the worklet reports no failure of its own.

Two things were fixed on the way to finding this, and both are worth keeping:

- `reductionDb` returned 0 for silent output, which the page rendered as "almost
  nothing was removed — the recording was already clean". A tool that destroys the
  file and then reassures you about it is the worst failure available. It now
  returns Infinity for silence.
- `denoise()` now refuses to return a silent buffer at all, throwing instead.

Next: confirm the worklet runs offline by rendering a known tone through it and
checking the output is non-zero. If AudioWorklet genuinely does not run under
OfflineAudioContext in this browser, the fallbacks are a real-time render through a
regular AudioContext (slow, but correct), or calling the RNNoise wasm frame by
frame directly and skipping the worklet wrapper entirely — 480-sample frames at
48 kHz, which is a small amount of code.

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
