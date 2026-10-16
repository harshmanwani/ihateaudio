---
format: 1920x1080
fps: 30
duration: 37.5s
message: "49 audio tools, free, right in your browser. No signup, no upload, no watermark."
arc: Hook → Pain → Turn → Brand → Number → Montage → Promise → Stack → End card (PAS, frustration to punchline)
audience: Product Hunt visitors and launch-directory browsers who edit audio now and then and hate the usual tools
mode: autonomous
music: none
---

# ihateaudio launch promo — storyboard

No voiceover. On-screen kinetic type carries the story. The music bed is an original
120 BPM synthesis (`assets/audio/ihateaudio-bed.wav`, host audio, mounted by the
orchestrator). One beat = 0.5 s = 15 frames at 30 fps. Every frame starts on a beat,
so inside every frame the beats fall at local 0.0, 0.5, 1.0, 1.5 … Hits listed under
each frame are already in the music; land the matching visual on that exact local time.

## Video direction

- **Palette system (from `frame.md`)** — three registers, one per frame:
  dark = ground #0A110C, text #FFFFFF, accent wave green #31D685, amber #FFBC79 only for strikes/playhead;
  white = ground #FFFFFF (or surface #F5F8F6), text ink #0F1611, secondary #515954, accent brand green #006E3D, amber #E18518 only for strikes and "free.";
  green = ground brand #006E3D, text #FFFFFF, accent wave green #31D685.
  Register order: 01 dark · 02 dark (ink #0F1611 ground) · 03 white · 04 green · 05 dark · 06 white · 07 white · 08 green · 09 white.
- **Type** — Instrument Sans 700 for all display, lowercase, tracking −0.04em at display size, each statement ends with a period. No exclamation marks. Chrome (URLs, tiny labels) in `Menlo, ui-monospace, monospace`, small, ink-2 or muted. Font file: `assets/fonts/captured-instrument-sans-latin.woff2` (variable 400–700).
- **Motion grammar** — high energy, but clean: hits land exactly on the beat times listed; entrances are fast slams on a long-tail settle (`expo.out` / `power3.out`), no bouncy overshoot, no elastic. A 2–3 frame micro-shake on a slam is allowed (it is the beat hit). Glitch only in the hook. Inside a hold, the only aliveness is subtle jitter or the subject doing something (logo bars pulsing to the kick, a playhead moving across a waveform).
- **Reveal model** — nothing appears before its beat. Each piece of copy enters on its listed local time.
- **Rhythm / held frames** — 03-turn is the breath (white, one line, riser). 07-promise is the breakdown (calmer, more reading time). 09-endcard is the long hold. Everything else is fast.
- **Negative list** — no purple, no neon glow, no glassmorphism, no gradient grounds, no generic stock shapes, no mascot, no "AI-powered" copy, no invented numbers. No CSS transitions/keyframes, no `repeat`/`yoyo`, no `Math.random` (use index-seeded deterministic noise). No slideshow (everything dumped at t=0 then frozen), no screensaver (many elements floating on their own).
- **Safe area** — all content above y = 900 px; side margins ≥ 100 px.

## Frame 1 — Hook

- src: compositions/frames/01-hook.html
- duration: 4s
- transition_in: cut
- status: animated
- scene: "audio editing is miserable." slams in over a jittery, clipping, glitching waveform on the dark stage
- voiceover: (none — no narration; the on-screen copy below carries the story, timed to the music beats)
- type: hook
- beat: frustration
- blueprint: kinetic-type-beats (Adapt)
- focal: the line "audio editing is miserable."
- roles: generated SVG/DOM waveform = background band (no image asset)
- asset_candidates: assets/brand/logo.svg — not shown in this frame (listed only so the frame has a candidate; do not place it)
- sfx: none
- music_hits: 0.0 impact + crash · kicks on every 0.5 · stutter glitch 1.75–2.0 · claps 2.5 and 3.5 · stutter glitch 3.5–4.0

On-screen copy (exact, lowercase): line 1 `audio editing` · line 2 `is miserable.`

Adapt: keep the kinetic-type-beats signature (the statement builds across beats, each piece slamming in on its own beat); the "set" is a broken waveform instead of a bare canvas, and the glitch is the hook's texture.

Scene 1 (0.0–0.5s): Dark register ground #0A110C, full bleed. A wide waveform band of ~110 rounded vertical bars (bar width ~10px, gap ~6px) spans x 100–1820 centred on y ≈ 720 (band height up to ~300px, mirrored above/below its centre line). Bars are wave-dim #385C46 with the tallest third in wave green #31D685; visible from frame 0. Bar heights are a deterministic index-seeded pattern that STEPS to a new pattern on every beat (0.0, 0.5, 1.0 …) and decays slightly between beats, so the waveform jerks to the kick. 6–8 bars per beat "clip": they hit the band ceiling and turn amber #FFBC79 for that beat. At exactly 0.0, `audio editing` slams in (display ~150px, white, left-aligned at x = 120, baseline ≈ y 360) with a 3-frame RGB-split glitch entrance (wave green and amber offset copies, ±8px, then snap clean) → `kinetic-beat-slam` entrance; for the RGB split read the installed component `compositions/components/rgb-glitch-text.html` and build the same mechanics inline.
Scene 2 (1.0–1.75s): On the beat at 1.0, `is miserable.` slams in on the line below (same size, white, baseline ≈ y 530). From then on the word `miserable.` jitters on every frame (deterministic, ±2–3px x/y, tiny ±0.6° rotation) — the nervous tic. Waveform keeps stepping on 1.0 and 1.5.
Scene 3 (1.75–2.0s): Glitch burst synced to the music stutter: the full frame is cut into 5–6 horizontal bands that shift sideways ±30–60px (alternating directions, index-based), the text gets the RGB split again, and the waveform bars repeat their last pattern 2× (stutter). Snap back clean at 2.0.
Scene 4 (2.0–3.5s): Held read. Copy holds; `miserable.` keeps its jitter; waveform steps on 2.0, 2.5, 3.0 with clipping bars flashing amber. No camera move.
Scene 5 (3.5–4.0s): Bigger glitch synced to the second stutter: bands shift wider (±80px) in a faster 1/16-beat stutter, the RGB split widens on both lines, and in the last 4 frames the waveform collapses to a flat line (heights → 2px). The cut to Frame 2 happens at 4.0 on the next slam.

## Frame 2 — Pain

- src: compositions/frames/02-pain.html
- duration: 4s
- transition_in: cut
- status: animated
- scene: "upload limits." "signup walls." "watermarks." each slam in on a beat and get struck through in amber, then the stack sags like a tape stop
- voiceover: (none — no narration; the on-screen copy below carries the story, timed to the music beats)
- type: pain_point
- beat: frustration
- blueprint: kinetic-type-beats (Adapt)
- focal: the three struck-through pain phrases
- roles: ghost UI artifacts (generated DOM, ~20% opacity) = supporting background flavour
- asset_candidates: assets/brand/logo.svg — not shown in this frame (listed only so the frame has a candidate; do not place it)
- sfx: none
- music_hits: thud 0.0, 1.0, 2.0 (word slams) · scratch 0.5, 1.5, 2.5 (strikes) · kicks every 0.5 · claps 0.5, 1.5, 2.5, 3.5 · tape stop 3.5–4.0 (music slows to a halt)

On-screen copy (exact, lowercase): `upload limits.` · `signup walls.` · `watermarks.`
Reference component (read it for the strike mechanics, then build your own in this frame): `compositions/components/strikethrough-replace.html`.

Adapt: keep the signature (3 short pain statements, each landing alone on its beat); add the strike-through as each statement's payoff.

Scene 1 (0.0–1.0s): Dark ground ink #0F1611 full bleed. At 0.0 `upload limits.` slams in (display ~140px, white, left-aligned x = 120, baseline ≈ y 270) → `kinetic-beat-slam` (scale 1.25→1, 2-frame micro-shake). Behind it, a ghost artifact at ~20% white opacity, right side (x 1150–1750, y 180–300): a thin progress bar stuck at 99% with a small mono label `uploading… 99%`. At 0.5 an amber #FFBC79 strike bar (10px tall, rotated −2°) draws left→right through the phrase at its x-height centre in ~0.18s → `css-marker-patterns` (strike). Once struck, the phrase dims to 55% opacity.
Scene 2 (1.0–2.0s): At 1.0 `signup walls.` slams in on the next line (baseline ≈ y 490). Ghost artifact (~20%): an outlined modal box (x 1200–1700, y 380–560, 1.5px white line, radius 12) with a mono line `create an account to continue`. At 1.5 its amber strike draws; phrase dims to 55%.
Scene 3 (2.0–3.0s): At 2.0 `watermarks.` slams in (baseline ≈ y 710). Ghost artifact: the word `WATERMARK` in mono, tiled diagonally (−20°) across the whole frame at ~7% opacity, fading in over 0.15s. At 2.5 its amber strike draws; phrase dims to 55%.
Scene 4 (3.0–3.5s): Held read: three struck lines, subtle jitter only.
Scene 5 (3.5–4.0s): Tape-stop sag synced to the music: the whole stack drops ~40px with an easing that slows to a halt (power2.out), gains ~3px vertical blur and desaturates to grey by 3.95s. This is part of the shot (not an exit); the cut to Frame 3 lands at 4.0.

## Frame 3 — Turn

- src: compositions/frames/03-turn.html
- duration: 2s
- transition_in: cut
- status: animated
- scene: hard cut to clean white; "so we fixed it." sits alone while the riser builds
- voiceover: (none — no narration; the on-screen copy below carries the story, timed to the music beats)
- type: product_intro
- beat: relief
- blueprint: titlecard-reveal (Adapt)
- focal: the line "so we fixed it."
- roles: generated underline line = supporting
- asset_candidates: assets/brand/logo.svg — not shown in this frame (listed only so the frame has a candidate; do not place it)
- sfx: none
- music_hits: 0.0 one clean bell chord over near-silence · riser 0.5–1.95 · snare roll 1.0–1.95 accelerating · 1.95–2.0 silence (the drop lands at the start of Frame 4)

On-screen copy (exact, lowercase): `so we fixed it.` — the word `fixed` in brand green #006E3D, the rest ink #0F1611.

Adapt: keep the titlecard-reveal signature (one clean title, ONE restrained move, then a still hold); the move is a fast per-word reveal on the bell, and the hold carries a line that draws with the riser.

Scene 1 (0.0–0.4s): White register #FFFFFF full bleed — the first light frame after 8 seconds of dark, so the cut itself is the relief. `so we fixed it.` reveals word-by-word, 4 words at 0.0 / 0.07 / 0.14 / 0.21 (each from y +24px and opacity 0 → settle, expo.out), display ~170px, left-aligned at x = 120, vertically centred around y ≈ 470. `so` must be visible on frame 0.
Scene 2 (0.5–1.95s): Still title. Under it (y ≈ 600), a 6px brand-green #006E3D line draws left→right from x = 120 to x = 1800 in step with the riser, accelerating (power2.in), reaching the right edge at 1.9 → `svg-path-draw` (or a scaleX wipe). Nothing else moves.

## Frame 4 — Wordmark

- src: compositions/frames/04-wordmark.html
- duration: 2s
- transition_in: cut
- status: animated
- scene: on the drop, the ihateaudio logo slams in on bottle green, its bars spring up like a level meter, the wordmark cascades in
- voiceover: (none — no narration; the on-screen copy below carries the story, timed to the music beats)
- type: branding
- beat: punchline
- blueprint: logo-assemble-lockup (Adapt)
- focal: assets/brand/logo.svg
- roles: logo.svg = cutout (hero mark, rebuilt as inline SVG so its bars can animate) · wordmark = live text
- asset_candidates: assets/brand/logo.svg — the ihateaudio logo mark: 32-unit viewBox, tile #0C3524 rx 7, five rounded bars #38E08F at x 4/9/14/19/24 (w 3), heights 8/16/30/14/8, middle bar overflows the tile
- sfx: none
- music_hits: 0.0 DROP (big impact + crash, full groove starts) · kicks 0.0, 0.5, 1.0, 1.5 · claps 0.5, 1.5

On-screen copy (exact): wordmark `ihateaudio` — `i` and `audio` white, `hate` wave green #31D685; Instrument Sans 700, tracking −0.03em.

Adapt: keep the signature (the mark comes to exist on screen from parts and resolves into a centred lockup); the parts are the logo's five bars springing up like an audio level meter on the drop.

Scene 1 (0.0–0.45s): Green register: ground brand #006E3D full bleed, visible at frame 0. At 0.0 the logo tile (inline SVG copy of logo.svg, rendered ~250px square) slams in at the left of a centred lockup (scale 1.35→1.0, expo.out, 2-frame shake) → `spring-pop-entrance` (smooth settle, no overshoot). Its five bars grow from 0 height to full in a left→right stagger (0.04s apart), the middle bar last, overshooting the tile top and bottom exactly as in the logo.
Scene 2 (0.15–0.75s): The wordmark `ihateaudio` (~210px, white with `hate` in #31D685) cascades in letter by letter to the right of the mark (each letter from y +50px, opacity 0 → settle, 0.035s stagger, power3.out). The lockup (mark + gap ~48px + word) is centred horizontally at y ≈ 470.
Scene 3 (0.75–2.0s): Held lockup. The logo's five bars pulse with the kick on 1.0 and 1.5 (each bar's height jumps +18% and settles back within 0.25s, staggered 0.02s) — the mark is a live meter. Nothing else moves.

## Frame 5 — Count

- src: compositions/frames/05-count.html
- duration: 2.5s
- transition_in: cut
- status: animated
- scene: a counter races to 49 while all 49 real tool icons pop into a 7x7 grid; "audio tools." lands, then "free." stamps in amber
- voiceover: (none — no narration; the on-screen copy below carries the story, timed to the music beats)
- type: feature_showcase
- beat: scale
- blueprint: dataviz-countup (Adapt)
- focal: the number 49
- roles: assets/icons/*.png = supporting (the 49-icon grid, right half)
- asset_candidates: assets/icons/audio-trimmer.png — 3D tool icon (all 49 icons live in assets/icons/, 256x256 RGBA PNG, one per tool; use every file in this order: audio-trimmer audio-joiner audio-splitter silence-remover fade-in-out audio-reverser audio-looper crossfade-joiner audio-converter mp3-converter wav-converter m4a-converter ogg-converter flac-converter video-to-audio audio-compressor sample-rate-converter volume-booster audio-normalizer dynamic-compressor stereo-to-mono stereo-widener loudness-meter speed-changer pitch-shifter tempo-changer slowed-reverb nightcore-maker reverb-adder echo-adder equalizer 8d-audio-maker voice-changer bpm-detector key-finder waveform-generator voice-recorder ringtone-maker android-ringtone-maker send-audio-by-email send-audio-on-discord send-audio-on-whatsapp vocal-remover acapella-extractor stem-splitter audio-transcriber subtitle-generator noise-remover)
- sfx: none
- music_hits: 0.0–1.0 eight rising ticks on the 16ths (0.0, 0.125 … 0.875) · 1.0 thud + crash ("49" lands) · 1.5 thud ("free." lands) · kicks every 0.5

On-screen copy (exact): `49` · `audio tools.` · `free.`

Adapt: keep the dataviz-countup signature (one statistic counts up and IS the hero); instead of a chart, the count drives a grid of the real icons filling in.

Scene 1 (0.0–1.0s): Dark register ground #0A110C. Left column (x 120–960): the number counts 0 → 49 in integer steps, accelerating (power2.in) so 49 lands exactly at 1.0; its size grows with the value (from ~60% to 100% of ~400px, white, tabular numerals, tracking −0.05em, baseline ≈ y 520) → `counting-dynamic-scale`. Right side: a 7×7 grid of the 49 icons (each ~84px, gap ~14px; grid ≈ 674px square at x 1100–1774, y 110–784). Icon k pops in (scale 0.3→1, opacity 0→1, 0.12s, power3.out) at the moment the counter passes k, in reading order, so the grid fills in lockstep with the number. Number and grid both start on frame 0 (the first icon and "0" visible at 0.0).
Scene 2 (1.0–1.5s): At 1.0 `49` is final; the whole grid gives one punch (scale 1.0 → 1.05 → 1.0 over 0.25s); `audio tools.` slams in under the number (~110px, white, left x = 120, baseline ≈ y 660) → `kinetic-beat-slam`.
Scene 3 (1.5–2.5s): At 1.5 `free.` stamps in under `audio tools.` (~230px, amber #FFBC79, baseline ≈ y 880 — keep the glyphs above y 900; slam from scale 1.6 → 1.0 with a 3-frame shake, rotation −3° → −3°). Hold everything to 2.5 with subtle jitter on `free.` only.

## Frame 6 — Montage

- src: compositions/frames/06-montage.html
- duration: 12s
- transition_in: cut
- status: animated
- scene: eight real tool pages whip through on the beat, each with a one- or two-word label slammed over it and an amber playhead running across its real waveform
- voiceover: (none — no narration; the on-screen copy below carries the story, timed to the music beats)
- type: feature_showcase
- beat: breadth
- blueprint: device-surface-showcase (Adapt)
- focal: the current tool screenshot card
- roles: each assets/montage/*.jpg = cutout (hero card, one at a time) · label block = foreground · URL chrome = supporting
- asset_candidates: assets/montage/audio-trimmer.jpg — Audio Trimmer page, selection active; assets/montage/audio-converter.jpg — Audio Converter page; assets/montage/vocal-remover.jpg — Vocal Remover page; assets/montage/slowed-reverb.jpg — Slowed + Reverb page; assets/montage/audio-transcriber.jpg — Audio Transcriber page; assets/montage/ringtone-maker.jpg — iPhone Ringtone Maker page, 30 s selection active; assets/montage/bpm-detector.jpg — BPM Detector, waveform + "120.0" result card; assets/montage/bass-booster.jpg — Bass Booster page
- sfx: none
- music_hits: a whoosh peaks exactly on every cut at 0.0, 1.5, 3.0, 4.5, 6.0, 7.5, 9.0, 10.5 plus a tick on each cut · kicks every 0.5 · 16th-note arp throughout

All 8 images are 2240×1260 (16:9) real captures with a real decoded waveform in the dark stage. Show each as a card 1400×788 (object-fit: cover, border-radius 16px, 1px #DEE3E0 border, one soft shadow `0 24px 60px -20px rgba(15,22,17,.35)`).

Shots (local start → end, label exact, URL chrome exact, card side, playhead span as % of the IMAGE width/height):

| # | time | label | URL chrome | image | card | playhead x-range | waveform y-range |
|---|------|-------|------------|-------|------|------------------|------------------|
| 1 | 0.0–1.5 | `trim.` | `ihateaudio.com/audio-trimmer` | assets/montage/audio-trimmer.jpg | right | 23% → 60% | 45% – 88% |
| 2 | 1.5–3.0 | `convert.` | `ihateaudio.com/audio-converter` | assets/montage/audio-converter.jpg | left | 10% → 80% | 45% – 88% |
| 3 | 3.0–4.5 | `remove vocals.` | `ihateaudio.com/vocal-remover` | assets/montage/vocal-remover.jpg | right | 10% → 80% | 45% – 88% |
| 4 | 4.5–6.0 | `slowed + reverb.` | `ihateaudio.com/slowed-reverb` | assets/montage/slowed-reverb.jpg | left | 10% → 80% | 45% – 88% |
| 5 | 6.0–7.5 | `transcribe.` | `ihateaudio.com/audio-transcriber` | assets/montage/audio-transcriber.jpg | right | 10% → 80% | 45% – 88% |
| 6 | 7.5–9.0 | `ringtones.` | `ihateaudio.com/ringtone-maker` | assets/montage/ringtone-maker.jpg | left | 35% → 79% | 45% – 88% |
| 7 | 9.0–10.5 | `bpm + key.` | `ihateaudio.com/bpm-detector` | assets/montage/bpm-detector.jpg | right | 10% → 80% | 8% – 50% |
| 8 | 10.5–12.0 | `bass boost.` | `ihateaudio.com/bass-booster` | assets/montage/bass-booster.jpg | left | 10% → 80% | 45% – 88% |

Adapt: keep the device-surface-showcase signature (real product screens held as the hero while they cycle through the real surface — the showcase-carousel variant); the "device" is a flat card of the real page, and the cycle is a beat-locked whip carousel.

Scene 1 (0.0–1.5s, shot 1): White register: ground surface #F5F8F6 full bleed. "right" card = x 400–1800, y 96–884; "left" card = x 120–1520, y 96–884. At 0.0 card 1 whips in from the right (x +700px → 0 in 0.28s, expo.out) with a horizontal motion-blur streak over its first ~0.12s → `motion-blur-streak`. At 0.08 the label block slams in, anchored on the side opposite the card and overlapping the card edge: a brand-green #006E3D block (padding 18px 32px, radius 0) holding the label in white display ~130px lowercase; for a "right" card it sits lower-left (left x = 100, bottom ≈ y 860); for a "left" card it sits upper-right (right edge x = 1820, top ≈ y 130). The block wipes open from its anchored edge (scaleX 0→1, 0.14s, expo.out), text visible as it opens. Mono URL chrome (ink-2 #515954, ~22px, uppercase not needed — keep lowercase as written) at top-left x = 120, y ≈ 56 swaps by hard cut on each shot. From 0.15 to the shot end, an amber #FFBC79 playhead (4px wide, full waveform y-range, small 12px amber triangle cap on top) travels across the card's waveform from the shot's start % to end % (linear) — positions are percentages of the card image box. During the shot the card itself makes one short decelerating push-in (scale 1.0 → 1.025, done by 0.9s) then stays still.
Scene 2–8 (each at its start time from the table): same mechanics with that shot's image, label, URL, side and playhead span. Every shot change is a cut-the-curve seam (see `cut-catalog.md`): in the last 0.1s of a shot the outgoing card and label accelerate left (x −500px, blur), and the incoming card enters from the right on the beat — one continuous right→left direction for the whole carousel, matched to the whoosh in the music. Shot 8 does NOT exit: it holds still from ~11.0 to 12.0 (the hard cut to Frame 7 ends it).

## Frame 7 — Promise

- src: compositions/frames/07-promise.html
- duration: 4s
- transition_in: cut
- status: animated
- scene: a real tool page in a minimal browser window; "runs right in your browser." then "your file never leaves your device." while an upload-to-cloud path gets struck out and the window is traced in green
- voiceover: (none — no narration; the on-screen copy below carries the story, timed to the music beats)
- type: benefit_highlight
- beat: trust
- blueprint: compose
- focal: assets/pages/trimmer-page.jpg
- roles: trimmer-page.jpg = cutout (inside the browser window, top-aligned, cover) · cloud glyph + dashed path = supporting (generated SVG)
- asset_candidates: assets/pages/trimmer-page.jpg — full 1920x1080 viewport of the real Audio Trimmer page (2400x1350 file) with wordmark header, title, dark waveform stage (waveform canvas at x 22%–78%, y 33%–58% of the image), selection controls
- sfx: none
- music_hits: 0.0 whoosh peak, breakdown (no kick) 0.0–2.0 · kick returns 2.0, 2.5, 3.0, 3.5 · riser 3.0–4.0

On-screen copy (exact, lowercase): line 1 `runs right in your browser.` (the word `browser.` in brand green #006E3D) · line 2 `your file never leaves your device.` (the words `never leaves` in brand green #006E3D). Browser URL pill text: `ihateaudio.com/audio-trimmer`.

Compose (no blueprint fits a two-line promise with a diagram): white register, text left, browser window right; reveals on the beats.

Scene 1 (0.0–0.6s): White ground #FFFFFF. Line 1 reveals word by word (0.0, 0.06, 0.12, 0.18, 0.24; from y +20px, expo.out), ink #0F1611, h1 ~92px, left-aligned x = 120, max width 820px, top ≈ y 250 (wraps to 2 lines). At 0.1 the browser window rises in on the right (y +60px → 0, opacity 0→1, 0.4s, power3.out): window x 980–1820, y 200–740 (840×540), radius 16px, 1px #DEE3E0 border, white top bar 44px with three #DEE3E0 dots and a centred URL pill (surface #F5F8F6, mono ~18px ink-2) reading `ihateaudio.com/audio-trimmer`; below the bar, trimmer-page.jpg fills the window (cover, top-aligned). One soft shadow allowed.
Scene 2 (0.6–2.0s): Held read of line 1. Inside the window an amber #E18518 playhead (3px) travels across the screenshot's waveform canvas (x 22% → 70% of the image, y 33%–58%), linear — the page is "working".
Scene 3 (2.0–3.0s): On 2.0 line 1 dims to 35% ink and line 2 reveals word by word below it (0.06s stagger, same style, ~76px, top ≈ y 520, max width 820px). At 2.2 above the window, centred on x ≈ 1400, y ≈ 110, an outline cloud with an up-arrow (ink-2 #515954 stroke 3px, ~110px wide) and a dashed line (ink-2, 3px, dash 10/10) from the window's top edge up to the cloud draw themselves over 0.4s → `svg-path-draw`.
Scene 4 (3.0–4.0s): On the beat at 3.0 an amber #E18518 strike bar (10px, rotated −12°) slashes through the cloud and the dashed line in 0.15s (the same strike as Frame 2, now on the upload); the cloud and dashes fade to 30%. At 3.2 a 4px brand-green #006E3D outline traces around the browser window (svg-path-draw, perimeter, 0.6s, power2.inOut). Hold to 4.0.

## Frame 8 — Stack

- src: compositions/frames/08-stack.html
- duration: 3s
- transition_in: cut
- status: animated
- scene: "no signup." "no watermark." "no limits." slam in one per beat on bottle green
- voiceover: (none — no narration; the on-screen copy below carries the story, timed to the music beats)
- type: benefit_highlight
- beat: release
- blueprint: kinetic-type-beats (Adapt)
- focal: the three-line stack
- roles: none (type only)
- asset_candidates: assets/brand/logo.svg — not shown in this frame (listed only so the frame has a candidate; do not place it)
- sfx: none
- music_hits: 0.0 impact + crash (groove back) · 1.0 thud · 2.0 thud · kicks every 0.5 · claps 0.5, 1.5, 2.5

On-screen copy (exact, lowercase): `no signup.` · `no watermark.` · `no limits.` — the word `no` in wave green #31D685, the rest white.

Adapt: keep the kinetic-type-beats signature (a statement builds across full-screen beats, each slam its own move) — the answer to Frame 2's three pains, one per beat.

Scene 1 (0.0–1.0s): Green register ground #006E3D, full bleed. At 0.0 `no signup.` slams in (display ~170px, left-aligned x = 120, baseline ≈ y 300) → `kinetic-beat-slam` (scale 1.3→1.0, expo.out, 2-frame shake).
Scene 2 (1.0–2.0s): At 1.0 `no watermark.` slams in on the next line (baseline ≈ y 520). The line above gives a 2-frame 6px down-punch on the hit.
Scene 3 (2.0–3.0s): At 2.0 `no limits.` slams in (baseline ≈ y 740); same punch on the lines above. Hold to 3.0 with subtle jitter only.

## Frame 9 — End card

- src: compositions/frames/09-endcard.html
- duration: 4s
- transition_in: cut
- status: animated
- scene: the ihateaudio lockup on clean white, the URL in a green pill, "49 free audio tools" underneath; held to read
- voiceover: (none — no narration; the on-screen copy below carries the story, timed to the music beats)
- type: cta
- beat: resolution
- blueprint: logo-assemble-lockup (Adapt)
- focal: assets/brand/logo.svg
- roles: logo.svg = cutout (rebuilt as inline SVG so its bars can grow) · URL pill + line = supporting
- asset_candidates: assets/brand/logo.svg — the ihateaudio logo mark: 32-unit viewBox, tile #0C3524 rx 7, five rounded bars #38E08F at x 4/9/14/19/24 (w 3), heights 8/16/30/14/8, middle bar overflows the tile
- sfx: none
- music_hits: 0.0 final impact + crash + one big chord that rings out · 0.5 soft bell · the music fades to silence by 4.0

On-screen copy (exact): wordmark `ihateaudio` (`i` and `audio` ink #0F1611, `hate` brand green #006E3D) · URL pill `ihateaudio.com` · small line `49 free audio tools`.

Adapt: keep the signature (the mark comes to exist from its parts and resolves into a centred lockup extended to the URL end card). This is the FINAL frame: it holds to the end; no exit motion needed (the music fades out).

Scene 1 (0.0–0.5s): White ground #FFFFFF. At 0.0 the logo tile (inline SVG copy of logo.svg, ~170px) scales in (0.7 → 1.0, power3.out) and its five bars grow from 0 in a left→right stagger (middle bar last, overflowing the tile) → `spring-pop-entrance` (smooth settle). The wordmark `ihateaudio` (~170px, Instrument Sans 700, tracking −0.03em) cascades in letter by letter to its right (0.03s stagger, from y +40px). The lockup is centred horizontally at y ≈ 400.
Scene 2 (0.5–1.0s): At 0.5 (the bell) the URL pill wipes open from its centre (scaleX 0 → 1, 0.3s, expo.out): brand-green #006E3D pill, radius 999px, padding 18px 44px, white text `ihateaudio.com` ~64px Instrument Sans 600, centred at y ≈ 620.
Scene 3 (1.0–1.4s): At 1.0 `49 free audio tools` fades up (y +12px → 0) in ink-2 #515954, ~40px, centred at y ≈ 740.
Scene 4 (1.4–4.0s): Still hold for reading. No camera move, no breathing.

---

# v2 "or." (16 Oct 2026, approved, built)

Deadpan. White page, ink text, Instrument Serif for every caption and card, brand green as
the only accent. Captions sit in a white pill at the bottom centre. Global times:

| Time | Scene file | Picture | Sound |
|---|---|---|---|
| 0.000–8.000 | `compositions/v2/s1-usual.html` | An invented, cluttered audio site (logo redacted, no real brand). Upload crawls 11→13%, a PRO pop-up, a sign-up wall, then "download starts in 30 seconds" (30, 29, 28). Captions: "you want to cut ten seconds off a voice memo." · "first, it uploads." · "then, an account." · "then, a countdown." | Hold music, phone-filtered, a little too loud |
| 8.000–9.800 | `s2-or.html` | White. "*or.*" appears at 8.3, no motion. | Hold music stops dead at 8.0. Silence. |
| 9.800–19.505 | `s3-trim.html` | Real trimmer session: the cursor drops `voice-memo.mp3`, drags the start handle past the fumbling to 0:10.15, plays, downloads; the site's "Saved" bar. Caption: "that's it. that's the whole thing." | The trimmer's output: "Hi, it's me. The meeting moved to three." |
| 19.505–30.335 | `s4-vocals.html` | Real vocal remover session: drop the song, press Separate, a white card "*18 seconds later.*" (the real wait), the mixer plays both halves, the cursor mutes the vocal. Caption: "also removes vocals." | The page's own music + vocal halves; the vocal stops on the Mute click |
| 30.335–33.035 | `s5-quick.html` | Slowed + reverb, iPhone ringtone maker, BPM detector (133.3), 0.9 s each. Caption: "and 47 other things." | Slowed + reverb output, then the song |
| 33.035–36.435 | `s6-free.html` | "49 audio tools." / "*free forever.*" (green) / "no upload. no account. no countdown." | Funk beat starts; lines land on its hits at 0.72 and 1.40 s |
| 36.435–40.035 | `s7-end.html` | Logo + wordmark, "ihateaudio.com", "*free forever.*" | Funk beat fades out by 40.0 |

Edit points inside each tool scene (take time → scene time, playback rates) are written
at the top of each scene file.
