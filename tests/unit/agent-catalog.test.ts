import { describe, expect, it } from 'vitest';
import { extractAgentAction } from '../../src/lib/agent-catalog';

const page = `
  const tool = createTool({
    suffix: 'tightened',
    agent: {
      name: 'set_silence_removal',
      description: 'Set how quiet gaps are detected.',
      params: [
        { key: 'threshold', description: 'dBFS', type: 'number', min: -70, max: -20 },
        { key: 'minimumGapSec', control: 'min', description: 's', type: 'number', min: 0.1, max: 3 },
      ],
    },
    onReady(ctx, runtime) { const key = 'not-a-param'; },
    process(ctx) { return ctx.buffer; },
  });
`;

describe('extractAgentAction', () => {
  it('reads the action name and its parameter keys out of a page source', () => {
    expect(extractAgentAction(page)).toEqual({
      name: 'set_silence_removal',
      description: 'Set how quiet gaps are detected.',
      params: ['threshold', 'minimumGapSec'],
    });
  });

  it('returns null for a page with no manifest', () => {
    expect(extractAgentAction('createTool({ suffix: "x", process(ctx) { return ctx.buffer; } })')).toBeNull();
  });
});
