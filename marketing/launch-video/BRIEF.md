---
workflow: product-launch-video
flow: automation
storyboard: no
message: "49 audio tools, free, right in your browser. No signup, no upload, no watermark."
destination: youtube
aspect: 1920x1080
language: en
audience: "Product Hunt visitors and launch-directory browsers who edit audio now and then and hate the usual tools"
length: 35s
angle: frustration-to-punchline
narration: no
fps: 30
---

## Intent

A ~35-second launch promo for ihateaudio.com. It plays in the Product Hunt
gallery (through YouTube) for the launch at 00:01 PT on 14 Oct 2026, and on
launch directories. SELL, not show: "Promo marketing, no need for offline proof
etc, we just say it is. say free and banger video with animations and all."

Angle: frustration, then punchline. Audio editing is miserable; ihateaudio
makes the boring 90% painless. Energy is high: fast kinetic typography, punchy
cuts on the beat, animated waveforms, a count-up to "49", and a quick montage
of real tool screens. "Banger." No voiceover; on-screen text carries the story.

Output: 1920x1080, 30fps, H.264 + AAC.

## Assets

- /Users/harsh/Desktop/K/code/ihateaudio/public/fonts/instrument-sans-latin.woff2 — Instrument Sans variable font (brand type, weights 500–700, wordmark may go heavier).
- /Users/harsh/Desktop/K/code/ihateaudio/src/assets/logo.svg — brand logo mark.
- /Users/harsh/Desktop/K/code/ihateaudio/public/favicon.svg — favicon mark.
- /Users/harsh/Desktop/K/code/ihateaudio/public/icon-512.png — app icon.
- /Users/harsh/Desktop/K/code/ihateaudio/public/icons3d/<slug>.png — per-tool 3D icons (montage accents).
- /Users/harsh/Desktop/K/code/ihateaudio/public/og/<slug>.png — per-tool social cards.
- Real captures of https://ihateaudio.com/<slug> tool pages with a generated WAV loaded through `[data-file-input]` (Playwright), so the dark waveform stage shows a real waveform. These are the montage footage.

## Customizations

Beat sheet (adapt freely for rhythm):

1. Hook (0–4s): "Audio editing is miserable." Glitchy, jittery waveform.
2. Pain (4–8s): "Upload limits." "Signup walls." "Watermarks." Each slams in, then gets struck through.
3. Turn (8–11s): "So we fixed it." then the ihateaudio wordmark reveal.
4. Number (11–14s): count-up to "49 audio tools." then "Free."
5. Montage (14–26s): real tool screens, fast, each with a 1–2 word label: Trim. Convert. Remove vocals. Slowed + reverb. Transcribe. Ringtones. BPM + key. Bass boost.
6. Promise (26–31s): "Runs right in your browser." "Your file never leaves your device."
7. Stack (31–34s): "No signup. No watermark. No limits."
8. End card (34–37s): ihateaudio wordmark, "ihateaudio.com", small line "49 free audio tools". Hold long enough to read.

- Count-up on "49".
- Animated waveforms (glitchy in the hook, clean green on dark stage later).
- Strike-through on each pain word.
- Energetic, license-safe music bed; cuts land on the beat.

Deliverables (in out/):

- out/ihateaudio-launch-16x9.mp4 — final render, 1920x1080.
- out/poster.png — strong 1920x1080 frame for the YouTube thumbnail.
- out/ihateaudio-launch-1x1.mp4 — 1080x1080 cut, if time allows.

## Notes

- Brand (DESIGN.md / src/styles/tokens.css): lowercase wordmark "ihateaudio"; Instrument Sans. Palette: page white, ink (oklch 0.19 0.012 162), bottle green (oklch 0.42 0.095 162), brand-soft (oklch 0.958 0.022 162), amber accent (oklch 0.70 0.155 62), dark stage (oklch 0.168 0.014 162), wave green (oklch 0.735 0.13 162), playhead amber (oklch 0.85 0.16 62). The video may be bolder than the site; keep the palette.
- Voice: blunt, quick, plain. No exclamation marks, no mascot, no "AI-powered" headline.
- Anti-references: dark neon purple "audio tool" styling, glassmorphism, generic template look.
- Facts allowed: 49 free tools; runs in the browser; files are not uploaded; no signup, no account; no watermark; no ads; no limits beyond device memory; the tool list in the user's brief. Do not invent user counts, ratings, or press quotes.
- Never publish or upload anything. Do not use the site's /mcp endpoint. Do not modify any other part of the ihateaudio repo.
- Project location is marketing/launch-video inside the ihateaudio repo (user's choice; overrides the workflow's default videos/<project>).
- Hard deadline: final MP4 within about 3 hours of 19:06 IST, 13 Oct 2026.

### Autonomous decisions (the user said: do not ask; record decisions here)

- Mode: autonomous (flow automation + storyboard no). Plan and sketch checkpoints post a summary and continue. The workflow's one kept question at the final look ("render now, or what changes?") is not asked: the user told us to render without questions. The Studio preview is opened before the render.
- Sign-in: `hyperframes auth status` reported "Not signed in to HeyGen — voice & music will use local engines". Continued offline (autonomous). Local MusicGen deps are missing, and MusicGen weights are CC-BY-NC, so they are not license-safe for a commercial promo anyway.
- Music: an original synthetic beat bed, written for this video by `scripts/make-music.mjs` (oscillators + seeded noise; no samples, loops, or third-party audio). 120 BPM so one beat = 15 frames; every cut and slam is on the beat, and the hits (impacts, strikes, whooshes, count-up ticks, tape stop, riser into the drop) are baked into the bed at the frame times. A minor, gritty hook (0–8 s) flips to a bright C–G–Am–F groove on the drop at 10 s. Mastered to about −14 LUFS. File: `assets/audio/ihateaudio-bed.wav`, mounted as host audio (`audio_meta.json`, `source: host`). License: original work, owned by the project; no attribution needed. No other SFX tracks.
- Copy style: display copy is lowercase with a final period (matches the lowercase wordmark and the broadside preset); "bpm + key." stays lowercase for consistency. No exclamation marks.
- Colors: taken from `src/styles/tokens.css` (hue 156; DESIGN.md's 162 table is older, and its own note says 156). Converted OKLCH → sRGB with the CSS Color 4 gamut mapping the live site renders: ink #0F1611, brand #006E3D, brand-soft #E0F7E7, accent amber #E18518, stage #0A110C, wave #31D685, playhead #FFBC79.
- Design preset: `broadside` (bold lowercase type as graphic), remixed to the brand; frame.md adds a third register (white page) and maps the accent to wave green / brand green.
- Real screens: captured live from https://ihateaudio.com with Playwright (`scripts/capture-tools.mjs`); a different generated WAV per tool is set on `[data-file-input]` so each page shows its own real waveform. Nothing was uploaded; analytics requests were blocked during capture.
- Length: 37.5 s (inside the 30–40 s range). Beat sheet kept; turn split into "so we fixed it." (8–10 s) and the wordmark on the drop (10–12 s).
- Project path: `marketing/launch-video` (user choice). Montage and page captures live in `assets/montage/` and `assets/pages/`; `stage-assets.mjs` reports them as "not found under capture/" because it only looks for flat basenames. The files exist; the warning is harmless.

### Build and QA record (13 Oct 2026)

- Frames: 9 frame workers built `compositions/frames/01-hook … 09-endcard` in parallel from `.hyperframes/frame-packets/`. Assembly: `assemble-index.mjs` (37.5 s, +0 s against plan). Transitions: all hard cuts on the beat (`transitions.mjs inject/verify`: 0 transitions, verified).
- `npx hyperframes lint`: first pass 0 errors, 6 warnings (`gsap_repeated_fromto_without_baseline` in 02, 05, 07, 08); fixed with `immediateRender: false`; now 0 errors, 0 warnings.
- `npx hyperframes check`: passed. Lint, runtime, motion: clean. Contrast: 29/29 text checks pass WCAG AA. Layout: 2 infos only (the intentional "free." slam overlap at 13.5 s; a hidden montage URL reported under later frames, not visible in any snapshot).
- Snapshots: 35 timestamps (frame midpoints and both sides of every cut) in `.hyperframes/artifacts/snapshots/pass1/contact-sheet-{1..4}.jpg`; reviewed, no layout failures.
- Media polish: the screenshots are UI captures; left unchanged on purpose.
- Render: `npx hyperframes render --skill=product-launch-video --quality high --crf 12 --output out/ihateaudio-launch-16x9.mp4` — H.264 High 1920x1080 30 fps + AAC 48 kHz stereo, 37.5 s, −14.0 LUFS, −3.8 dBTP.
- Poster: `out/poster.png` is the 14.45 s frame ("49 audio tools. free." with the 49-icon grid), captured lossless with `hyperframes snapshot`.
- 1:1 cut: `out/ihateaudio-launch-1x1.mp4` (`sh square/make-square.sh`) — the 16:9 master letterboxed to 1080x608 between a brand band (logo + wordmark) and a URL band. Not re-composed per frame.
- Final look: the Studio preview was opened (`npx hyperframes preview --background`); the render was not gated on a question because the user asked for no questions.

---

## v2 "or." (16 Oct 2026)

The owner rejected v1: the vibe did not land, the synthetic music was bad, and the
glitched "audio editing" type had to go. They asked for "free forever" on screen.
v2 replaces v1 in `index.html`; v1 is in git at `b63608b` (its renders are kept as
`out/v1-*`).

Agreed with the owner, one question at a time (no autonomous mode this time):

- **Vibe:** deadpan funny. The usual audio site wastes your time; ihateaudio just does it.
- **Type:** Instrument Serif for all display copy (`assets/fonts/`, OFL, copied from the
  owner's yaktech project). The wordmark on the end card stays in Instrument Sans.
- **Music:** cheesy phone-hold music (*Für Elise*, CC0) stops dead on "or.", then only the
  real tool sounds, then a funk beat (HeyGen catalog) under "free forever" and the logo.
  The owner listened to every candidate and picked them. Sources: `assets/audio/CREDITS.md`.
- **Product footage:** real sessions on the live site, not screenshots.
  `scripts/record-tools.mjs <take>` drives https://ihateaudio.com with a drawn cursor,
  drops real files on the real drop zone, and records 1920x1080 frames with the DevTools
  screencast; `scripts/encode-take.sh takes/<take>` makes the clip. Every sound in the
  demo is the page's own output (the trimmed memo, the separated music and vocal).
- **Review stops:** music candidates, then a rough cut, then the final render.

Rebuild (the downloaded and generated audio is not in git, because the repo is public):

1. Re-download the three sources listed in `assets/audio/CREDITS.md` into `assets/audio/candidates/`.
2. Voice memo: four HeyGen TTS takes (voice "Lucian", `049413e41c334753984c294d694afb5c`):
   "Um. Is this recording?", "Hello?", "Okay. Okay, it's recording.", "Hi, it's me. The
   meeting moved to three." Placed at 0.9, 4.68, 7.56 and 10.0 s over light pink noise,
   13.9 s long, saved as `assets/audio/demo/voice-memo.mp3`.
3. Song clip: `Benjamin_Orth_-_Where_You_Are_Now.mp3` from 8.6 s, 12.4 s long, as
   `assets/audio/demo/where-you-are-now.mp3`.
4. `node scripts/record-tools.mjs trim|vocals|slowed|ringtone|bpm`, encode each, copy the
   clips to `assets/video/take-<name>.mp4` and the saved outputs to `assets/audio/v2/`.
   Re-measure the click times in `takes/<name>/events.json`: the edit points in each scene
   file and the audio starts in `index.html` depend on them.
5. `npx hyperframes render --quality delivery --crf 12 --output out/ihateaudio-launch-16x9.mp4`.

Build record (16 Oct 2026): `npx hyperframes check` passes (lint 0 errors; the one warning
is the four captions on one track in scene 1; contrast 28/28 AA). Pin bumped
0.8.152 → 0.8.162. Master: H.264 1920x1080 30 fps + AAC 48 kHz, 40.0 s, −15.4 LUFS,
−2.2 dBFS peak. Runtime is 40 s against a 36 s target; the owner approved the rough cut at
that length. Poster: `out/poster.png`, the 35.9 s frame ("49 audio tools. free forever."),
lossless from `hyperframes snapshot`. No square cut yet for v2.
