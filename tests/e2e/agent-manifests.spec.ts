import { test, expect, type Page } from '@playwright/test';
import { dropGeneratedAudio, waitForWorkspace } from './helpers';

/**
 * One row per tool that declares an `agent` manifest. Each row proves the same
 * three things: the page registers the base tools plus its own action, the
 * action lands values on the visible controls, and the reply echoes those
 * controls back so the agent can confirm what it changed.
 */

/** Same shape as the registry in agent-tools.spec.ts, which augments Window globally. */
type Registered = {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
  execute: (input: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
};

/** Typed locally, so the two agent specs never fight over one global. */
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
    path: '/fade-in-out',
    count: 9,
    action: 'set_fade',
    input: { fadeInSec: 1.5, fadeOutSec: 2, curve: 'linear' },
    settings: { in: '1.5', out: '2', curve: 'linear' },
  },
  {
    path: '/speed-changer',
    count: 9,
    action: 'set_speed',
    input: { speed: 1.5, keepPitch: true },
    settings: { speed: '1.5', 'keep-pitch': 'true' },
  },
  {
    path: '/volume-booster',
    count: 9,
    action: 'set_volume',
    input: { method: 'normalize', targetPeakDbfs: -3 },
    settings: { target: '-3' },
    pressed: '[data-mode="normalize"]',
  },
  {
    path: '/audio-normalizer',
    count: 9,
    action: 'set_loudness_target',
    input: { platform: 'custom', targetLufs: -16, ceilingDbtp: -2 },
    settings: { preset: 'custom', target: '-16', ceiling: '-2' },
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
