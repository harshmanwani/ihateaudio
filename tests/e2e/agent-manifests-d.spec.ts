import { test, expect, type Page } from '@playwright/test';
import { dropGeneratedAudio, waitForWorkspace } from './helpers';

/**
 * One row per tool that declares an `agent` manifest. Each row proves the same
 * three things: the page registers the base tools plus its own action, the
 * action lands values on the visible controls, and the reply echoes those
 * controls back so the agent can confirm what it changed.
 *
 * The stereo widener switches its controls off for the dual-mono file the
 * helper generates. The runtime still sets the slider and reads it back, which
 * is the contract this spec checks; the effect on the audio is a unit-test job.
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
    path: '/stereo-widener',
    count: 5,
    action: 'set_stereo_width',
    input: { width: 1.6 },
    settings: { width: '1.6' },
  },
  {
    path: '/tempo-changer',
    count: 5,
    action: 'set_tempo',
    input: { tempoPercent: 75, bpm: 120 },
    settings: { tempo: '75', bpm: '120' },
  },
  {
    path: '/voice-changer',
    count: 5,
    action: 'set_voice',
    input: { preset: 'telephone', semitones: -3 },
    settings: { preset: 'telephone', pitch: '-3' },
  },
  {
    path: '/waveform-generator',
    count: 5,
    action: 'set_waveform_image',
    input: {
      style: 'line',
      widthPx: 1200,
      heightPx: 300,
      waveColor: '#ff0000',
      transparent: true,
    },
    // Typing a size by hand moves the preset to custom, which the page does on
    // the width input's own listener.
    settings: {
      width: '1200',
      height: '300',
      wave: '#ff0000',
      transparent: 'true',
      preset: 'custom',
    },
    pressed: '[data-style="line"]',
  },
  {
    path: '/wav-converter',
    count: 5,
    action: 'set_wav_bit_depth',
    input: { bitDepth: '24' },
    settings: { bitdepth: '24' },
    pressed: '[data-depth="24"]',
  },
  {
    path: '/audio-transcriber',
    count: 5,
    action: 'set_transcript_layout',
    input: { paragraphs: false },
    settings: { paragraphs: 'false' },
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
