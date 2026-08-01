# Destination tools — design

**Status:** built and shipped to `main`-ready state. 281 tests pass, build clean, SEO audit clean.
**Date:** 2026-07-31 (design), same day (implementation)

Three things changed during implementation. They are folded into the sections below and
called out here because each was a correction to the design, not a detail of it:

1. **Routes drive the export bar rather than bypassing it.** The design had
   `exportBar={false}` with pre-encoded blobs. Letting a route *set* format and quality
   instead means one download surface, no new export machinery, and a manual override
   recomputes the part count around the user's choice rather than silently disagreeing
   with it.
2. **Single-file bitrates are capped near the comfortable rate.** Taking the highest
   bitrate that fits handed someone a 7.6 MB file for three minutes of speech at 320 kbps.
   Caught in the browser, not in a test.
3. **The budget bar's scale adapts.** A limit line pinned at a fixed column left a third
   of the panel permanently empty whenever the file already fitted, which reads as broken
   rather than as headroom.

## What this is

Three tools that answer one question — *"this file is too big to send, now what?"* — for the
three places where that question actually has a painful answer.

The site already has the parts: a compressor, a splitter, a converter. What it doesn't have
is anything that knows the destination. Someone with a 45-minute lecture and a WhatsApp
thread has to know that 16 MB is the cap, that bitrate × duration ÷ 8 is the formula, that
Opus mono is three times better than MP3 stereo for speech, and that the answer might be two
files rather than one. That's four pieces of knowledge to solve one boring problem.

These pages hold that knowledge so the user doesn't have to.

## Why only three destinations

Verified limits, July 2026:

| Platform | Cap | At 128 kbps MP3 | Worth a tool? |
|---|---|---|---|
| WhatsApp | 16 MB media, 2 GB as document | ~17 min | Yes — severe |
| Discord | 10 MB free, 50 Nitro Basic, 500 Nitro, boosts 50/100 | ~10 min | Yes — worst cap of any |
| Email | Gmail 25 MB, Outlook 20 MB, real ceiling ~18 MB | ~18 min | Yes, and non-obvious |
| Telegram | 2 GB free, 4 GB Premium | ~35 hours | No |
| Signal | ~100 MB | ~1.7 hours | Effectively no |
| iMessage | ~100 MB | ~1.7 hours | Effectively no |
| Slack | 1 GB per file, all plans | ~13 hours | No |

Telegram, Signal, iMessage and Slack would be pages whose tool tells you your file is
already fine. That is the doorway-page shape `PATTERN.md` warns about — four thin pages
diluting three good ones. They are out.

The three that remain have genuinely different stories, which is what keeps them off the
duplicate-content pile:

- **WhatsApp** — the fork. 16 MB for a tap-to-play message, 2 GB for a document card.
- **Discord** — the ladder. Your cap is your Nitro tier *and* the server's boost level.
- **Email** — the hidden tax. Base64 inflates attachments ~33%, and the recipient's server
  gets a veto you can't see.

## Architecture

```
src/lib/audio/fit.ts                 NEW — destination profiles + route generation
src/lib/audio/classify.ts            NEW — speech vs music detection
src/pages/send-audio-on-whatsapp     NEW ┐
src/pages/send-audio-on-discord      NEW ├ thin; all judgement lives in fit.ts
src/pages/send-audio-by-email        NEW ┘
src/data/tools.ts                    3 entries + the `send` category
src/styles/tool.css                  .fitbar panel classes
```

Everything else is additive. No existing module changes behaviour.

The slugs name the job rather than the mechanism, which is a deliberate break from the
noun-phrase convention the other 51 pages follow (`audio-trimmer`, `ringtone-maker`). It is
justified here because the search intent is a verb — people type "how to send long audio on
whatsapp", not "whatsapp audio compressor" — and because the three pages read as a set. Tool
`name` fields follow the slugs: "Send Audio on WhatsApp", and so on.

New category:

```ts
{
  id: 'send',
  name: 'Send it somewhere',
  blurb: "Every app has a size limit and none of them tell you what to do about it. " +
         "These work out what fits, then make it fit.",
}
```

### `fit.ts` — the engine

One job: given a decoded buffer, the source file, a destination and a content kind, return a
ranked list of **routes**. A route is a complete, executable answer — format, bitrate,
channel count, part count, projected bytes, and an honest quality verdict.

```ts
export interface Destination {
  id: 'whatsapp' | 'discord' | 'email';
  ceilings: Ceiling[];      // selectable; first is the default
  codecs: string[];         // what this destination will actually play, best-first
  overhead: number;         // byte-budget multiplier — email's base64 tax lives here
  escape?: EscapeRoute;     // the no-compression exit, where one exists
}

export interface Route {
  kind: 'asis' | 'single' | 'parts' | 'escape';
  format: string; bitrate: number; channels: 1 | 2; parts: number;
  totalBytes: number; perPartBytes: number;
  instant: boolean;                        // true when the format is tier ≤ 1
  quality: 'clean' | 'fine' | 'rough';
  caveat?: string;
  recommended: boolean;
}
```

Modelling email's base64 inflation as `overhead: 1.37` rather than special-casing it means
Gmail's 25 MB becomes an 18.2 MB budget through the same arithmetic every other destination
uses, and the tax is explainable in one line of UI instead of scattered through the code.

**Ceilings.** Discord: free 10 MB *(default)*, Nitro Basic 50, boost L2 50, boost L3 100,
Nitro 500. Email: Gmail 25 *(default)*, Outlook 20, corporate/unknown 10. WhatsApp: 16 MB
only — the document path is an escape, not a ceiling.

**Budget.** `ceiling.bytes / overhead × 0.95`. The 5% is headroom for container overhead and
tags. A tool that promises a fit and delivers a file that bounces is worse than no tool.

### The decision

Routes are generated in this order:

1. **As-is** — if the source already fits the budget and the destination plays its format.
   The tool says "this is fine, send it" and stops. Nobody builds this case; everybody hits it.
2. **One file** — walk codecs best-first (Opus → M4A → MP3), and within each walk
   `bitratesFor()` downward for the highest bitrate that fits. Emitted always; marked
   `rough` and never recommended if it lands below the quality floor.
3. **Parts** — encode at one step above the floor, `N = ceil(totalBytes / budget)`.
4. **Escape** — WhatsApp only. Send as a document: 2 GB, zero processing, arrives as a file
   card rather than a playable message.

Quality floors (below these, a single file is offered but not recommended):

| | Opus | M4A | MP3 |
|---|---|---|---|
| speech, mono | 32 | 64 | 64 |
| music, stereo | 96 | 96 | 128 |

**Recommendation — fewest files wins.** Among routes whose quality is `clean` or `fine`,
recommend the one with the fewest parts. Ties break toward `instant`, so a route that needs
no ffmpeg download beats an equal-part-count route that does. `asis` short-circuits
everything above it. A `rough` route is never recommended, and `escape` never is either — it
changes what the recipient sees, which is the user's call to make, not ours.

```
asis?                          → recommend it, stop
min(parts) among clean|fine    → recommend it
  tie → prefer instant
  still tied → prefer higher quality tier
```

This makes the default vary with length rather than being fixed, which is the point:

| Input | MP3 | Opus | Recommended |
|---|---|---|---|
| 5-min voice memo, 8 MB | — | — | **as-is** — already fits |
| 12-min clip | 1 part | 1 part | **MP3** — ties on files, wins on instant |
| 45-min lecture | 3 parts | 1 part | **Opus** — only way to get one file |
| 45-min music | 3 parts | 3 parts | **MP3** — ties on files, wins on instant |
| 3-hour sermon | 6 parts | 3 parts | **Opus** |

Short files stay instant; only long ones pay the 31 MB download, and only when it genuinely
buys fewer files. **One instant route is always offered** regardless, so nobody is ever
forced through the download to send a voice note.

**Bitrates are capped one step above comfortable.** Having room to spare is not a reason to
use it: past the comfortable rate the extra bits buy nothing audible on that material.
Without this, three minutes of speech that technically fits Gmail at 320 kbps produces a
7.6 MB file where 3.1 MB is indistinguishable.

Because the default now varies, the verdict must say *why* it chose: "Opus — the only way
this fits in one file" versus "MP3 — fits in one already, no download needed". A default the
user can't predict has to be a default the user can understand.

What this produces, for speech at the 32 kbps Opus floor:

| Destination | Speech that fits in one file | Music at 96 kbps |
|---|---|---|
| WhatsApp (16 MB) | ~63 min | ~21 min |
| Discord (10 MB free) | ~40 min | ~13 min |
| Email (18 MB real) | ~73 min | ~24 min |

Slicing stops being the common case and becomes the honest fallback for genuinely long
recordings — which is the right shape for the problem.

### `classify.ts` — speech or music

Four cheap, explainable heuristics over three ~10 s probes (25%, 50%, 75% through the file):

1. **Stereo correlation** — near-1.0 means effectively mono, which means speech.
2. **Spectral rolloff** — speech dies above ~8 kHz; music routinely carries past 16 kHz.
3. **Silence fraction** — via the existing `findSilence`. Speech has breaths and pauses;
   music rarely stops.
4. **Short-term RMS spread** — speech is dynamic, mastered music is squashed.

Vote across the four and **report the reasons in the UI** ("mono, nothing above 8 kHz, pauses
throughout"). The evidence is what makes the one-tap override trustworthy — the user can see
at a glance whether the guess is wrong.

On a split vote, say so and assume **music**. Failing that direction yields a bigger file,
not a ruined one.

### Slicing at pauses

1. Nominal boundaries at `D × i / N`.
2. Search `± min(0.08 × partLength, 45 s)` around each.
3. `findSilence(buffer, -45, 0.35)`, take the longest region in the window, cut at its midpoint.
4. No silence in window → cut at nominal, and count it. The caption reports honestly:
   "2 of 3 cuts landed on a pause."
5. Re-verify every part against the budget; bump `N` and redo if any overflows. Bounded loop.

**Filenames:** `lecture-part-1-of-3.opus`. This deliberately diverges from the splitter's
`-part-01` convention. Here the *recipient* reads the filename in a chat thread and needs to
know when they have them all.

## Interface

### The verdict

The moment a file is decoded, the page states what it has and what it recommends, with the
alternatives visible rather than buried:

```
lecture.mp3 · 45:12 · 62.1 MB
Sounds like speech — mono, nothing above 8 kHz, pauses throughout   [it's music]

● One file · Opus 32k mono      10.8 MB   the only way this fits in one file
○ 3 parts · MP3 96k mono      3 × 15 MB   instant, no download
○ One file · MP3 24k mono       15.8 MB   ⚠ fits, but sounds rough
○ As a document · untouched      62.1 MB  perfect quality, arrives as a file card

                          [ Download ]   [ Hear it first ]
```

The right-hand column carries the *reason*, not a restatement of the size. That column is
what makes a varying default legible.

Pre-selecting the recommendation keeps the one-off searcher's path to one click, while the
routes stay honest for anyone who cares. The "it's music" affordance and the stated reasons
make the guess correctable rather than mysterious.

### The panel — `data-fit-panel`

A **budget bar**, following the canvas panel house pattern: dark stage card, canvas at
`width:100%`, `min(2, devicePixelRatio)`, colours read off the panel with `getComputedStyle`,
redrawn from `paint` plus `requestAnimationFrame` and a `ResizeObserver`.

Two rows — what you have, and what you would send — against a dashed line marking the limit.
Each block's width is its real projected bytes; anything past the line is tinted `--danger`.

The scale adapts rather than pinning the limit to a fixed column: whichever is larger, the
file or the limit, sets it. So an oversized file visibly overshoots, and a file with room to
spare visibly has room, instead of a third of the panel sitting permanently empty.

The compressor's question is "what bitrate?" — continuous, so a curve is right there. This
tool's question is "does it fit, and in how many pieces?" — discrete packing, so a packing
diagram is right here. Every width comes from `estimateSize()`, the same call the export
makes. Measure, don't sketch.

Reserved names: `data-fit-panel`, `data-fit-plot`, `data-fit-caption`. Checked against
ToolShell — no collision with `data-map`, `data-size`, `data-canvas`, `data-markers`, `data-time`.

### The audition

Routes make claims like "sounds fine at 32 kbps". **Hear it** encodes a 15 s probe from the
middle at the route's exact settings, decodes it back, and mounts it through
`ToolRuntime.showResult()` as the result strip. The main transport keeps the original,
always. Instant for MP3 routes; for Opus it triggers the same ffmpeg load the export needs
anyway, so nothing is wasted.

### Shell configuration

`exportBar={true}`, `results={true}`. Selecting a route writes its format and bitrate into
the export bar, which stays the single source of truth and the single download surface.
`process()` returns `NamedOutput[]` of *buffers*, so `deliverMany` encodes each one with
whatever the bar currently says.

This is better than the bypass the design originally proposed. A user who overrides the
format afterwards gets a part count recomputed around their choice, so the plan and the
controls can never disagree — and no new export machinery exists to keep in step. The
`asis` and `escape` routes return the original `File` as a blob, so the page is never a
dead end even when the honest answer is "you were already fine".

No change to `tool.ts`, `export.ts` or any other shared module was needed.

## Page content

Templated pages get classified as doorway pages, so each article is about its platform's
actual mechanics:

- **WhatsApp** — why 16 MB; the media/document fork and what each costs; why WhatsApp's own
  voice notes are 16 kbps Opus and yours can't be one; why an `.opus` file you send arrives
  as an audio message, not a voice note.
- **Discord** — the 25→10 MB cut of September 2024; how boosts and Nitro stack (a boost
  raises it for everyone in the server, Nitro raises it only for you); what plays inline.
- **Email** — base64 and the 33% tax, worked through; why the recipient's server has a veto;
  why Gmail silently swaps to a Drive link at 25 MB and when that's the wrong outcome.

## Testing

- **Unit, `fit.ts`** — route generation across durations × destinations × content kinds. The
  invariant that matters: every emitted route's `perPartBytes ≤ budget`. Promising a fit and
  delivering a bounce is the one unforgivable failure.
- **Unit, `classify.ts`** — synthetic signals: tone-plus-silence reads speech-ish, sustained
  broadband reads music-ish, and a split vote returns low confidence rather than a coin flip.
- **Unit, slicing** — parts reconstruct to the original duration; boundaries land inside
  silence regions when silence exists in the window.
- **E2E** — drop a fixture, assert the verdict line, toggle content type, assert the routes
  change. Screenshot the panel, per the standing rule that these are verified visually and
  not by reading the source.

## Decisions taken

1. **Slugs name the job** — `send-audio-on-whatsapp` / `-on-discord` / `send-audio-by-email`.
   Breaks the noun-phrase convention on purpose; the search intent here is a verb.
2. **New `send` category**, "Send it somewhere", rather than filing under Convert. The three
   read as a deliberate group and would be lost among nine converters.
3. **Fewest files wins**, ties breaking toward instant. Short files stay instant, long ones
   earn Opus.

## Build order

Three pages, but not three parallel efforts. The engine is the whole job; the pages are
configuration plus an article.

1. **Verify Opus on iOS.** See below. Everything downstream assumes it.
2. **`classify.ts` + `fit.ts`, with unit tests, no UI.** The route table above is the
   acceptance criterion — the matrix of durations × destinations × content kinds should
   produce exactly those recommendations before a single page exists.
3. **`send-audio-on-whatsapp` end to end** — panel, audition, slicing, article. This is where
   the shape of the UI gets settled and where the `.fitbar` classes get written.
4. **Discord and email**, once the WhatsApp page has been used in anger. Each is a
   destination profile, a ceiling picker and an article; if either turns out to need more
   than that, the engine's boundaries were drawn wrong and that is worth knowing early.

Steps 2 and 3 are the plan. Step 4 should be re-scoped after step 3 ships rather than
planned now.

## Risk to retire first

**Verify `.opus` playback on a real iPhone before anything else is built.** The evidence is
strong — WhatsApp's own voice notes are Opus, and their media spec lists OGG/Opus mono
explicitly — but it is inference, not a tested fact, and the entire Opus route plus a third
of the WhatsApp article rests on it. If it fails on iOS, M4A at 64 kbps takes Opus's place in
the codec ladder, every "fits in one file" duration roughly halves, and the recommendation
table above changes. Cheap to test, expensive to get wrong.

## Not doing

- Telegram, Signal, iMessage, Slack pages — no problem to solve.
- Video. That's pointed at supercut.
- Producing real WhatsApp voice notes. WhatsApp decides that from how the file is attached,
  not from its contents. Claiming otherwise would be a lie.
- Zipping the parts. You can't usefully send a zip to a WhatsApp thread.
