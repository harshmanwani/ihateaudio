# WebMCP on ihateaudio

ihateaudio is a set of browser-side audio tools. Every tool decodes, edits and
encodes audio inside the tab; nothing is uploaded. This document describes how
the site exposes those tools to an AI agent through WebMCP, and separates the
work added for the WebMCP Challenge from the site that existed before it.

## Prior work and new work

The Challenge rules ask a pre-existing project to show what was added during
the submission period. The split is exact.

**Prior work** (before 2026-08-26): the site itself. About fifty tool pages, the
shared runtime in `src/lib/tool.ts` that gives them one intake, waveform,
transport, selection and export path, and the local DSP under
`src/lib/audio/`. None of it knew about agents.

**New work** (2026-08-26 onward, all in the commit history of this repository):

| File | What it adds |
| --- | --- |
| `src/lib/webmcp.ts` | The feature-detect boundary. Finds a WebMCP host on `navigator.modelContext` (W3C proposal) or `document.modelContext` (ChatGPT), registers tools, and never throws into the page. |
| `src/lib/agent.ts` | The pure half: a tool's `agent` manifest, the JSON schema built from it, and the clamping that keeps agent values inside what the interface can represent. |
| `src/lib/tool.ts` (additions) | The base agent tools every page gets, the manifest → WebMCP tool compiler, and the applier that lands values on the page's own controls and fires their events. |
| `src/components/ToolShell.astro` | A status line, visible only in an agent browser, that says how many tools registered. |
| 33 page files | An `agent` manifest each, one named action per tool, from the trimmer to the stem splitter. |
| `tests/unit/agent.test.ts`, `tests/unit/webmcp.test.ts`, `tests/e2e/agent-tools.spec.ts`, `tests/e2e/agent-manifests.spec.ts` | Unit tests for the schema and clamping, and browser tests that shim a WebMCP host, call the tools, and assert the visible controls moved. |

`git log --since=2026-08-26 -- src/lib/webmcp.ts src/lib/agent.ts` shows the
dated history.

## What an agent can do

**On every tool page**, with no per-page work:

| Tool | Does |
| --- | --- |
| `inspect_audio` | Read-only. Duration, channels, sample rate, the selection, every visible setting, and the export format. Never the samples or the file contents. |
| `set_selection` | On tools with a waveform selection: move the handles, in seconds. |
| `set_output_format` | Choose the download format and, for lossy formats, the bitrate. |
| `render_preview` | Render the result of the current settings into a listenable player under the controls. Nothing is saved. |
| `export_download` | Render and start a browser download. Described as a side effect, for use only when the person has asked. |

**Per page**, one named action from the page's manifest (33 pages; the rest have no settable control and run on the base tools):

| Page | Action | Parameters |
| --- | --- | --- |
| `/8d-audio-maker` | `set_8d_effect` | `secondsPerTurn`, `distance` |
| `/android-ringtone-maker` | `set_ringtone` | `startSec`, `endSec`, `fadeOut`, `fadeSec` |
| `/audio-compressor` | `set_compression` | `bitrateKbps`, `sampleRateHz`, `channels` |
| `/audio-joiner` | `set_join_gap` | `gapSec` |
| `/audio-looper` | `set_loop` | `repeats`, `gapSec` |
| `/audio-normalizer` | `set_loudness_target` | `platform`, `targetLufs`, `ceilingDbtp` |
| `/audio-splitter` | `set_split` | `method`, `parts`, `partLengthSec`, `silenceThresholdDbfs`, `minimumGapSec` |
| `/audio-transcriber` | `set_transcript_layout` | `paragraphs` |
| `/audio-trimmer` | `set_trim` | `startSec`, `endSec`, `mode`, `fade` |
| `/bass-booster` | `set_bass_boost` | `amountDb`, `cornerHz`, `keepLevel` |
| `/bpm-detector` | `set_analysis_range` | `selectionOnly` |
| `/crossfade-joiner` | `set_crossfade` | `fadeSec` |
| `/dynamic-compressor` | `set_compressor` | `preset`, `thresholdDb`, `ratio`, `attackMs`, `releaseMs`, `kneeDb`, `makeupDb` |
| `/echo-adder` | `set_echo` | `preset`, `delayMs`, `feedbackPercent`, `mixPercent` |
| `/equalizer` | `set_equalizer` | `preset` |
| `/fade-in-out` | `set_fade` | `fadeInSec`, `fadeOutSec`, `curve` |
| `/nightcore-maker` | `set_nightcore` | `rate`, `preset` |
| `/noise-remover` | `set_noise_reduction` | `strength` |
| `/pitch-shifter` | `set_pitch_shift` | `semitones`, `cents` |
| `/reverb-adder` | `set_reverb` | `space`, `decaySec`, `mix`, `preDelayMs` |
| `/ringtone-maker` | `set_ringtone` | `startSec`, `endSec`, `fadeOut`, `fadeSec` |
| `/sample-rate-converter` | `set_sample_rate` | `sampleRateHz` |
| `/silence-remover` | `set_silence_removal` | `threshold`, `minimumGapSec`, `paddingSec` |
| `/slowed-reverb` | `set_slowed_reverb` | `intensity`, `speed`, `mix`, `decaySec` |
| `/speed-changer` | `set_speed` | `speed`, `keepPitch` |
| `/stem-splitter` | `set_stems` | `vocals`, `drums`, `bass`, `other` |
| `/stereo-to-mono` | `set_channel_mode` | `mode` |
| `/stereo-widener` | `set_stereo_width` | `width` |
| `/tempo-changer` | `set_tempo` | `tempoPercent`, `bpm` |
| `/voice-changer` | `set_voice` | `preset`, `semitones` |
| `/volume-booster` | `set_volume` | `method`, `gainDb`, `targetPeakDbfs` |
| `/wav-converter` | `set_wav_bit_depth` | `bitDepth` |
| `/waveform-generator` | `set_waveform_image` | `preset`, `widthPx`, `heightPx`, `style`, `waveColor`, `backgroundColor`, `transparent` |

Every reply is `{ content: [{ type: 'text', text }] }`, where `text` is JSON
that echoes the settings after the change, so the agent can confirm what it
did. Out-of-range numbers clamp to the control's range, the way the slider
would have stopped; wrong types and unknown keys are dropped and named in
`ignored`.

## How the layer works

1. A page calls `createTool(config)` as it always did. It may add an `agent`
   manifest: a name, a description, and a list of parameters with a type, a
   range or enum, and where the value lands.
2. On load, the runtime builds the base tools, compiles the manifest into one
   more tool with a JSON schema, and hands the list to `registerSiteTools`.
3. `registerSiteTools` looks for a host. Without one it returns
   `{ supported: false }` and the page carries on as an ordinary editor. With
   one it registers every tool and the status line appears.
4. When an agent calls the page action, the runtime clamps the values and
   sets each one on the matching `data-control` element, then dispatches
   `input` and `change`. The page's own listeners run: the silence remover
   re-scans and re-highlights, the fade redraws its envelope, the normalizer
   updates its plan text and preview. A parameter can instead name a custom
   setter, which is how state held in a page variable, like the trimmer's
   keep/cut mode, is driven by clicking its real button.

The agent therefore never has a hidden second set of settings. The page is
the single source of truth, and the person can override anything at any
moment.

## Privacy

Tools return derived facts only: numbers, times, names of settings. The
decoded samples, the rendered preview and the downloaded file stay in the
tab. An agent cannot fetch the audio, and the page never sends it anywhere.

## Testing it

**ChatGPT desktop app (macOS or Windows)**

Site tools live only in the desktop app's *built-in browser*. The Codex Chrome
extension ("Chrome integration") drives Chrome by clicks and does not see site
tools, so a page can report "6 agent tools ready" there and ChatGPT will still
say none are callable.

1. Update to the latest version. Site tools also need an account and model that
   support them.
2. Open a chat in **Work** or **Codex**, then open the built-in browser from the
   toolbar, or press ⌘⇧B (macOS) / Ctrl+Shift+B (Windows).
3. Settings → Browser → Permissions → **Enable site tools** must be on.
4. Open `https://ihateaudio.com/audio-trimmer`. A grey arrow appears in the
   address bar; select it to see the registered tools. It turns blue while
   ChatGPT uses one.
5. Choose a file, then ask for an outcome: "Keep 0:05 to 0:20 and fade the
   edges."

**Google Chrome 149 or later**

1. Enable `chrome://flags/#enable-webmcp-testing` and relaunch.
2. Open any tool page over HTTPS. The page registers on the browser's host:
   `navigator.modelContext` in the proposal, `document.modelContext` in current
   Chrome builds (152 at the time of writing). Both are handled.
3. DevTools → Application → **WebMCP** lists every registered tool with its
   schema, and can invoke any of them with JSON input. In the console,
   `await document.modelContext.getTools()` shows the same list.

**Locally**

```bash
npm install
npm run dev          # http://localhost:4321
npm test             # unit tests
npm run test:e2e     # browser tests, including the agent specs
```
