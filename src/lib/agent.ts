/**
 * The manifest a tool page hands to the shared runtime to describe itself to an
 * agent.
 *
 * Nothing in here touches the DOM. The runtime turns a manifest into a WebMCP
 * tool and applies the coerced values through the same controls a person uses.
 * Keeping this half pure means the schema and the clamping can be unit tested
 * without a browser, and a page can be certain an agent never reaches its
 * process function with a value the interface itself could not represent.
 */

import type { ToolRuntime } from './tool';

export type AgentParamType = 'number' | 'boolean' | 'string';

export interface AgentParam {
  /** The name the agent uses. Also the `data-control` name unless `control` says otherwise. */
  key: string;
  description: string;
  type: AgentParamType;
  min?: number;
  max?: number;
  enum?: string[];
  /** The `data-control` this lands on, when its name differs from `key`. */
  control?: string;
  /**
   * Custom setter for state that is not a `data-control`, such as a mode held
   * in a page variable. The runtime passes itself so the page can reach root.
   */
  apply?: (value: ParamValue, runtime: ToolRuntime) => void;
}

export interface AgentManifest {
  /** WebMCP tool name, e.g. `set_silence_removal`. */
  name: string;
  description: string;
  params: AgentParam[];
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties: false;
}

export type ParamValue = number | boolean | string;

export interface CoercedParams {
  values: Record<string, ParamValue>;
  /** Keys the agent sent that were dropped, so the reply can say so. */
  ignored: string[];
}

/** A closed schema where every knob is optional: an agent moves one at a time. */
export function schemaFor(manifest: AgentManifest): JsonSchema {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const param of manifest.params) {
    const property: Record<string, unknown> = {
      type: param.type,
      description: param.description,
    };
    if (param.type === 'number') {
      if (param.min !== undefined) property.minimum = param.min;
      if (param.max !== undefined) property.maximum = param.max;
    }
    if (param.type === 'string' && param.enum) property.enum = [...param.enum];
    properties[param.key] = property;
  }
  return { type: 'object', properties, additionalProperties: false };
}

/**
 * Keeps only declared keys of the right type, clamping numbers into range.
 *
 * Clamping rather than rejecting: an agent asking for -200 dB wants "as quiet
 * as it goes", and the slider it is standing in for would have stopped at its
 * end too. A wrong type is a different matter and is dropped.
 */
export function coerceParams(
  manifest: AgentManifest,
  input: Record<string, unknown>
): CoercedParams {
  const values: Record<string, ParamValue> = {};
  const ignored: string[] = [];
  const declared = new Map(manifest.params.map((param) => [param.key, param]));

  for (const [key, raw] of Object.entries(input)) {
    const param = declared.get(key);
    if (!param) {
      ignored.push(key);
      continue;
    }

    if (param.type === 'number') {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) {
        ignored.push(key);
        continue;
      }
      let value = raw;
      if (param.min !== undefined) value = Math.max(param.min, value);
      if (param.max !== undefined) value = Math.min(param.max, value);
      values[key] = value;
    } else if (param.type === 'boolean') {
      if (typeof raw !== 'boolean') {
        ignored.push(key);
        continue;
      }
      values[key] = raw;
    } else {
      if (typeof raw !== 'string' || (param.enum && !param.enum.includes(raw))) {
        ignored.push(key);
        continue;
      }
      values[key] = raw;
    }
  }

  return { values, ignored };
}

/** The reply shape WebMCP expects: structured content the agent can read back. */
export function textResult(data: Record<string, unknown>): {
  content: { type: 'text'; text: string }[];
} {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/** `set_loudness_target` → "Set loudness target": the title hosts display beside the name. */
export function titleFor(name: string): string {
  const [first = '', ...rest] = name.split('_').filter(Boolean);
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

/**
 * The option a select would land on for a number it has no exact match for.
 *
 * A `<select>` given a value it does not contain goes blank, which is worse
 * than either refusing or rounding. Rounding to the nearest numeric option is
 * what a person does when the bitrate they wanted is not in the list.
 */
export function nearestOption(options: string[], wanted: number): string | null {
  let best: string | null = null;
  let distance = Number.POSITIVE_INFINITY;
  for (const option of options) {
    const value = Number(option);
    if (option.trim() === '' || !Number.isFinite(value)) continue;
    const gap = Math.abs(value - wanted);
    if (gap < distance) {
      distance = gap;
      best = option;
    }
  }
  return best;
}
