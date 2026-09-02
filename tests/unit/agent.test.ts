import { describe, expect, it } from 'vitest';
import { coerceParams, schemaFor, textResult, titleFor, type AgentManifest } from '../../src/lib/agent';

/** A manifest shaped like the silence remover's, plus one enum and one flag. */
const manifest: AgentManifest = {
  name: 'remove_silence',
  description: 'Cut long quiet gaps.',
  params: [
    { key: 'threshold', description: 'Quiet below this dBFS.', type: 'number', min: -70, max: -20 },
    { key: 'fade', description: 'Fade the new edges.', type: 'boolean' },
    { key: 'mode', description: 'Keep or cut the selection.', type: 'string', enum: ['keep', 'cut'] },
  ],
};

describe('schemaFor', () => {
  it('turns a manifest into a closed JSON schema with one property per param', () => {
    const schema = schemaFor(manifest);

    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(['threshold', 'fade', 'mode']);
    expect(schema.properties.threshold).toEqual({
      type: 'number',
      description: 'Quiet below this dBFS.',
      minimum: -70,
      maximum: -20,
    });
    expect(schema.properties.fade).toEqual({ type: 'boolean', description: 'Fade the new edges.' });
    expect(schema.properties.mode).toEqual({
      type: 'string',
      description: 'Keep or cut the selection.',
      enum: ['keep', 'cut'],
    });
  });

  it('marks every param optional so an agent can change one knob at a time', () => {
    expect(schemaFor(manifest).required).toBeUndefined();
  });
});

describe('coerceParams', () => {
  it('keeps only the keys the agent sent', () => {
    const { values } = coerceParams(manifest, { fade: true });
    expect(values).toEqual({ fade: true });
  });

  it('clamps a number into the declared range instead of rejecting it', () => {
    expect(coerceParams(manifest, { threshold: 5 }).values).toEqual({ threshold: -20 });
    expect(coerceParams(manifest, { threshold: -200 }).values).toEqual({ threshold: -70 });
  });

  it('ignores a value of the wrong type and says which key it dropped', () => {
    const result = coerceParams(manifest, { threshold: 'loud', fade: 'yes' });
    expect(result.values).toEqual({});
    expect(result.ignored).toEqual(['threshold', 'fade']);
  });

  it('ignores a string outside its enum', () => {
    const result = coerceParams(manifest, { mode: 'shred' });
    expect(result.values).toEqual({});
    expect(result.ignored).toEqual(['mode']);
  });

  it('ignores keys the manifest never declared', () => {
    const result = coerceParams(manifest, { volume: 11 });
    expect(result.values).toEqual({});
    expect(result.ignored).toEqual(['volume']);
  });

  it('drops NaN and Infinity rather than clamping them', () => {
    const result = coerceParams(manifest, { threshold: Number.NaN });
    expect(result.values).toEqual({});
    expect(result.ignored).toEqual(['threshold']);
  });
});

describe('textResult', () => {
  it('wraps data as the text content block WebMCP hands back to the agent', () => {
    const result = textResult({ ready: true, gaps: 2 });
    expect(result).toEqual({
      content: [{ type: 'text', text: '{"ready":true,"gaps":2}' }],
    });
  });
});

describe('titleFor', () => {
  it('turns a snake_case tool name into the title Chrome DevTools shows', () => {
    expect(titleFor('inspect_audio')).toBe('Inspect audio');
    expect(titleFor('set_loudness_target')).toBe('Set loudness target');
  });
});
