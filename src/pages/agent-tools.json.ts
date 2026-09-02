import type { APIRoute } from 'astro';
import { TOOLS } from '../data/tools';
import { SITE } from '../consts';
import { extractAgentAction } from '../lib/agent-catalog';

export const prerender = true;

/**
 * The catalog an agent reads to route itself.
 *
 * tools.json already tells assistants what the site can do; this adds what an
 * agent can *drive* on each page, read from the pages themselves at build time
 * so the action names never drift from the manifests.
 */
export const GET: APIRoute = () => {
  // The page sources as text, resolved by the bundler at build time. A
  // filesystem read would point at the compiled chunk, not at src/pages.
  const sources = import.meta.glob('/src/pages/*.astro', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;
  const actions = new Map<string, ReturnType<typeof extractAgentAction>>();
  for (const [path, source] of Object.entries(sources)) {
    const slug = path.split('/').pop()?.replace(/\.astro$/, '') ?? '';
    actions.set(slug, extractAgentAction(source));
  }

  const body = {
    name: SITE.name,
    url: SITE.url,
    baseTools: ['inspect_audio', 'set_output_format', 'render_preview', 'export_download', 'send_to_tool', 'load_audio_from_url'],
    tools: TOOLS.filter((tool) => !tool.secondary).map((tool) => {
      const action = actions.get(tool.slug);
      return {
        slug: tool.slug,
        name: tool.name,
        url: `/${tool.slug}`,
        category: tool.category,
        summary: tool.short,
        keywords: tool.keywords.join(' ').split(/\s+/).filter(Boolean).slice(0, 12),
        ...(action ? { action } : {}),
      };
    }),
  };

  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
