# Launch kit — Product Hunt, 14 Oct 2026

Everything a launch or directory form asks for, in one place. Copy is in the brand
voice from PRODUCT.md: blunt, plain, short, no exclamation marks. Character counts
were measured with `String.length` when this was written.

Product Hunt day starts **00:01 PT, 14 Oct 2026 = 12:31 IST, 14 Oct**. The post must
be scheduled before that.

## Assets

| What | File | Size |
|---|---|---|
| PH thumbnail (animated) | `assets/thumbnail/thumbnail-240.gif` | 240×240 |
| PH thumbnail (static) | `assets/thumbnail/thumbnail-240.png` | 240×240 |
| Logo | `assets/thumbnail/logo-512.png`, `logo-1024.png` | square |
| PH gallery, in this order | `assets/gallery/01-hero.jpg` … `07-agents.jpg` | 1270×760 (PNG at 2x beside each) |
| Real screens, with audio loaded | `assets/screens/*.png` | 2880×1800 |
| Social card | `public/og.png` | 1200×630 |
| Launch video (37.5 s) | `../launch-video/out/ihateaudio-launch-16x9.mp4` | 1920×1080 |
| Launch video, square | `../launch-video/out/ihateaudio-launch-1x1.mp4` | 1080×1080 |
| Video poster / YouTube thumbnail | `../launch-video/out/poster.png` | 1920×1080 |

Gallery order and why: 01 says what it is, 02 shows a real tool, 03 is the AI hook,
04 is the under-25 audience, 05 is the breadth, 06 is the promise, 07 is for the
agent crowd that reads Product Hunt. Put the video first in the gallery once it is on
YouTube.

Regenerate: `node marketing/launch/scripts/capture.mjs && node marketing/launch/scripts/gallery.mjs`.

## Product Hunt fields

**Name:** ihateaudio

**Website:** `https://ihateaudio.com/?ref=producthunt`

**Tagline** (60 max). Pick one:

1. `49 free audio tools that run right in your browser` ← recommended
2. `Audio editing is miserable. These 49 free tools fix that.`
3. `Trim, convert, remove vocals. Free, no signup, no upload.`

**Description** (260 max):

> ihateaudio is 49 free audio tools in one place. Trim, convert, normalize, boost,
> slowed + reverb, ringtones, BPM and key, vocal remover, stem splitter and
> transcriber. It all runs in your browser. No signup, no upload, no watermark, no ads.

**Topics** (in this order): Audio · Music · Productivity · Free · Artificial Intelligence

**Pricing:** Free

**Launch tags / "what makes it different":** runs in the browser, no upload, no account,
no watermark, no ads, 49 tools under one roof, local AI (vocal remover, stems,
Whisper transcription), MCP server for agents.

**Shoutouts** (tools the product is built on, if the form asks): FFmpeg (ffmpeg.wasm),
Hugging Face Transformers.js, ONNX Runtime Web, Astro, Cloudflare.

### Maker's first comment

Post it the minute the launch goes live.

> Hey Product Hunt,
>
> I built ihateaudio because every time I needed to cut one MP3, I ended up on a site
> that wanted my file on its server, an account, and my patience for four ads before
> the download button.
>
> So this is the opposite. 49 audio tools in one place, all free:
>
> • Cut and join: trimmer, splitter, silence remover, fades, crossfades
> • Convert: MP3, WAV, M4A, OGG, FLAC, video to audio, compress
> • Fix the sound: normalize to LUFS, volume and bass boost, EQ, compressor
> • Play with it: slowed + reverb, nightcore, 8D, pitch, voice changer
> • Utility: iPhone and Android ringtones, BPM, key, loudness meter, waveform images
> • AI studio: vocal remover, song splitter into stems, transcriber, subtitles, noise remover
>
> Everything runs in your browser tab. Your file is not uploaded. No account, no
> watermark, no ads, no daily limit. The AI tools run on your own device too.
>
> Why is it free? Your computer does the work, so it costs me almost nothing to run.
>
> There is also an MCP server at ihateaudio.com/mcp, so ChatGPT and other agents can
> run the tools for you.
>
> One ask: tell me the one audio job you still do somewhere else. That is the next
> tool I build.

### Replies to have ready

- **"How is it free?"** Your device does the processing, so there is no server bill per
  file. The site is static pages on Cloudflare. That is the whole cost.
- **"Is my file really not uploaded?"** Yes. Open the network tab while you export, or
  load a tool and turn the wifi off. It keeps working. (The MCP server for agents is
  the one exception: an agent sends the file, so it is processed on our server. The
  original is deleted when the job finishes and the result after one day. The privacy
  page says this.)
- **"Why not Audacity?"** Audacity is great if you edit audio every week. This is for
  the person who needs one MP3 cut in 20 seconds and will never open a DAW.
- **"Mobile?"** Yes. It is a PWA, and phones work. Long files are limited by phone memory
  (about 40 minutes of audio at once).
- **"Open source?"** Not now.

## Launch-day posts

Rewrite in your own words before posting. The same text in many places reads as spam.

**X / Threads**

> I got tired of audio sites that upload your file, want an account and show four ads
> before the download.
>
> So I made ihateaudio: 49 free audio tools that run in your browser. Trim, convert,
> slowed + reverb, ringtones, vocal remover, transcriber.
>
> It's live on Product Hunt today: <PH link>

**LinkedIn**

> Today I launched ihateaudio on Product Hunt.
>
> It is 49 free audio tools in one place: trim, convert, normalize to LUFS, remove
> vocals, split a song into stems, transcribe, make ringtones. Everything runs in the
> browser, so files never leave your computer. No account, no watermark, no ads.
>
> Podcasters, teachers and anyone who records voice notes: I want to know which audio
> job still annoys you. <PH link>

**r/SideProject** (title + body, disclose that you built it)

> Title: I built 49 free audio tools that run in the browser (no upload, no signup)
>
> I built this. Every tool is one page: drop a file, fix it, download. Processing runs
> in your tab with Web Audio and ffmpeg.wasm, and the AI tools (vocal remover, stems,
> Whisper transcription) run on your device with ONNX. Happy to answer anything about
> how it works. Launching on Product Hunt today too.

## Directory copy

Use these for every directory, MCP registry and listing form. Same facts every time.

| Field | Text |
|---|---|
| Name | ihateaudio |
| URL | https://ihateaudio.com |
| Contact | support@ihateaudio.com |
| Pricing | Free (no paid tier) |
| Launched | 2026 |
| Platforms | Web (desktop and mobile browsers), installable PWA |
| Categories | Audio · Music · Productivity · Utilities · AI tools |
| Logo | `assets/thumbnail/logo-512.png` |
| Screenshot | `assets/gallery/01-hero.jpg` (or `public/og.png` for 1200×630) |

**Tagline, 50 chars:** `49 free audio tools that run right in your browser`

**One-liner, under 100:** `Trim, convert, normalize, remove vocals and transcribe audio in your browser. Free, no signup.`

**Short description, under 160:**

> 49 free audio tools in your browser: trim, convert, normalize, remove vocals, split
> stems, transcribe. No signup, no upload, no watermark.

**Medium description, under 300:**

> ihateaudio is 49 free audio tools in one place: trimmer, converter, normalizer, bass
> booster, slowed + reverb, ringtone maker, BPM and key finder, vocal remover, stem
> splitter and transcriber. Everything runs in your browser. No signup, no upload, no
> watermark, no ads.

**Long description (about 150 words):**

> ihateaudio is a free set of 49 audio tools that run right in your browser. Drop a
> file in, fix it, download it. There is no account, no upload, no watermark, no ads
> and no daily limit.
>
> Cut and join: trimmer, joiner, splitter, silence remover, fades, crossfades, looper.
> Convert: MP3, WAV, M4A, OGG, FLAC, video to audio, compressor, sample rate.
> Volume: normalize to LUFS for Spotify, YouTube or podcasts, volume and bass boost,
> dynamics compressor, stereo to mono. Speed and pitch: speed, tempo, pitch, slowed +
> reverb, nightcore, voice changer. Effects: reverb, echo, 8D, equalizer, stereo
> widener. Utility: iPhone and Android ringtones, voice recorder, BPM and key finder,
> loudness meter, waveform images. AI studio: vocal remover, acapella extractor, song
> splitter, transcriber, subtitle generator, noise remover. The AI runs on your device.
>
> Every tool also works as an MCP tool, so AI agents such as ChatGPT can use them.

**Feature bullets:**

- 49 tools, one consistent interface
- Runs in the browser: files are not uploaded
- No account, no watermark, no ads, no daily cap
- Local AI: vocal remover, 4-stem splitter, Whisper transcription and subtitles
- Loudness normalization to platform targets (Spotify, YouTube, Apple, podcasts)
- iPhone (M4R) and Android ringtones
- Works offline after the first visit; installable as an app
- MCP server for AI agents: https://ihateaudio.com/mcp

**Tags:** audio editor, mp3 cutter, audio converter, vocal remover, stem splitter,
audio transcription, slowed and reverb, ringtone maker, loudness normalizer, free
tools, privacy, browser tools, mcp

**Alternative to:** 123apps (online-audio-converter.com, mp3cut.net), vocalremover.org,
Audacity, media.io, Kapwing, TwistedWave, Adobe Podcast, Descript (for quick jobs)

## MCP and AI listings

| Field | Text |
|---|---|
| Server name (registry) | `com.ihateaudio/ihateaudio` |
| Endpoint | `https://ihateaudio.com/mcp` (Streamable HTTP, no auth) |
| Description, under 100 | `49 audio tools: trim, convert, normalize, remove vocals, split stems, transcribe, and more.` |
| Data handling | Files an agent sends are staged in Cloudflare R2, processed by the site's own page in a headless browser. The original is deleted when the job finishes; results are deleted after one day. |
| Privacy / terms / support | https://ihateaudio.com/privacy · /terms · /support |

See `DIRECTORIES.md` for where each one goes and what is still blocked.
