# Tool page pattern

Every tool page in `src/pages/<slug>.astro` follows this exact shape. Read
`src/pages/audio-trimmer.astro` first — it is the reference implementation and
is already verified working end to end in a browser.

## File skeleton

```astro
---
import ToolPage from '../layouts/ToolPage.astro';
import ToolShell from '../components/ToolShell.astro';
import { getTool } from '../data/tools';

const tool = getTool('<slug>');           // slug MUST exist in src/data/tools.ts

const steps = [ /* 3–5 sentences, each a real instruction */ ];
const faq = [ { q: '…', a: '…' }, /* 5–7 items */ ];
---

<ToolPage slug={tool.slug} steps={steps} faq={faq}>
  <ToolShell tool={tool} {...shellProps}>
    <div class="controls">…tool-specific controls…</div>
  </ToolShell>

  <Fragment slot="about">
    <h2>…</h2>
    <p>…</p>
  </Fragment>
</ToolPage>

<script>
  import { createTool } from '../lib/tool';
  // …import only the dsp/effects/analysis functions this tool needs

  const tool = createTool({ suffix: '…', process(ctx) { … } });
</script>
```

## ToolShell props

| Prop | Default | Use |
|---|---|---|
| `tool` | — | Required, from `getTool(slug)` |
| `selection` | `false` | Draggable start/end handles on the waveform |
| `stage` | `true` | Set `false` for tools with no waveform (meters) |
| `exportBar` | `true` | Set `false` when the tool has its own download UI |
| `action` | `"Download"` | Primary button label, e.g. `"Download ringtone"` |
| `multiple` | `false` | Accept several files; they arrive as `ctx.buffers` |
| `video` | `false` | Also accept video files |
| `results` | `false` | Render a container for multi-output downloads |
| `dropTitle` / `dropHint` | — | Override empty-state copy |

## createTool config

- `suffix` — filename suffix, e.g. `'louder'` gives `song-louder.mp3`
- `defaultFormat` — `'mp3'` unless the tool has a reason (`'m4r'`, `'wav'`)
- `formats` — restrict the format list, e.g. `['m4r']`
- `onReady(ctx, runtime)` — wire tool-specific controls after decode
- `process(ctx)` — return `AudioBuffer`, `Blob`, or `NamedOutput[]`
- `preview(ctx)` — optional; returns the buffer the transport should play

### Reading control values

Any input with `data-control="name"` is readable from the runtime:

```ts
runtime.value('gain', 0)   // number
runtime.flag('normalize')  // boolean, for checkboxes
runtime.text('mode', 'a')  // string
```

The `ToolRuntime` returned by `createTool` is also the `tool` variable, so
inside `process` you can call `tool?.value('gain')`.

## Controls markup

Use these classes only — they already exist in `src/styles/app.css`:

```html
<div class="controls">
  <div class="controls__head">
    <span class="controls__title">Section name</span>
    <span class="hint">One line of guidance.</span>
  </div>

  <!-- Slider with paired number input. ALWAYS pair them: dragging alone is
       too imprecise on mobile. -->
  <div class="field">
    <label class="label" for="gain">
      Volume <span class="label__value" data-out="gain">+6.0 dB</span>
    </label>
    <div class="slider-row">
      <input class="slider" id="gain" data-control="gain"
             type="range" min="-20" max="20" step="0.5" value="6" />
      <input class="num" data-control="gain-num" type="number"
             min="-20" max="20" step="0.5" value="6" aria-label="Volume in decibels" />
    </div>
  </div>

  <!-- 2–4 exclusive options -->
  <div class="field">
    <span class="label" id="mode-label">Mode</span>
    <div class="seg" role="group" aria-labelledby="mode-label">
      <button type="button" class="seg__btn" data-mode="a" aria-pressed="true">A</button>
      <button type="button" class="seg__btn" data-mode="b" aria-pressed="false">B</button>
    </div>
  </div>

  <!-- 5+ options -->
  <div class="field">
    <label class="label" for="preset">Preset</label>
    <select class="select" id="preset" data-control="preset">…</select>
  </div>

  <!-- Boolean -->
  <label class="switch">
    <input type="checkbox" data-control="loop" />
    <span>Label text</span>
  </label>
</div>
```

Available helper classes: `.card`, `.panel`, `.note note--info|warn|error`,
`.chip`, `.btn btn--solid|quiet|ghost|danger` with `--sm|--lg`, `.filelist`,
`.results`, `.tablewrap`/`.datatable`, `.hint`, `.tnum`.

**Do not write new CSS in a page.** If something genuinely has no class, add it
to `src/styles/tool.css` with a comment saying why.

## Engine API

```ts
// src/lib/audio/dsp.ts        (pure, synchronous, Tier 0)
slice, cutOut, applyGain, applyFade, reverse, concat, setChannels,
extractChannel, swapChannels, invertPhase, resampleLinear, changeSpeed,
padSilence, loop, peakOf, rmsOf, normalizePeak, findSilence, removeSilence,
trimEnds, cloneBuffer, createBuffer, gainFactor, toDecibels

// src/lib/audio/stretch.ts    (pitch/tempo, synchronous but heavy)
timeStretch, pitchShift, changeTempo, semitoneRatio

// src/lib/audio/effects.ts    (async — all return Promise<AudioBuffer>)
applyEq, bassBoost, trebleBoost, applyReverb, applyEcho, apply8D,
setStereoWidth, applyCompressor, telephone, lowpass, highpass, renderThrough

// src/lib/audio/analysis.ts
measureLoudness, normalizeLoudness, detectTempo, peakDb, truePeakDb,
computePeaks, toneBuffer, silentBuffer

// src/lib/audio/waveform.ts
renderWaveformImage

// src/lib/audio/ffmpeg.ts     (Tier 2 — only for non-native formats)
extractAudio, transcode, encodeVia

// src/lib/format.ts
timecode, parseTimecode, duration, filesize, db, clamp, outputName
```

Effects are `async`, so `process` should be `async` when it uses them.

## Writing the content

This is not filler — templated pages get classified as doorway pages and the
whole domain suffers. Each page must be genuinely different from its siblings.

- **`steps`** — 3–5 items. Full sentences, specific to this tool. Never
  "Upload your file" (nothing is uploaded); say "Drop your file onto the page".
- **`faq`** — 5–7 items. Answer questions people actually ask about *this*
  tool. At least two must be specific enough that they could not appear on any
  other page. Answers are 2–4 sentences of real information.
- **`slot="about"`** — 350–600 words in 2–3 `<h2>` sections. Explain the
  underlying concept, not the button layout. Good subjects: why the format
  works the way it does, what the numbers mean, what trips people up, when
  *not* to use this tool. Write like someone who knows the subject explaining
  it to a competent stranger.

Tone: plain, direct, no marketing. No exclamation marks. No "simply" or
"easy". Never claim a feature the tool does not have.

## Non-negotiables

1. Every `<label>` has a matching `for`/`id`. Every icon-only button has
   `aria-label`.
2. Sliders always have a paired number input.
3. Never use `innerHTML` with a filename or any user string — `textContent`.
4. No `console.log` left behind.
5. Only import what you use; the tool chunk should stay small.
6. TypeScript is strict. Null-check DOM queries.
7. Do not edit shared files (`src/lib/**`, `src/styles/**`, `src/data/tools.ts`,
   layouts, components) — they are shared across every page. If you believe
   one needs a change, note it in your report instead.
