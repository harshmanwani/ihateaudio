import { test, expect, type Page } from '@playwright/test';
import { dropGeneratedAudio, waitForWorkspace } from './helpers';

/**
 * One row per tool that declares an `agent` manifest. Each row proves the same
 * three things: the page registers the base tools plus its own action, the
 * action lands values on the visible controls, and the reply echoes those
 * controls back so the agent can confirm what it changed.
 *
 * Same harness as agent-manifests.spec.ts; this file covers the second batch
 * of pages so one long table does not have to.
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
}

const CASES: Case[] = [
  {
    path: '/8d-audio-maker',
    count: 9,
    action: 'set_8d_effect',
    input: { secondsPerTurn: 8, distance: 2 },
    settings: { speed: '8', radius: '2' },
  },
  {
    // `selection` on ToolShell registers set_selection too, so one more tool.
    path: '/android-ringtone-maker',
    count: 10,
    action: 'set_ringtone',
    input: { startSec: 0.5, endSec: 3, fadeOut: true, fadeSec: 1 },
    settings: { start: '0:00.50', end: '0:03.00', fadeout: 'true', fade: '1' },
  },
  {
    path: '/ringtone-maker',
    count: 10,
    action: 'set_ringtone',
    input: { startSec: 1, endSec: 3.5, fadeOut: true, fadeSec: 2.5 },
    settings: { start: '0:01.00', end: '0:03.50', fadeout: 'true', fade: '2.5' },
  },
  {
    // 100 kbps is not an MP3 choice; the page snaps it to the nearest one, 96.
    path: '/audio-compressor',
    count: 9,
    action: 'set_compression',
    input: { bitrateKbps: 100, sampleRateHz: 16000, channels: 'mono' },
    settings: { bitrate: '96', rate: '16000' },
    pressed: '[data-channels="mono"]',
  },
  {
    path: '/audio-looper',
    count: 9,
    action: 'set_loop',
    input: { repeats: 5, gapSec: 1.5 },
    settings: { times: '5', gap: '1.5' },
  },
  {
    path: '/audio-splitter',
    count: 9,
    action: 'set_split',
    input: { method: 'silence', silenceThresholdDbfs: -40, minimumGapSec: 0.5 },
    settings: { threshold: '-40', gap: '0.5' },
    pressed: '[data-mode="silence"]',
  },
  {
    path: '/bass-booster',
    count: 9,
    action: 'set_bass_boost',
    input: { amountDb: 9, cornerHz: 120, keepLevel: false },
    settings: { amount: '9', corner: '120', fit: 'false' },
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

    await dropGeneratedAudio(page, { seconds: 4, channels: 1 });
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
