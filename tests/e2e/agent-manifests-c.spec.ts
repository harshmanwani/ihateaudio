import { test, expect, type Page } from '@playwright/test';
import { dropGeneratedAudio, waitForWorkspace } from './helpers';

/**
 * One row per tool that declares an `agent` manifest. Each row proves the same
 * three things: the page registers the base tools plus its own action, the
 * action lands values on the visible controls, and the reply echoes those
 * controls back so the agent can confirm what it changed.
 *
 * The AI two-phase pages (noise remover, pitch shifter, slowed reverb, stem
 * splitter) only have their settings checked here; nothing triggers a model.
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
  /** Channels in the dropped file, for pages whose modes depend on the layout. */
  channels?: number;
}

const CASES: Case[] = [
  {
    path: '/noise-remover',
    count: 9,
    action: 'set_noise_reduction',
    input: { strength: 60 },
    settings: { amount: '60' },
  },
  {
    path: '/pitch-shifter',
    count: 9,
    action: 'set_pitch_shift',
    input: { semitones: 7, cents: -10 },
    settings: { semitones: '7', cents: '-10' },
  },
  {
    path: '/reverb-adder',
    count: 9,
    action: 'set_reverb',
    // Moving any of the three numbers switches the room select to custom.
    input: { decaySec: 3.5, mix: 20, preDelayMs: 40 },
    settings: { decay: '3.5', mix: '20', predelay: '40', space: 'custom' },
  },
  {
    path: '/sample-rate-converter',
    count: 9,
    action: 'set_sample_rate',
    input: { sampleRateHz: '16000' },
    settings: { rate: '16000' },
  },
  {
    path: '/slowed-reverb',
    count: 9,
    action: 'set_slowed_reverb',
    input: { speed: 0.8, mix: 30, decaySec: 3 },
    settings: { speed: '0.8', mix: '30', decay: '3' },
  },
  {
    path: '/stem-splitter',
    count: 9,
    action: 'set_stems',
    input: { vocals: true, drums: false, bass: true, other: false },
    settings: { vocals: 'true', drums: 'false', bass: 'true', other: 'false' },
  },
  {
    path: '/stereo-to-mono',
    count: 9,
    action: 'set_channel_mode',
    input: { mode: 'split' },
    settings: {},
    pressed: '[data-mode="split"]',
    // Split and mono are disabled on a one-channel file.
    channels: 2,
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

    await dropGeneratedAudio(page, { seconds: 4, channels: item.channels ?? 1 });
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
    if (item.pressed) {
      await expect(page.locator(item.pressed)).toHaveAttribute('aria-pressed', 'true');
    }
  });
}
