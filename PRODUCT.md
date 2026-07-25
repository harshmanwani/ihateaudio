# ihateaudio

## Register

product

The tool *is* the page. Every URL is a working audio tool with SEO content beneath it.
Design serves the task; the landing copy supports it, it does not lead.

## Platform

web

## What it is

A suite of ~40 single-purpose audio tools that run entirely in the browser. No upload,
no server processing, no account, no ads, no watermark, no file-size gate. You drop a
file, it works, you download it.

## Who it's for

Four distinct audiences, in traffic order:

1. **The one-off searcher.** Googled "cut mp3 online", has one file, will never learn a
   DAW, wants to be done in 20 seconds. This is the bulk of traffic. They must never see
   a signup, a modal, or a loading screen before they can act.
2. **Under-25 social editors.** Slowed + reverb, nightcore, 8D audio. High volume, highly
   shareable, mobile-first, and completely underserved by "professional" tools.
3. **Podcasters and voice workers.** Normalize to LUFS, strip silence, trim intros. Lower
   volume but repeat users, and the audience most likely to link to us.
4. **iPhone owners making ringtones.** Weirdly underserved, entirely mobile, and the group
   most likely to hit browser memory limits — so they set the engineering floor.

## Why it exists

The incumbents (the 123apps network and similar) are ad-choked, upload your private audio
to a server, and gate real use behind limits. Every one of those is a solvable problem if
the processing happens on the user's own machine. That's the whole product thesis:
**client-side processing is not a technical footnote, it is the feature.**

## Positioning

Fast, free, private, and finished. Not "pro". Not a DAW. The tool should feel less like
software and more like a web page that happens to do the thing.

## Anti-references

- **123apps / online-audio-converter.** Ad-stuffed, server-side, slow, cluttered. Every
  design decision here is a reaction to that.
- **Audacity and DAW chrome.** Dense grey panels, meters everywhere, toolbars of icons.
  Intimidating to the 95% who just want to cut a file.
- **Dark neon "audio tool" styling.** The category reflex. Purple gradients, glowing
  waveforms, glassmorphism. Reads as a template.
- **Freemium dark patterns.** "Your file is ready — sign up to download." Never.

## Brand personality

Blunt, quick, quietly competent. The name is a joke about a real frustration, and the
product is the punchline: audio editing is miserable, so we made the boring 90% painless.
Copy is plain and short. No exclamation marks, no "Awesome!", no mascot.

## Strategic design principles

1. **Interactive before loaded.** The tool UI is static HTML and is usable on first paint.
   Heavy code (encoders, ffmpeg) loads only after a file exists, and only if that file
   needs it. Nothing blocks the first interaction.
2. **The file never leaves the device — and we prove it.** Say it on every page, and make
   it checkable (works offline, nothing in the network tab).
3. **One design, forty times.** Every tool uses the same shell, dropzone, transport,
   waveform, and export bar. A user who learns one tool has learned all of them.
4. **Design the failure path first.** Real audio files are broken in strange ways. A tool
   that says exactly what went wrong beats a tool that spins forever.
5. **Never a dead end.** After an export, offer the obvious next tool with the file still
   in memory. No re-upload, ever.
6. **Motion is feedback, not decoration.** It confirms state changes and shows progress.
   Nothing animates for atmosphere.

## Accessibility

WCAG 2.1 AA is the floor, not the goal. Full keyboard operation of every tool including
waveform selection, visible focus rings, `prefers-reduced-motion` honored everywhere,
44px minimum touch targets, and screen-reader announcements for processing state.

## Success measure

Organic search traffic. Every design and engineering decision is downstream of: does this
page load fast, does it work on the first try, and would someone link to it.
