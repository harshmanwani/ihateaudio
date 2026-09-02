import { describe, expect, it } from 'vitest';
import { registerSiteTools, type SiteTool } from '../../src/lib/webmcp';

const tool = (name: string): SiteTool => ({
  name,
  description: `${name} does a thing`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  execute: async () => ({ content: [{ type: 'text', text: '{}' }] }),
});

describe('registerSiteTools', () => {
  it('reports unsupported and registers nothing when no host exists', async () => {
    const result = await registerSiteTools([tool('a')], () => null);
    expect(result).toEqual({ supported: false, registered: 0 });
  });

  it('registers every tool on the host it is given', async () => {
    const seen: string[] = [];
    const host = { registerTool: async (t: SiteTool) => void seen.push(t.name) };

    const result = await registerSiteTools([tool('a'), tool('b')], () => host);

    expect(seen).toEqual(['a', 'b']);
    expect(result).toEqual({ supported: true, registered: 2 });
  });

  it('turns a host rejection into a result instead of throwing', async () => {
    const host = {
      registerTool: async () => {
        throw new Error('duplicate name');
      },
    };

    const result = await registerSiteTools([tool('a')], () => host);

    expect(result.supported).toBe(true);
    expect(result.registered).toBe(0);
    expect(result.error).toBe('duplicate name');
  });
});
