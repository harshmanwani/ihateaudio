/**
 * A deliberately small boundary around the WebMCP browser API.
 *
 * Two hosts exist in the wild: the W3C proposal puts the API on
 * `navigator.modelContext`, and ChatGPT's browser puts it on
 * `document.modelContext`. The rest of the app should not care which, or
 * whether either is present. A normal browser gets an ordinary editor; a
 * compatible agent sees the tools the current page registers.
 */

export interface SiteTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: {
    /** Marks a tool that only observes the page and never changes it. */
    readOnlyHint?: boolean;
  };
  execute: (input: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface ModelContextHost {
  registerTool(tool: SiteTool): Promise<void> | void;
}

export type HostResolver = () => ModelContextHost | null | undefined;

export interface SiteToolRegistration {
  supported: boolean;
  registered: number;
  error?: string;
}

const hostOf = (owner: unknown): ModelContextHost | null => {
  const candidate = (owner as { modelContext?: ModelContextHost } | undefined)?.modelContext;
  return typeof candidate?.registerTool === 'function' ? candidate : null;
};

/** The standard host first, then ChatGPT's. */
const defaultHost: HostResolver = () =>
  hostOf(globalThis.navigator) ?? hostOf(globalThis.document);

/**
 * Registers tools only when the current browser implements WebMCP.
 *
 * A registration failure must never take the editor down with it: WebMCP is an
 * enhancement, not a dependency of the user-facing product.
 */
export async function registerSiteTools(
  tools: SiteTool[],
  resolve: HostResolver = defaultHost
): Promise<SiteToolRegistration> {
  const host = resolve();
  if (!host) return { supported: false, registered: 0 };

  try {
    for (const tool of tools) await host.registerTool(tool);
    return { supported: true, registered: tools.length };
  } catch (error) {
    return {
      supported: true,
      registered: 0,
      error: error instanceof Error ? error.message : 'The browser rejected the site tools.',
    };
  }
}
