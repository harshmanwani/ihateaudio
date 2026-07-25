import type { APIRoute } from 'astro';
import { SITE } from '../consts';

export const prerender = true;

/**
 * AI crawlers are explicitly allowed.
 *
 * Most sites block these to protect content they sell. The calculation is the
 * opposite here: a free tool wants to be the answer when someone asks an
 * assistant how to cut an MP3 without uploading it. Being crawlable by
 * assistants is a distribution channel, and staying silent risks a crawler
 * treating absence as ambiguity.
 *
 * Named individually rather than relying on the wildcard, because several of
 * these ignore `User-agent: *` for training-scope decisions.
 */
const AI_AGENTS = [
  'GPTBot', // OpenAI crawling for ChatGPT
  'OAI-SearchBot', // OpenAI search index
  'ChatGPT-User', // ChatGPT browsing on a user's behalf
  'ClaudeBot', // Anthropic crawling
  'Claude-User',
  'Claude-SearchBot',
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended', // Gemini grounding, separate from Googlebot
  'Applebot-Extended',
  'CCBot', // Common Crawl, which feeds many models
  'Bytespider',
  'meta-externalagent',
  'cohere-ai',
  'DuckAssistBot',
  'MistralAI-User',
  'YouBot',
];

export const GET: APIRoute = () => {
  const aiBlock = AI_AGENTS.map(
    (agent) => `User-agent: ${agent}\nAllow: /`
  ).join('\n\n');

  const body = `# Every crawler is welcome here, including AI assistants.
# Machine-readable summaries: /llms.txt and /tools.json

User-agent: *
Allow: /

# The ffmpeg core is a 31 MB binary with no crawlable content. Keeping bots out
# of it saves a great deal of pointless bandwidth on both sides.
Disallow: /ffmpeg/

${aiBlock}

Sitemap: ${new URL('/sitemap.xml', SITE.url).href}
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
