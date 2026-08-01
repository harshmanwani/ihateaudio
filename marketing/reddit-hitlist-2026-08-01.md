# Reddit hit list — 1 Aug 2026

Found via archive search of the last 60 days, then read each thread's actual comments so
the drafts add something instead of repeating. Everything older than ~6 months is
archived (can't comment) — that killed most of the threads that rank in Google today,
which is fine: fresh threads accrue the votes that make them rank next.

## Preflight (do this before posting anything)

- Use your real, oldest Reddit account. If it has near-zero karma or comment history,
  spend 20 minutes today leaving 3–4 normal, unrelated comments first (any sub you
  actually read). Accounts with no history that drop a product link get filtered fast.
- **Cap today at: 1 post + 2 comments, in different subs.** The documented 2026 spam
  trigger is one link across many subs in a day from an account with no history there.
  Space the rest across the week.
- Rewrite the drafts below in your own words — don't paste verbatim (identical text
  across threads is itself a spam signal, and these should sound like you).
- Reply to anyone who responds. The follow-up conversation is worth more than the comment.

## Post today

### 1. r/podcasting — the transcription thread (best fit found, do this one first)
**https://www.reddit.com/r/podcasting/comments/1v1ujfr/** — "anyone got a transcription
tool unlimited file length that doesnt need a subscription" (Jul 20, 24 comments, active)

OP transcribes 2-hour episodes twice a month, refuses subscriptions, explicitly worried
about audio being used for AI training. Thread is full of SaaS self-promos; several
people correctly said "local Whisper" (MacWhisper, Buzz) but nobody has offered a
no-install version. That's exactly our transcriber.

Draft:

> The answer you're circling is local Whisper — free, no length cap, and the audio never
> leaves your machine, which kills the training worry completely. MacWhisper on Mac or
> Buzz on Windows are the good desktop routes.
>
> If you don't want to install anything: I built a browser version of the same idea
> (ihateaudio.com/audio-transcriber) — Whisper runs inside the tab, so nothing is
> uploaded (it keeps working with wifi off), no account, no meter. Honest caveat: it
> uses a small model so it stays a reasonable download, so on a 2-hour Lex episode
> it'll chew for a while and MacWhisper with a bigger model will read cleaner. For
> searching quotes later it's plenty, and you can export plain text or SRT.

### 2. r/karaoke — making karaoke versions
**https://www.reddit.com/r/karaoke/comments/1uw60pm/** — "How can I make a karaoke
version of a song?" (Jul 14, 14 comments)

OP is making tracks for a family party. Top answer (18↑) is "YouTube has karaoke
versions", which is true and should be agreed with. The gap: songs with no karaoke
version. One commenter already said "run it through a vocal remover" without naming one.
This sub visibly tolerates disclosed tool mentions.

Draft:

> The YouTube answer is right for anything popular — someone's already made it. The gap
> is the obscure stuff and family-specific songs. For those, take the original track and
> strip the vocals yourself: I built a free vocal remover that runs in the browser
> (ihateaudio.com/vocal-remover) — no signup, nothing gets uploaded, drop the mp3 and
> download the instrumental. You won't get scrolling lyrics out of it, just the backing
> track — print the lyrics or put them on the TV and a family party will not complain.

### 3. Today's post: r/SideProject (showcase sub, self-promo welcome)

Title:

> I got tired of "free" audio tools that upload your files and gate the download, so I
> built 49 actually-free ones that run in your browser

Body:

> Every time I needed to trim an mp3 or make a ringtone I'd end up on some ad-farm that
> uploads the file to a server, then asks for an account, then watermarks the output.
> So over the last months I built ihateaudio.com — 49 single-purpose audio tools
> (trim, convert, normalize, vocal remover, transcription, slowed+reverb, ringtones…)
> that run entirely client-side.
>
> Because nothing leaves your device, the privacy claim is checkable: load a tool, turn
> off wifi, it still works. No account, no watermark, no file-size limits. The AI tools
> (vocal removal, transcription) download their models once and run locally too.
>
> Tech: static Astro site, Web Audio API for most tools (a tool page is ~55KB), a lazy
> MP3 encoder, and self-hosted ffmpeg.wasm only for rare formats. Would love feedback —
> especially which tool is missing.

## This week (staggered, one per day at most)

### 4. r/singing — instrumental in the wrong key (Wed)
**https://www.reddit.com/r/singing/comments/1v0s2te/** — "you can sing a song a capella
but the available instrumental doesn't suit your voice" (Jul 19)

Audacity and Moises already suggested; someone even mentioned "browser plugins can do
this". Our pitch shifter is the direct answer, tempo changer secondary.

Draft:

> Changing the key of the backing track is usually the move — shift by semitones with
> the tempo locked. Audacity's change-pitch does it as others said. If you don't want
> to install anything, I built a browser tool for exactly this (pitch-shifter on
> ihateaudio.com) — free, drop the file, move it up or down in semitones, tempo stays
> put. And if the karaoke versions floating around are just bad, running the original
> through a vocal remover sometimes gets you a better backing track than any of them.

### 5. r/podcasting — "Transcribe Podcasts?" (Fri, only if #1 went fine)
**https://www.reddit.com/r/podcasting/comments/1v7fy6m/** (Jul 26, 5 comments)

Same sub as #1, so wait a few days; two transcriber mentions in r/podcasting on the same
day from one account is a pattern. Angle here is different: OP wants transcripts of
shows they *listen to*, for AI workflows. The RSS-mp3 trick is already well covered by
another commenter — agree, then the drop-the-mp3 step is ours. Keep it two sentences.

### 6. r/iphone — ringtone from a purchased song (optional, automod risk)
**https://www.reddit.com/r/iphone/comments/1v1w7c1/** — "How to change ringtone to my
downloaded song" (Jul 20)

Real fit (our M4R maker + install walkthrough), BUT r/iphone's automod already removed a
comment in this exact thread for "prohibited content" — likely link filtering. If you
try: plain text, no URL, name the site once ("ihateaudio's ringtone maker"), lead with
the actual explanation (buying a *song* ≠ buying a *tone*; GarageBand is the free Apple
route; ours is the faster route). If automod eats it, let it go — do not repost.

## Found and deliberately skipped

- **r/Music "slowed + reverb workflow" (1ssnzbx)** — it's a competitor's own promo post
  (Tessering). Commenting our link under it is thread-hijacking; bad look, skip.
- **r/ProductivityApps "I built a free speech-to-text in browser"** — direct competitor's
  launch post. Same reason.
- **r/Beatmatch MixedInKey-alternative (1uznj2b)** — they need batch analysis + file
  renaming; our key finder is single-file and doesn't rename. Answering would be
  forcing it. Skip.
- **Everything that ranks in Google but is archived** (the r/software transcription
  thread at 22↑, r/iphonehelp GarageBand thread, r/guitarlessons BPM thread, both big
  ringtone threads) — can't comment, archived at 6 months. This is why the durable play
  is answering *fresh* threads continuously: today's fresh thread is next year's
  Google result.
- **r/podcasting normalization thread (1snjpxo, Apr)** — good thread, but the correct
  answers (-16 stereo/-19 mono) are already in it and a late comment lands at the
  bottom. Marginal; revisit only if you want a third r/podcasting touchpoint next week.

## If you have 15 more minutes today

Submit to **AlternativeTo** (alternativeto.net) — it's Week 1 of MARKETING.md anyway,
zero spam risk, and its "alternatives to 123apps / vocalremover.org / Audacity" pages
are permanent surfaces. Blurb to paste is in MARKETING.md's copy assets.
