# DESIGN.md — ihateaudio

## Theme

**The scene.** A podcaster at 1am with a single browser tab open, cutting eight seconds of
dead air out of an interview before it goes to their editor. Also: a sixteen-year-old on a
school Chromebook at lunch, making a slowed + reverb edit. Both are in a hurry, neither
wants to learn anything, and both are on a bright screen in a browser full of other tabs.

**The decision that follows: the page is white.** Every audio tool in existence is dark —
Audacity, Audition, Descript, the 123apps network, every DAW. Dark *is* the category
reflex, and it carries a promise the product shouldn't make: dark chrome says "this is
professional software that will take a moment to load." A white page says "this is a web
page, it will be instant." That maps to what's actually true here.

**But the workspace is dark.** The waveform panel — and only the waveform panel — is a deep
near-black inset. This isn't contrarianism in reverse; it's functional. Waveforms have far
better contrast on dark, and the inversion draws a hard line between *the page you're on*
and *the thing you're editing*. The dark stage is the single place the eye should go.

So: a white document with one black window cut into it. Calm around the edges, focused in
the middle.

**Color strategy: Restrained.** Tinted near-neutrals, one brand green, one amber accent
reserved almost entirely for the moment a file is ready. Color is state, never decoration.

The green is a deep bottle green, not a bright one — far from the streaming-service green
the hue could drift toward. At L 0.42 it reads as ink with a tint rather than as "a green
brand," which is the point: it should feel like a well-made instrument, not a music app.

## Color

All values OKLCH. Defined in `src/styles/tokens.css`.

### Page surfaces (light)

| Token | Value | Role |
|---|---|---|
| `--bg` | `oklch(1 0 0)` | Page. Literal pure white — no hidden warmth. |
| `--surface` | `oklch(0.976 0.004 162)` | Raised panels, table stripes, inert fills |
| `--surface-2` | `oklch(0.955 0.005 162)` | Pressed / nested fills |
| `--line` | `oklch(0.912 0.006 162)` | Hairlines, dividers, input borders |
| `--line-strong` | `oklch(0.84 0.008 162)` | Emphasized borders, hovered inputs |

### Ink

| Token | Value | Contrast on `--bg` | Role |
|---|---|---|---|
| `--ink` | `oklch(0.19 0.012 162)` | 15.8:1 | Headings, body |
| `--ink-2` | `oklch(0.455 0.012 162)` | 6.6:1 | Secondary text, labels |
| `--ink-3` | `oklch(0.545 0.010 162)` | 4.8:1 | Placeholder, hint — still AA |

`--ink-3` is the floor. Nothing lighter carries text, ever. The most common failure in this
kind of interface is elegant-looking grey that fails AA; the ramp stops before it.

### Brand and state

| Token | Value | Role |
|---|---|---|
| `--brand` | `oklch(0.42 0.095 162)` | Primary actions, active state, selection, links |
| `--brand-hover` | `oklch(0.355 0.095 162)` | Hover / pressed |
| `--brand-soft` | `oklch(0.958 0.022 162)` | Selected row tint, active chip background |
| `--brand-ring` | `oklch(0.42 0.095 162 / 0.32)` | Focus ring halo |
| `--accent` | `oklch(0.70 0.155 62)` | Ready-to-download moment only |
| `--accent-soft` | `oklch(0.965 0.03 62)` | Success banner background |
| `--danger` | `oklch(0.545 0.19 27)` | Errors, destructive |
| `--danger-soft` | `oklch(0.968 0.022 27)` | Error banner background |

White text on `--brand` is 7.4:1. White on `--danger` is 5.1:1. Both pass AA for buttons.
`--accent` is a *background* color for dark ink, never a text color on white.

### Stage (the dark workspace)

| Token | Value | Role |
|---|---|---|
| `--stage` | `oklch(0.168 0.014 162)` | Waveform panel background |
| `--stage-2` | `oklch(0.232 0.014 162)` | Ruler strip, panel chrome |
| `--stage-line` | `oklch(0.30 0.014 162)` | Gridlines, region borders |
| `--stage-ink` | `oklch(0.93 0.006 162)` | Text on stage |
| `--stage-ink-2` | `oklch(0.66 0.008 162)` | Timecodes, secondary — 5.2:1 on stage |
| `--wave` | `oklch(0.735 0.13 162)` | Waveform inside selection |
| `--wave-dim` | `oklch(0.40 0.045 162)` | Waveform outside selection |
| `--playhead` | `oklch(0.85 0.16 62)` | Playhead line — amber, reads instantly on green |

## Typography

**One family: Instrument Sans (variable, self-hosted, latin subset).** A single well-tuned
grotesque carries headings, labels, buttons, and data. Chosen over Inter — which is the
default-by-reflex — for slightly more character in the lowercase without costing legibility
at 13px. Fallback is the system stack, and the metrics are close enough that the swap
doesn't reflow noticeably.

Numerals are **tabular everywhere** (`font-variant-numeric: tabular-nums`). Timecodes that
shift width while playing are the single most visible sign of an amateur audio interface.

### Scale — fixed rem, ratio ~1.2

Product register: no fluid clamp sizing in the UI. Users view at consistent DPI and a
heading that shrinks inside a panel looks broken, not responsive.

| Token | Size | Line height | Use |
|---|---|---|---|
| `--t-micro` | 0.75rem / 12px | 1.35 | Badges, unit labels |
| `--t-small` | 0.8125rem / 13px | 1.45 | Control labels, timecodes, help |
| `--t-ui` | 0.875rem / 14px | 1.5 | Buttons, inputs, dense UI |
| `--t-body` | 1rem / 16px | 1.65 | Prose |
| `--t-lead` | 1.125rem / 18px | 1.6 | Page subtitle |
| `--t-h3` | 1.3125rem / 21px | 1.35 | Section heads in content |
| `--t-h2` | 1.625rem / 26px | 1.3 | Content headings |
| `--t-h1` | 2.125rem / 34px | 1.2 | Tool page title |
| `--t-display` | 2.75rem → 3.5rem | 1.08 | Homepage hero only (the one fluid step) |

Weights: 400 body, 500 UI/labels, 600 headings and buttons. No 700+ except the wordmark.
Display letter-spacing bottoms out at `-0.025em`; the hero never goes tighter.

Prose is capped at 68ch. `text-wrap: balance` on h1–h3, `pretty` on paragraphs.

## Layout

- Content column: 1120px max, 100% under that, 20px gutters (16px below 480px).
- Prose column inside content: 68ch.
- Tool workspace spans the full content column; controls sit in a 2-column grid above
  768px and stack below.
- Responsive behavior is **structural** — the control grid collapses, the header nav
  becomes a sheet, the tool grid reflows via `repeat(auto-fit, minmax(240px, 1fr))`.
  Typography does not fluidly scale.

### Spacing scale

4px base: `4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96`.

### Radii

`--r-sm 6px` (chips, small inputs) · `--r-md 8px` (buttons, inputs) ·
`--r-lg 12px` (cards, panels) · `--r-full 999px` (pills only).
Cards never exceed 12px. Nothing on this site is heavily rounded.

### Elevation

Borders do the work; shadows are reserved for genuinely floating layers.
`--shadow-pop` (dropdowns, 8px blur) and `--shadow-modal` only. Cards get a 1px border and
no shadow — never both.

### Z-index scale

`--z-base 0` · `--z-sticky 100` · `--z-dropdown 200` · `--z-overlay 300` ·
`--z-modal 400` · `--z-toast 500`. No arbitrary values.

## Motion

Product register: 120–260ms, feedback only, no page-load choreography.

| Token | Value | Use |
|---|---|---|
| `--dur-micro` | 120ms | Hover, focus, button press |
| `--dur` | 180ms | Default state change |
| `--dur-panel` | 260ms | Panel/sheet reveal |
| `--ease` | `cubic-bezier(0.25, 1, 0.5, 1)` | ease-out-quart, default |
| `--ease-expo` | `cubic-bezier(0.16, 1, 0.3, 1)` | Panel entrance |

Deliberate motion moments, each tied to a state change:

1. **Dropzone arm** — border and fill shift on dragover; the whole zone lifts 2px.
2. **Waveform draw-in** — bars scale up from the centreline over 260ms when a file decodes.
   This is the "it worked" moment and the one place motion is allowed to be satisfying.
3. **Selection handles** — grow on grab, with the timecode chip fading in above.
4. **Progress** — a real determinate bar. Never a spinner pretending to know.
5. **Export ready** — the download button fills from `--brand` to `--accent` left-to-right
   once, 260ms. Fires once per export, never loops.
6. **Chain bar** — slides up 8px with fade after export completes.

`@media (prefers-reduced-motion: reduce)` collapses all of these to opacity-only crossfades
at 1ms–100ms. The waveform draw-in becomes an instant paint. Nothing is gated behind a
transition — every element's default state is visible, so a headless renderer or a
background tab still ships a complete page.

## Components

Every interactive element ships **default, hover, focus-visible, active, disabled, loading,
and error**. Focus is a 2px `--brand` ring at 2px offset, never removed.

- **Button** — `solid` (brand fill), `quiet` (surface fill, 1px line), `ghost` (text only),
  `danger`. Heights 32/36/44px; 44px is the mobile default so touch targets pass.
- **Dropzone** — the empty state teaches: supported formats, the privacy line, a "try a
  sample" affordance so the tool is explorable with no file.
- **Stage** — dark panel: ruler, waveform canvas, selection region, playhead, transport.
- **Transport** — play/pause, skip to selection edges, loop toggle, timecode, zoom.
- **Control row** — labelled sliders and number inputs with unit suffixes; every slider has
  a paired number input, because dragging on mobile is imprecise.
- **Export bar** — format select, quality select, estimated output size, download button.
- **Chain bar** — appears post-export: "Now: [Convert] [Boost volume] [Add fade]".
- **Error card** — what failed, why, and the concrete next step. Never a bare code.

## Icons

Phosphor, regular weight, 20px default, inlined from a single build-time SVG sprite so only
the ~18 glyphs actually used ship. Stroke inherits `currentColor`.

## Bans specific to this project

- No waveform on a light background. The stage is dark; that's the system.
- No gradient text, no glassmorphism, no decorative grid overlays.
- No spinner where a determinate progress bar is possible — and with local processing, it
  almost always is.
- No modal for anything a panel or inline reveal can do.
- No "your file is ready" interstitial. The download is the download.
