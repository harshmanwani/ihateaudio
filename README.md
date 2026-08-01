# ihateaudio

49 free audio tools that run entirely in the browser. No upload, no account, no
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
else is shared, which is why they all behave identically.

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

## Analytics and the PWA

Both are configured to not contradict the promise on every other page.

**Analytics** is off unless the ids are set. They live in `.env.production`,
which `astro dev` does not load, so local browsing stays out of production
numbers.

The test suite needs one more step, and it is easy to get wrong: Playwright
builds in production mode, so it *does* load `.env.production`.
`playwright.config.ts` blanks the ids in the webServer environment, because an
empty value in the environment wins over a dotenv file. The
`nothing third-party loads` test is what caught this, after a few hundred
localhost page views had already reached production.

The bootstrap lives in `public/analytics.js`, a same-origin file rather than an
inline block, so `script-src` never needs `'unsafe-inline'` and the CSP stays
strict. What is switched off matters more than what is on: no session replay (a
replay of a tool page would capture filenames, and a filename is content), no
autocapture of anything typed, Do Not Track honoured, no cookie of our own, and
Google's advertising signals disabled. `src/lib/track.ts` sends three product
events, and never a filename, a file size, or a raw duration. Change any of
this and `/privacy` has to change with it; a test asserts that page still
describes reality.

The bootstrap being an external file is also load bearing beyond the CSP: Astro
inlines small hoisted scripts by default, and because `script-src` has no
`'unsafe-inline'`, any inlined script is silently blocked in production while
working perfectly in `astro dev`, which does not apply `public/_headers`. That
shipped once and killed the dropzone's "Choose file" button and the service
worker registration. `vite.build.assetsInlineLimit: 0` prevents it and
`npm run csp` fails the build if it ever returns.

**Installable.** `public/manifest.webmanifest` plus icons, a maskable icon, 11
iOS launch images and 2 install-dialog screenshots, all rendered from
`src/assets/logo.svg` by `scripts/generate-app-icons.mjs` as part of the build.
The install card appears in the corner after twenty seconds, remembers being
dismissed for a month, and never appears once installed. iOS gets different copy
because Safari has no install event to hook, so the only route there is Share,
then Add to Home Screen.

Offline is a real capability rather than a token PWA gesture: every tool runs
client-side, so once a page has been visited it works with no connection. Load a
tool page, turn off the wifi, reload.

## Generated assets

Four scripts produce committed or built artifacts. Only the first two need
network access or a running server.

| Command | Produces | When to run |
|---|---|---|
| `FAL_KEY=... npm run icons` | The 3D tool icons in `public/icons3d` | When a tool is added or its art is wrong |
| `npm run shots` | The 2 install-dialog screenshots (needs `npm run dev`) | When the tool UI changes shape |
| `npm run appicons` | Favicon, app icons, 11 launch images, `splash-links.html` | Automatic, part of `npm run build` |
| `node scripts/generate-og-images.mjs` | The 42 social cards | Automatic, part of `npm run build` |

`scripts/shoot.mjs` is the visual check harness: it loads tool pages, feeds them
generated audio, drives the waveform, and writes screenshots of states that need
a real file in them.

## Checking the tools against real files

The Playwright suite generates synthetic WAV tones in-page, which exercises every
code path but not the messy reality of a real MP3 with an ID3 header, a VBR
bitrate and a duration that does not divide evenly.

```bash
npm run dev
npm run verify -- ~/Desktop/track.mp3 ~/Desktop/second.mp3
```

That drives the real file input, presses each tool's own button, captures what
the browser downloads, and then decodes the download back to confirm it is audio
of a plausible length that is not silent. Analysis tools are checked for rendered
measurements instead, the splitter for a list of real parts, and the waveform
generator for actual PNG magic bytes. Pass `--only slug,slug` to narrow it while
fixing something. The second file is what exercises the two joiners.

## Not here yet

Vocal removal, stem separation and transcription need models measured in
hundreds of megabytes. They will ship only if they can run locally like
everything else does.
