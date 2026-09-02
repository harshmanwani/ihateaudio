/**
 * Reads a tool page's `agent` manifest out of its source text.
 *
 * The catalog an agent gets from `list_tools` has to name the action each page
 * exposes, and the only place that name lives is the page's own manifest. Rather
 * than keep a second list by hand — which would drift the first time someone
 * renamed an action — the build reads the pages. Text matching is enough: the
 * manifest is a literal, and this runs at build time, never in the browser.
 */

export interface AgentActionSummary {
  name: string;
  description: string;
  /** Parameter keys, in declaration order. */
  params: string[];
}

export function extractAgentAction(source: string): AgentActionSummary | null {
  const start = source.search(/\bagent:\s*\{/);
  if (start < 0) return null;

  const block = source.slice(start, endOfManifest(source, start));
  const name = block.match(/\bname:\s*'([^']+)'/)?.[1];
  if (!name) return null;

  const description =
    block.match(/\bdescription:\s*\n?\s*'((?:[^'\\]|\\.)*)'/)?.[1]?.replace(/\\'/g, "'") ?? '';
  const paramsStart = block.search(/\bparams:\s*\[/);
  const params =
    paramsStart < 0
      ? []
      : [...block.slice(paramsStart).matchAll(/\bkey:\s*'([^']+)'/g)].map((m) => m[1]);

  return { name, description, params };
}

/** Index just past the closing brace of the `agent: { ... }` literal. */
function endOfManifest(source: string, start: number): number {
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return source.length;
}
