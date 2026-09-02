import { test, expect, type Page } from '@playwright/test';
import { dropGeneratedAudio, waitForWorkspace } from './helpers';

/**
 * The second batch of tools that declare an `agent` manifest. Same harness as
 * agent-manifests.spec.ts: each row proves the page registers the base tools
 * plus its own action, the action lands values on the visible controls, and
 * the reply echoes those controls back.
 *
 * Two rows load a pair of files, because a joiner with one file has nothing to
 * join and the crossfade slider's ceiling depends on the shortest file.
 */

/** Same shape as the registry in agent-tools.spec.ts, which augments Window globally. */
type Registered = {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
  execute: (input: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
};

/** Typed locally, so the agent specs never fight over one global. */
type ShimWindow = Window & { __siteTools?: Record<string, Registered> };

interface Case {
  path: string;
  /** Base tools plus the manifest action. */
  count: number;
  action: string;
  input: Record<string, unknown>;
  /** `data-control` name → value the page reports after the call. */
  settings: Record<string, string>;
  /** A button that must read pressed afterwards, for mode held in page state. */
  pressed?: string;
  /** Extra inputs that are not `data-control`s: selector → value. */
  fields?: Record<string, string>;
  /** Load two files rather than one, for the joiners. */
  files?: 'one' | 'two';
}

const CASES: Case[] = [
  {
    path: '/bpm-detector',
    // Base tools, set_selection (the page passes `selection`), and the action.
    count: 10,
    action: 'set_analysis_range',
    input: { selectionOnly: true },
    settings: { selected: 'true' },
  },
  {
    path: '/crossfade-joiner',
    count: 9,
    action: 'set_crossfade',
    // Two 4-second files cap the slider at 2 s, so 1.5 lands as sent.
    input: { fadeSec: 1.5 },
    settings: { fade: '1.5' },
    files: 'two',
  },
  {
    path: '/audio-joiner',
    count: 9,
    action: 'set_join_gap',
    input: { gapSec: 1.5 },
    settings: { gap: '1.5' },
    files: 'two',
  },
  {
    path: '/dynamic-compressor',
    count: 9,
    action: 'set_compressor',
    input: { thresholdDb: -24, ratio: 3.5, attackMs: 20, releaseMs: 250 },
    // Moving a slider by hand detaches the preset.
    settings: { preset: 'custom', threshold: '-24', ratio: '3.5', attack: '20', release: '250' },
  },
  {
    path: '/echo-adder',
    count: 9,
    action: 'set_echo',
    // The preset lands first and sets all three; the mix then overrides one.
    input: { preset: 'dub', mixPercent: 30 },
    settings: { delay: '600', feedback: '75', mix: '30' },
  },
  {
    path: '/equalizer',
    count: 9,
    action: 'set_equalizer',
    // The bass preset lifts 60 Hz to +9; the band then moves 1 kHz and turns the
    // preset to custom, as a typed value would.
    input: { preset: 'bass', band1000Hz: 3 },
    settings: { preset: 'custom' },
    fields: { '[data-eq-val="60"]': '9', '[data-eq-val="1000"]': '3' },
  },
  {
    path: '/nightcore-maker',
    count: 9,
    action: 'set_nightcore',
    input: { preset: 'hyper' },
    settings: { rate: '1.4' },
    pressed: '[data-preset="1.4"]',
  },
];

async function shimHost(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const shim = window as ShimWindow;
    shim.__siteTools = {};
    Object.defineProperty(Document.prototype, 'modelContext', {
      configurable: true,
      get: () => ({
        registerTool: async (tool: Registered) => {
          shim.__siteTools![tool.name] = tool;
        },
      }),
    });
  });
}

/** Two generated WAVs in one drop, the way functional.spec.ts feeds the joiner. */
async function dropTwoGeneratedFiles(page: Page, seconds: number): Promise<void> {
  await page.evaluate((secs) => {
    const make = (name: string, freq: number): File => {
      const rate = 44100;
      const frames = rate * secs;
      const bytes = new ArrayBuffer(44 + frames * 2);
      const dv = new DataView(bytes);
      const ascii = (offset: number, text: string): void => {
        for (let i = 0; i < text.length; i += 1) dv.setUint8(offset + i, text.charCodeAt(i));
      };
      ascii(0, 'RIFF');
      dv.setUint32(4, 36 + frames * 2, true);
      ascii(8, 'WAVE');
      ascii(12, 'fmt ');
      dv.setUint32(16, 16, true);
      dv.setUint16(20, 1, true);
      dv.setUint16(22, 1, true);
      dv.setUint32(24, rate, true);
      dv.setUint32(28, rate * 2, true);
      dv.setUint16(32, 2, true);
      dv.setUint16(34, 16, true);
      ascii(36, 'data');
      dv.setUint32(40, frames * 2, true);
      for (let i = 0; i < frames; i += 1) {
        const v = Math.sin((2 * Math.PI * freq * i) / rate) * 0.5;
        dv.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true);
      }
      return new File([bytes], name, { type: 'audio/wav' });
    };

    const input = document.querySelector<HTMLInputElement>('[data-file-input]');
    if (!input) throw new Error('No file input on this page');
    const transfer = new DataTransfer();
    transfer.items.add(make('first.wav', 300));
    transfer.items.add(make('second.wav', 500));
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, seconds);
}

async function call(page: Page, name: string, input: Record<string, unknown>) {
  return page.evaluate(
    async ([toolName, args]) => {
      const result = await (window as ShimWindow).__siteTools![toolName as string].execute(
        args as Record<string, unknown>
      );
      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    },
    [name, input] as const
  );
}

for (const item of CASES) {
  test(`${item.path} registers ${item.action} and applies it to the visible controls`, async ({
    page,
  }) => {
    await shimHost(page);
    await page.goto(item.path);

    await expect(page.locator('[data-agent-status]')).toHaveText(
      `${item.count} agent tools ready`
    );
    const names = await page.evaluate(() =>
      Object.keys((window as ShimWindow).__siteTools ?? {})
    );
    expect(names).toContain(item.action);

    if (item.files === 'two') await dropTwoGeneratedFiles(page, 4);
    else await dropGeneratedAudio(page, { seconds: 4, channels: 1 });
    await waitForWorkspace(page);

    const result = await call(page, item.action, item.input);
    expect(result.ignored).toEqual([]);
    expect(result.settings).toMatchObject(item.settings);

    for (const [control, value] of Object.entries(item.settings)) {
      const locator = page.locator(`[data-control="${control}"]`);
      if (value === 'true' || value === 'false') {
        if (value === 'true') await expect(locator).toBeChecked();
        else await expect(locator).not.toBeChecked();
      } else {
        await expect(locator).toHaveValue(value);
      }
    }
    for (const [selector, value] of Object.entries(item.fields ?? {})) {
      await expect(page.locator(selector)).toHaveValue(value);
    }
    if (item.pressed) {
      await expect(page.locator(item.pressed)).toHaveAttribute('aria-pressed', 'true');
    }
  });
}
