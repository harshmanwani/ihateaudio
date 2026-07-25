# Deploying

Static output, no server, no runtime. Cloudflare Pages is the right host: free
static bandwidth, headers and redirects from files in the repo, and the option
of a Worker later for the PostHog proxy.

## What you have to do by hand

Four things left. The analytics ids and the domain are already done; what
remains is the Pages project itself, Search Console, and mail for the support
address.

### 1. Cloudflare Pages project

Connect the repo and set:

| Setting | Value |
|---|---|
| Framework preset | Astro |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | `22` (set `NODE_VERSION=22` as a build variable) |

The build regenerates the app icons and launch images from
`src/assets/logo.svg`, runs `astro check`, builds the site, then renders the 42
social cards. Generation comes first because `Base.astro` imports the generated
`splash-links.html`, so a clean clone fails the check step otherwise. It
needs Chromium, which the Pages image already has because Playwright is a dev
dependency; if a build ever fails on a missing browser, add
`npx playwright install --with-deps chromium` to the build command.

### 2. Domain

The domain is on Cloudflare already. In the Pages project, add `ihateaudio.com`
and `www.ihateaudio.com`, then pick one as canonical. Everything in the code assumes the apex (`https://ihateaudio.com`),
which is what `src/consts.ts` sets and what the sitemap and every canonical tag
emit. Redirect www to apex with a Bulk Redirect or a Page Rule.

### 3. Environment variables

**Already done.** `.env.production` in the repo carries them, and `astro build`
applies it:

| Variable | Value |
|---|---|
| `PUBLIC_GA_ID` | `G-1S7X0WG2YT` |
| `PUBLIC_POSTHOG_KEY` | `phc_sx8LvUW69VfSwPoNwo8UbG2paXmsCWmVhFLmTuGHYdib` |
| `PUBLIC_POSTHOG_HOST` | `https://a.tenmiracle.com` |
| `PUBLIC_GOOGLE_VERIFICATION` | empty, see below |

Both ids are public by design. A GA4 measurement id and a PostHog project key
appear in the page source of every site that uses them, so they belong in the
repo where a change is visible in a diff, rather than in a dashboard where it is
not. Anything genuinely secret would go in Cloudflare's environment variables,
which override the file if you ever set the same name there.

The file is `.env.production`, not `.env`, on purpose: `astro dev` and the
Playwright suite never load it, so neither makes a single third-party request. A
test asserts that, which is also what stops local development polluting the
production numbers.

**The one still to fill in** is `PUBLIC_GOOGLE_VERIFICATION`, from Search
Console's HTML-tag method. Paste just the `content` value. Until it is set, no
verification tag is emitted at all rather than an empty broken one.

### 4. PostHog proxy

The key is a separate project from CapCut GPT, so the two products' funnels stay
apart. One thing to confirm on the first deploy: load
`https://a.tenmiracle.com/static/array.js` in a browser. A JavaScript file means
the proxy serves this project; a 404 or an error page means it needs adding for
it, because a PostHog managed reverse proxy is configured per project rather than
per organisation.

If it turns out not to be available, set `PUBLIC_POSTHOG_HOST` to
`https://us.i.posthog.com` to ship, and fix the proxy afterwards. Going direct
costs you roughly a third of your events to blockers, which is worth knowing
rather than guessing about.

### 5. Google, beyond Analytics

- **Search Console** is the one that matters, more than GA. Verify the property,
  submit `https://ihateaudio.com/sitemap.xml`, then leave it alone for a month.
  Query data is what turns the next six months of tool choices into evidence.
  Verify the **Domain** property (a DNS TXT record) rather than the URL prefix,
  so it covers www and http without a second property.
- **Bing Webmaster Tools** takes about a minute and imports straight from Search
  Console. It also feeds Copilot, which is worth having given how much of the
  SEO work here is aimed at assistants.
- **Google Analytics**: after creating the stream, turn off Google Signals under
  Admin, Data collection. The site already sends
  `allow_google_signals: false` on every page, but the property-level switch is
  the one that actually governs retention.
- **Skip Google Tag Manager.** It is a second script, a second point of failure
  and a second consent problem, to manage two tags that are already in the repo.
  Add it the day a marketing person needs to add tags without a deploy.

### 6. Email

`support@ihateaudio.com` is in the footer and on every page's contact line, so
it has to receive mail before launch. Cloudflare Email Routing does this free:
Email, Email Routing, add `support@` as a custom address forwarding to your real
inbox. It needs the MX records Cloudflare offers to add for you.

## Already handled in the repo

- **`public/_headers`** carries the CSP, the cache policy per asset class, and
  the CORS headers on `/llms.txt` and `/tools.json` that let assistants read
  them. The CSP allowlists exactly `googletagmanager.com` and
  `a.tenmiracle.com` and nothing else.
- **`public/robots.txt`** names 18 AI crawlers as allowed and points at the
  sitemap.
- **`public/sw.js`** caches the shell and the tool art for offline use, and
  deliberately never caches the 31 MB ffmpeg core.
- **`public/manifest.webmanifest`** plus generated icons, maskable icon, 11 iOS
  launch images and 2 install-dialog screenshots.

## Verifying a deploy

```bash
npm run build && npm run seo
```

Expect **44 pages, 0 errors, 0 warnings**. Then:

```bash
npm test && npx playwright test
```

Expect **125 unit** and **285 end-to-end**. There is also a run against real
files, which is the one that catches what synthetic tones cannot:

```bash
npm run dev
npm run verify -- ~/path/track.mp3 ~/path/second.mp3
```

Expect **38 passed, 1 skipped**. The skip is the voice recorder, which needs a
live microphone.

After the first production deploy, check by hand:

1. `curl -sI https://ihateaudio.com | grep -i content-security` returns the
   policy. If it does not, `_headers` did not ship, and the analytics scripts
   will be silently blocked in some browsers.
2. Open a tool page with the network tab filtered to `a.tenmiracle.com`. One
   request to `/static/array.js` and one to `/i/v0/e/` per event.
3. GA4 Realtime shows the visit.
4. Chrome's install button appears in the address bar. If not, open Application,
   Manifest in devtools: it names the exact field that failed.
5. Load a tool page, turn off the wifi, reload. It should still work. That is the
   service worker, and it is the claim the whole product rests on.

## A note on the AI tools

Model-backed tools will need two things this config does not have yet:

- `connect-src` extended to `https://huggingface.co https://cdn-lfs.hf.co
  https://cdn-lfs-us-1.hf.co` so the weights can be fetched, or the weights
  self-hosted on this domain, which is better for privacy optics and for cache
  control but costs bandwidth.
- `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` **on the AI routes only** if
  multi-threaded WASM is wanted. Site-wide those headers would break the
  cross-origin analytics scripts, so they belong on a path prefix, not on `/*`.
