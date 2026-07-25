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

## Still open

**The mixer on the acapella extractor.** Mounting the stem panel there froze the
tab. Reverting it looked like the fix and was not: with the revert deployed and
confirmed live, the extractor still timed out against production while passing
locally. The vocal remover, same model and code path, passes in the same run. Next
step is watching a production run with the console attached rather than inferring
from the harness.
