/**
 * A deliberately small boundary around the WebMCP browser API.
 *
 * Two hosts exist in the wild: the W3C proposal puts the API on
 * `navigator.modelContext`, and ChatGPT's browser bridge puts it on
 * `document.modelContext`. A page may see either, or both at once — Chrome with
 * the WebMCP flag plus the ChatGPT extension — so tools register on every
 * distinct host found. The rest of the app never needs to know which.
 */

export interface SiteTool {
  name: string;
  /** Human-readable name a host may show beside `name`. */
  title?: string;
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

/** Every host on the page. Duplicates are fine; they are registered once. */
export type HostResolver = () => ModelContextHost[];

export interface SiteToolRegistration {
  supported: boolean;
  registered: number;
  error?: string;
}

const hostOf = (owner: unknown): ModelContextHost | null => {
  const candidate = (owner as { modelContext?: ModelContextHost } | undefined)?.modelContext;
  return typeof candidate?.registerTool === 'function' ? candidate : null;
};

const defaultHosts: HostResolver = () =>
  [hostOf(globalThis.navigator), hostOf(globalThis.document)].filter(
    (host): host is ModelContextHost => host !== null
  );

/**
 * Registers tools on every WebMCP host the current browser exposes.
 *
 * A registration failure must never take the editor down with it: WebMCP is an
 * enhancement, not a dependency of the user-facing product.
 */
export async function registerSiteTools(
  tools: SiteTool[],
  resolve: HostResolver = defaultHosts
): Promise<SiteToolRegistration> {
  const hosts = [...new Set(resolve())];
  if (hosts.length === 0) return { supported: false, registered: 0 };

  try {
    for (const host of hosts) {
      for (const tool of tools) await host.registerTool(tool);
    }
    return { supported: true, registered: tools.length };
  } catch (error) {
    return {
      supported: true,
      registered: 0,
      error: error instanceof Error ? error.message : 'The browser rejected the site tools.',
    };
  }
}
