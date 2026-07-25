# Deploying

Static output, no server, no runtime. Cloudflare Pages is the right host: free
static bandwidth, headers and redirects from files in the repo, and the option
of a Worker later for the PostHog proxy.

## What you have to do by hand

Six things. Nothing else in this list is optional if you want the analytics and
the search data to work.

### 1. Cloudflare Pages project

Connect the repo and set:

| Setting | Value |
|---|---|
| Framework preset | Astro |
| Build command | `npm run build` |
| Build output directory | `dist` |
| Node version | `22` (set `NODE_VERSION=22` as a build variable) |

The build runs `astro check`, regenerates the app icons and launch images from
`src/assets/logo.svg`, builds the site, then renders the 42 social cards. It
needs Chromium, which the Pages image already has because Playwright is a dev
dependency; if a build ever fails on a missing browser, add
`npx playwright install --with-deps chromium` to the build command.

### 2. Domain

Add `ihateaudio.com` and `www.ihateaudio.com` in Pages, then pick one as
canonical. Everything in the code assumes the apex (`https://ihateaudio.com`),
which is what `src/consts.ts` sets and what the sitemap and every canonical tag
emit. Redirect www to apex with a Bulk Redirect or a Page Rule.

### 3. Environment variables

Set these in Pages under Settings, Environment variables, for **Production**.
The `PUBLIC_` prefix is what makes Astro inline them at build time, so a change
needs a redeploy to take effect.

| Variable | Where it comes from | If unset |
|---|---|---|
| `PUBLIC_GA_ID` | GA4 Admin, Data streams, your web stream. Looks like `G-XXXXXXXXXX` | No GA at all |
| `PUBLIC_POSTHOG_KEY` | PostHog project settings, Project API key. Looks like `phc_...` | No PostHog at all |
| `PUBLIC_POSTHOG_HOST` | `https://a.tenmiracle.com` | Defaults to that anyway |
| `PUBLIC_GOOGLE_VERIFICATION` | Search Console, HTML tag method, the `content` value only | No verification tag |

Nothing is emitted when a value is missing. That is deliberate: local dev and
the test suite make zero third-party requests, so the suite cannot go flaky
because someone else's CDN had a bad minute.

### 4. PostHog project

**Do not reuse the CapCut GPT key.** That project's key is what the MCP
connector is pointed at, and sending this site's events there would mix two
products' funnels together permanently.

1. Create a new project in the Ten Miracle org, named `ihateaudio`.
2. Copy its `phc_...` Project API key into `PUBLIC_POSTHOG_KEY`.
3. Confirm `a.tenmiracle.com` resolves for the new project. A PostHog managed
   reverse proxy is configured per organisation, so if it is already serving
   CapCut GPT it should serve this too. Check by loading
   `https://a.tenmiracle.com/static/array.js` in a browser: a JavaScript file
   means it works, a 404 or an error page means the proxy needs adding for this
   project.

If the proxy is not available, set `PUBLIC_POSTHOG_HOST` to
`https://us.i.posthog.com` to ship, and fix the proxy afterwards. It will cost
you maybe a third of your events to blockers, which is worth knowing rather than
guessing about.

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

Expect **125 unit** and **275 end-to-end**. After the first production deploy,
check by hand:

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
