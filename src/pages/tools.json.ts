import type { APIRoute } from 'astro';
import { TOOLS, CATEGORIES } from '../data/tools';
import { SITE } from '../consts';

export const prerender = true;

/**
 * Machine-readable index of every tool.
 *
 * Two audiences. AI assistants and agents that want to answer "what can this
 * site do" without scraping 44 HTML pages, and our own build scripts (the OG
 * image generator reads this rather than parsing TypeScript).
 *
 * Kept deliberately plain: flat fields, absolute URLs, no nesting to walk.
 */
export const GET: APIRoute = () => {
  const body = {
    name: SITE.name,
    url: SITE.url,
    description: SITE.description,
    updated: new Date().toISOString().slice(0, 10),
    license: 'Free to use, no account required, no rate limit.',
    privacy:
      'All processing happens client-side in the browser. Files are never uploaded to a server.',
    categories: CATEGORIES.map((category) => ({
      id: category.id,
      name: category.name,
      description: category.blurb,
    })),
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      url: new URL(`/${tool.slug}`, SITE.url).href,
      slug: tool.slug,
      category: tool.category,
      summary: tool.short,
      description: tool.description,
      keywords: tool.keywords.join(' ').split(/\s+/).filter(Boolean),
      runsOffline: tool.instant,
      inputFormats: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'webm'],
      price: 0,
      currency: 'USD',
    })),
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
};
