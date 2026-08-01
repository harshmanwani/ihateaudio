# SEO

Run the audit against the built output at any time:

```bash
npm run build && npm run seo
```

It reads `dist/`, because what ships is what gets crawled. Current state: **44
pages, 0 errors, 0 warnings.**

## What is in place

**Per-page metadata.** Every page has a unique title under 60 characters, a
unique description in the 70–160 range, exactly one `<h1>`, an absolute
canonical, and a `lang` attribute. Uniqueness is enforced by tests, not just
convention, because duplicate descriptions across near-neighbour tool pages
is the most likely way this site would get flattened in search.

**Structured data**, emitted on every page:

| Type | Where | Why |
|---|---|---|
| `Organization` | every page | One canonical entity for search and assistants to attach facts to |
| `WebSite` + `SearchAction` | every page | Lets a results page offer a search box into our own search |
| `SoftwareApplication` | tool pages | Declares free price, browser platform, and the feature list |
| `HowTo` | tool pages | The numbered steps, eligible for step-by-step rich results |
| `FAQPage` | tool pages, homepage | The single highest-CTR rich result for this kind of query |
| `BreadcrumbList` | every page but home | Replaces the bare URL in the SERP with a readable path |
| `AboutPage` / `WebPage` | about, privacy | So they are not schema-less |
| `Article` | reference pages | They are documents, not tools |

**Social cards.** 42 distinct 1200×630 PNGs in `public/og`, one per page,
generated from the registry by `scripts/generate-og-images.mjs` and regenerated
as part of `npm run build`. Each carries its own tool name, summary, icon and
category colour. `og:image:width`, `height`, `type` and `alt` are all declared,
so previews reserve space instead of reflowing. A single shared card across 44
pages wastes the most visible surface a shared link has.

**Sitemap.** Hand-built with deliberate priorities (home 1.0, tools 0.9,
reference 0.7, boilerplate 0.3) rather than generated flat, plus an
`image:image` entry per URL pointing at that page's card.

## Being cited by assistants

This is treated as a first-class channel rather than an afterthought, because a
free tool wants to be the answer when someone asks an assistant how to cut an
MP3 without uploading it.

**`/llms.txt`** is a plain-language brief following the llmstxt.org convention.
It leads with the facts that are easiest to get wrong: nothing is uploaded,
there is no account, the real limit is device memory rather than policy, most
tools need no download, and the loudness figures follow ITU-R BS.1770-4. Then it
lists every tool with a one-line summary, and points at the reference pages as
citable material. A test asserts every tool appears, so an assistant cannot
learn a subset.

**`/tools.json`** is a machine-readable index: flat fields, absolute URLs, no
nesting to walk, `Access-Control-Allow-Origin: *`. An agent can answer "what can
this site do" in one request instead of scraping 44 HTML pages. Both files are
advertised from every page via `<link rel="alternate">`.

**AI crawlers are explicitly allowed** in `robots.txt`, named individually
rather than relying on the wildcard, because several of them ignore
`User-agent: *` for training-scope decisions: GPTBot, OAI-SearchBot,
ChatGPT-User, ClaudeBot, Claude-User, Claude-SearchBot, anthropic-ai,
PerplexityBot, Perplexity-User, Google-Extended, Applebot-Extended, CCBot,
Bytespider, meta-externalagent, cohere-ai, DuckAssistBot, MistralAI-User,
YouBot. Most sites block these to protect content they sell; the calculation
here is the opposite.

## The structural bet

**One page per keyword variant, each with genuinely different content.** Nine
converter pages is the highest-risk group on the site: Google demotes templated
pages that exist only to catch keyword variants. Worst-case vocabulary overlap
between any two of them is **22%**, measured, which means they read as distinct
documents. A test enforces a floor of 450 words of unique prose per tool page.

**Reference pages as link bait.** Tool pages rarely earn links.
`/loudness-targets` and `/audio-formats` are written to be cited: a table of
every platform's LUFS target, and an honest format comparison. These are the
pages that lift domain authority for the tool pages.

**Search intent in the copy.** Every tool carries a `keywords` field of real
search vocabulary ("mp4 to mp3", "sped up", "lufs"), used both by on-site search
and by `tools.json`.

**Core Web Vitals as an SEO asset.** A tool page is ~55 KB gzipped and fully
interactive, against 2–4 MB for the incumbents. Images declare dimensions, the
font is preloaded and subset, and there is no layout shift. This is a ranking
input the competitors cannot easily match, because it comes from the
architecture rather than from optimisation.

## Not done, and deliberately so

- **No `aggregateRating` schema.** Inventing review counts would earn stars in
  the SERP and be a lie. Add it when real reviews exist.
- **No `hreflang`.** Single language for now; add it with the first translation.
- **Analytics and Search Console are not wired up.** They need the live domain.
  Do this on day one after launch: the first three months of query data is what
  makes the next three months of tool choices evidence rather than guesswork.

## Regression cover

`tests/e2e/site.spec.ts` asserts per-page cards with no reuse, `llms.txt`
completeness and content, `tools.json` shape, the AI crawler policy, sitewide
Organization and SearchAction schema, image sitemap entries, title and
description length and uniqueness, JSON-LD validity and required types, and
that no em dash appears in any rendered copy.
