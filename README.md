# ihateaudio

39 free audio tools that run entirely in the browser. No upload, no account, no
ads, no watermark, no file-size limit.

See [PRODUCT.md](PRODUCT.md) for what this is and who it is for,
[DESIGN.md](DESIGN.md) for the visual system, and [PATTERN.md](PATTERN.md) for
how to add a tool.

## Running it

```bash
npm install
npm run dev
```

| Command | What it does |
|---|---|
| `npm run dev` | Dev server on :4321 |
| `npm run build` | Typecheck, then build to `dist/` |
| `npm run build:fast` | Build without the typecheck |
| `npm test` | Unit tests (Vitest) |
| `npm run test:e2e` | Browser tests (Playwright, desktop + mobile) |

`postinstall` copies the ffmpeg core into `public/ffmpeg/`. It is 31 MB and
gitignored — regenerate it with `node scripts/sync-ffmpeg-core.mjs`.

> **The core must be the ESM build, not UMD.** `@ffmpeg/ffmpeg` always spawns
> its worker with `{ type: 'module' }`, and a module worker has no
> `importScripts`, so the worker loads the core via
> `(await import(coreURL)).default` — which only the ESM build provides. Ship
> the UMD build and every Tier 2 format fails with *"the converter couldn't
> load"* while the rest of the site works perfectly. `tests/e2e/ffmpeg.spec.ts`
> exists to catch exactly this.

## The one architectural decision that matters

**The engine is tiered, so the common path never pays for the rare one.**

ffmpeg.wasm is 31 MB. Routing every tool through it would make the whole site
feel like the competitors it exists to replace, so the tier is chosen per
*output format*, not per tool:

| Tier | Cost | Covers |
|---|---|---|
| 0 — Web Audio API | 0 KB, built into the browser | Decode, trim, gain, fades, speed, pitch, EQ, reverb, panning, silence detection, WAV output |
| 1 — MP3 encoder | ~55 KB gzipped, on first MP3 export | MP3 in, MP3 out — the majority of real traffic |
| 2 — ffmpeg.wasm | 31 MB, on demand, self-hosted | M4A, AAC, OGG, Opus, FLAC, WMA, AIFF, M4R |

Trimming an MP3 and saving it back never touches ffmpeg. A tool page is **55 KB
gzipped** on first visit and **19 KB** after, including the waveform renderer,
transport and encoder plumbing.

## Layout

```
src/
  data/tools.ts        Registry — drives nav, homepage, search, sitemap, chaining
  lib/
    tool.ts            Shared runtime: intake, decode, waveform, transport, export
    conversion.ts      Source-vs-output comparison for the converter pages
    audio/
      decode.ts        File → AudioBuffer, with the iOS memory guards
      dsp.ts           Pure buffer operations (Tier 0)
      stretch.ts       WSOLA time-stretch and pitch shift
      effects.ts       OfflineAudioContext graph effects
      analysis.ts      ITU-R BS.1770-4 loudness, true peak, tempo
      export.ts        The tier router
  components/          ToolShell, ConversionPanel, Icon, Header, Footer
  layouts/             Base (SEO + schema), ToolPage (content + sidebar)
  pages/               One file per tool, plus the reference pages
  styles/              tokens → base → app → tool → site
```

Adding a tool is an entry in `src/data/tools.ts` plus one page file. Everything
else is shared, which is why all 39 behave identically.

## Deploying

Static output — drop `dist/` anywhere. Built for Cloudflare Pages:

- Build command: `npm run build`
- Output directory: `dist`
- `public/_headers` carries the CSP and cache policy

The ffmpeg core is served from our own origin rather than a CDN, so using the
converter still involves no third-party request.

## Tests

**115 unit tests** cover the DSP and analysis maths in Node against a shimmed
`AudioBuffer` — deterministic, and far more precise than driving a browser.

**219 Playwright tests** cover the real thing across desktop and mobile:

- every page returns 200, has one `<h1>`, a title and description within SEO
  length limits, and valid `SoftwareApplication` / `HowTo` / `FAQPage` /
  `BreadcrumbList` structured data
- no two tool pages share a meta description, and every page carries enough
  unique prose to not read as templated
- 24 tools are driven end to end and asserted to produce a playable file —
  including all three engine tiers
- contrast passes WCAG AA, measured against rendered pixels rather than parsed
  from CSS (the tokens are OKLCH, so string-parsing produces garbage ratios)
- nothing overflows horizontally from 320px up, and every touch target clears
  44px on a coarse pointer
- broken, empty and undecodable files each produce a specific message rather
  than a stuck spinner

## Not here yet

Vocal removal, stem separation and transcription need models measured in
hundreds of megabytes. They will ship only if they can run locally like
everything else does.
