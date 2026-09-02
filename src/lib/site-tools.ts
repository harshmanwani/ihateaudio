/**
 * The agent tools that belong to the site rather than to one page.
 *
 * A tool page's own tools only appear once the agent is standing on it, so
 * something has to be available before that: a catalog to choose from and a
 * way to get there. These register on the homepage and on every tool page, so
 * an agent can route itself from wherever the person started.
 */
import { textResult } from './agent';
import type { SiteTool } from './webmcp';

export interface CatalogTool {
  slug: string;
  name: string;
  url: string;
  category: string;
  summary: string;
  keywords: string[];
  action?: { name: string; description: string; params: string[] };
}

export interface Catalog {
  name: string;
  url: string;
  baseTools: string[];
  tools: CatalogTool[];
}

let catalog: Promise<Catalog> | null = null;

/** Built at deploy time from the pages themselves, so it cannot drift. */
export function loadCatalog(): Promise<Catalog> {
  catalog ??= fetch('/agent-tools.json')
    .then((response) => {
      if (!response.ok) throw new Error(`The tool catalog answered ${response.status}.`);
      return response.json() as Promise<Catalog>;
    })
    .catch((error: unknown) => {
      catalog = null;
      throw error;
    });
  return catalog;
}

export async function resolveTool(slug: string): Promise<CatalogTool | null> {
  if (!/^[a-z0-9-]{2,64}$/.test(slug)) return null;
  try {
    return (await loadCatalog()).tools.find((tool) => tool.slug === slug) ?? null;
  } catch {
    return null;
  }
}

/**
 * Navigates after the reply has left.
 *
 * A tool that navigates inside `execute` never gets to answer: the page is
 * torn down first. A short delay lets the host receive the result, so the agent
 * knows where it is going before it gets there.
 */
export function navigateSoon(url: string, delayMs = 150): void {
  window.setTimeout(() => window.location.assign(url), delayMs);
}

const HOW_IT_WORKS =
  'Every tool runs in the browser; audio never leaves the tab. The person chooses a file once, on any tool page. From then on: inspect_audio reads facts, each page has one named action for its controls, render_preview auditions the result, send_to_tool hands the result to the next tool with no re-upload, and export_download saves the file when the person asks.';

export function siteTools(): SiteTool[] {
  return [
    {
      name: 'list_tools',
      description:
        'List every audio tool on this site with what it does and the agent action it exposes. Call this first to choose the right page for a request, then open_tool to go there. Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => {
        try {
          const loaded = await loadCatalog();
          return textResult({
            site: loaded.name,
            howItWorks: HOW_IT_WORKS,
            baseToolsOnEveryPage: loaded.baseTools,
            tools: loaded.tools,
          });
        } catch (error) {
          return textResult({
            error: error instanceof Error ? error.message : 'The tool catalog could not be read.',
          });
        }
      },
    },
    {
      name: 'open_tool',
      description:
        'Open one of this site\'s tools by slug, e.g. "silence-remover". The page navigates after replying; that page then registers its own tools, so call inspect_audio there. Audio already loaded on the current page is not carried over: use send_to_tool for that.',
      inputSchema: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'A slug from list_tools.' },
        },
        required: ['slug'],
        additionalProperties: false,
      },
      execute: async (input) => {
        const slug = typeof input.slug === 'string' ? input.slug.trim() : '';
        const target = await resolveTool(slug);
        if (!target) {
          return textResult({ error: `"${slug}" is not a tool on this site. Call list_tools for the slugs.` });
        }
        navigateSoon(target.url);
        return textResult({
          opening: target.url,
          tool: target.name,
          action: target.action?.name ?? null,
          note: 'The page is opening. Its tools register on arrival; call inspect_audio there.',
        });
      },
    },
  ];
}
