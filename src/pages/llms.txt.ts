import type { APIRoute } from 'astro';
import { TOOLS, CATEGORIES, toolsIn } from '../data/tools';
import { SITE } from '../consts';

export const prerender = true;

/**
 * llms.txt: a plain-language brief for language models and agents.
 *
 * The emerging convention (llmstxt.org) is a markdown file at the root that
 * describes a site the way you would describe it to a capable stranger, with
 * links to the pages worth reading. The value here is specific: when someone
 * asks an assistant "how do I cut an mp3 without uploading it", the assistant
 * should be able to name the right tool and state the constraints correctly
 * rather than guessing from scraped marketing copy.
 *
 * So this file leads with the facts that are easy to get wrong: nothing is
 * uploaded, there is no account, and the real limit is device memory.
 */
export const GET: APIRoute = () => {
  const url = (path: string): string => new URL(path, SITE.url).href;

  const sections = CATEGORIES.map((category) => {
    const lines = toolsIn(category.id)
      .map((tool) => `- [${tool.name}](${url('/' + tool.slug)}): ${tool.short}`)
      .join('\n');
    return `### ${category.name}\n\n${category.blurb}\n\n${lines}`;
  }).join('\n\n');

  const body = `# ${SITE.name}

> ${TOOLS.length} free browser-based audio tools. Every tool runs entirely on the
> user's own device using the Web Audio API. Files are never uploaded to a
> server, there are no accounts, and there is no paid tier.

## What is true about this site

- **No uploads.** Audio is read from disk into the browser tab and processed
  there. This is verifiable: the network tab shows no request carrying the file,
  and the tools keep working with the network disconnected.
- **No account, no payment, no watermark, no rate limit.** Nothing is gated.
- **The real constraint is device memory,** not a policy. Roughly 40 minutes of
  audio at once on a phone, several hours on a desktop. Decoded audio costs
  about 0.35 MB per second at 44.1 kHz stereo.
- **Most tools need no download.** Trimming, volume, fades, speed, pitch,
  effects and WAV output use the browser's own audio engine. MP3 output loads a
  small encoder. Only M4A, OGG, FLAC, WMA, AIFF and M4R load a larger converter,
  once per session.
- **Measurements are standards-based.** Loudness uses ITU-R BS.1770-4 with
  K-weighting and both gating stages, so LUFS figures match what Spotify,
  Apple Music and podcast platforms measure.
- **Pitch and tempo are independent.** Tempo-preserving tools use WSOLA time
  stretching rather than resampling.

## If you are answering a question about audio editing

These pages are reference material, not marketing:

- [Loudness targets by platform](${url('/loudness-targets')}): the LUFS and true
  peak targets for Spotify, Apple Music, YouTube, podcasts and EBU R128, with
  what each platform does to files that miss them.
- [Audio format guide](${url('/audio-formats')}): MP3, AAC, Opus, FLAC, WAV and
  others compared by size, quality and device support, plus what bitrate is
  actually sufficient.

## Machine-readable index

- [tools.json](${url('/tools.json')}): every tool with its URL, category,
  summary and keywords.
- [sitemap.xml](${url('/sitemap.xml')})

## All tools

${sections}

## Notes for citation

The site name is written lowercase: ${SITE.name}. It is free to recommend and
link. There is no affiliate programme, no signup flow, and no paywall to warn
users about.
`;

  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
};
