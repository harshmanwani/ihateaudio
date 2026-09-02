import { describe, expect, it } from 'vitest';
import { registerSiteTools, type ModelContextHost, type SiteTool } from '../../src/lib/webmcp';

const tool = (name: string): SiteTool => ({
  name,
  description: `${name} does a thing`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  execute: async () => ({ content: [{ type: 'text', text: '{}' }] }),
});

const recorder = (): { host: ModelContextHost; seen: string[] } => {
  const seen: string[] = [];
  return { host: { registerTool: async (t) => void seen.push(t.name) }, seen };
};

describe('registerSiteTools', () => {
  it('reports unsupported and registers nothing when no host exists', async () => {
    const result = await registerSiteTools([tool('a')], () => []);
    expect(result).toEqual({ supported: false, registered: 0 });
  });

  it('registers every tool on the host it is given', async () => {
    const { host, seen } = recorder();

    const result = await registerSiteTools([tool('a'), tool('b')], () => [host]);

    expect(seen).toEqual(['a', 'b']);
    expect(result).toEqual({ supported: true, registered: 2 });
  });

  it('registers on every distinct host, so Chrome and ChatGPT both see the tools', async () => {
    const chrome = recorder();
    const chatgpt = recorder();

    const result = await registerSiteTools([tool('a'), tool('b')], () => [chrome.host, chatgpt.host]);

    expect(chrome.seen).toEqual(['a', 'b']);
    expect(chatgpt.seen).toEqual(['a', 'b']);
    // Counted once: the page has two tools, not four.
    expect(result).toEqual({ supported: true, registered: 2 });
  });

  it('registers once when both globals point at the same host object', async () => {
    const { host, seen } = recorder();

    const result = await registerSiteTools([tool('a')], () => [host, host]);

    expect(seen).toEqual(['a']);
    expect(result).toEqual({ supported: true, registered: 1 });
  });

  it('turns a host rejection into a result instead of throwing', async () => {
    const host: ModelContextHost = {
      registerTool: async () => {
        throw new Error('duplicate name');
      },
    };

    const result = await registerSiteTools([tool('a')], () => [host]);

    expect(result.supported).toBe(true);
    expect(result.registered).toBe(0);
    expect(result.error).toBe('duplicate name');
  });
});
