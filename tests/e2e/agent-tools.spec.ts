import { test, expect, type Page } from '@playwright/test';
import { dropGeneratedAudio, waitForWorkspace } from './helpers';

/**
 * Drives the agent layer the way ChatGPT or Chrome would: a WebMCP host is
 * shimmed onto the page before it loads, and the tools it registers are called
 * directly. The assertions are on the visible page — the controls, the report,
 * the result player — because that is the whole point of the layer: an agent
 * moves the same things a person does.
 */

type Registered = {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
  execute: (input: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
};

declare global {
  interface Window {
    __siteTools?: Record<string, Registered>;
  }
}

/** Installs a host on `navigator` (the standard) or `document` (ChatGPT). */
async function shimHost(page: Page, where: 'navigator' | 'document'): Promise<void> {
  await page.addInitScript((target) => {
    window.__siteTools = {};
    const host = {
      registerTool: async (tool: Registered) => {
        window.__siteTools![tool.name] = tool;
      },
    };
    const owner = target === 'navigator' ? Navigator.prototype : Document.prototype;
    Object.defineProperty(owner, 'modelContext', { configurable: true, get: () => host });
  }, where);
}

async function names(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(window.__siteTools ?? {}).sort());
}

async function call(page: Page, name: string, input: Record<string, unknown> = {}) {
  return page.evaluate(
    async ([toolName, args]) => {
      const result = await window.__siteTools![toolName as string].execute(
        args as Record<string, unknown>
      );
      return JSON.parse(result.content[0].text) as Record<string, unknown>;
    },
    [name, input] as const
  );
}

test.describe('agent tools on the shared runtime', () => {
  test('the trimmer exposes the base tools plus its own action, on the standard host', async ({
    page,
  }) => {
    await shimHost(page, 'navigator');
    await page.goto('/audio-trimmer');

    await expect(page.locator('[data-agent-status]')).toHaveText('6 agent tools ready');
    expect(await names(page)).toEqual([
      'export_download',
      'inspect_audio',
      'render_preview',
      'set_output_format',
      'set_selection',
      'set_trim',
    ]);

    const before = await call(page, 'inspect_audio');
    expect(before.ready).toBe(false);

    await dropGeneratedAudio(page, { seconds: 6, channels: 1 });
    await waitForWorkspace(page);

    const inspection = await call(page, 'inspect_audio');
    expect(inspection.ready).toBe(true);
    expect(inspection.audio).toMatchObject({ channels: 1 });
    expect(inspection.tool).toMatchObject({ slug: 'audio-trimmer' });

    // The semantic action moves the real controls: the selection handles, the
    // keep/cut mode held in a page variable, and the fade checkbox.
    const trimmed = await call(page, 'set_trim', {
      startSec: 1,
      endSec: 4,
      mode: 'cut',
      fade: true,
    });
    expect(trimmed.settings).toMatchObject({ fade: 'true' });
    await expect(page.locator('[data-control="start"]')).toHaveValue('0:01.00');
    await expect(page.locator('[data-control="end"]')).toHaveValue('0:04.00');
    await expect(page.locator('[data-mode="cut"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-control="fade"]')).toBeChecked();

    // A preview renders the result into its own player without downloading.
    const preview = await call(page, 'render_preview');
    expect(preview.previewReady).toBe(true);
    await expect(page.locator('[data-stem-panel="result"]')).not.toBeEmpty();
  });

  test('the silence remover clamps agent values and updates its live report', async ({
    page,
  }) => {
    await shimHost(page, 'document');
    await page.goto('/silence-remover');

    await expect(page.locator('[data-agent-status]')).toHaveText('5 agent tools ready');
    expect(await names(page)).toEqual([
      'export_download',
      'inspect_audio',
      'render_preview',
      'set_output_format',
      'set_silence_removal',
    ]);

    await dropGeneratedAudio(page, { seconds: 6, gap: [2, 3.2], channels: 1 });
    await waitForWorkspace(page);

    // -200 is outside the slider; it lands on the slider's floor instead.
    const result = await call(page, 'set_silence_removal', {
      threshold: -200,
      minimumGapSec: 0.5,
      paddingSec: 0.1,
    });
    expect(result.settings).toMatchObject({ threshold: '-70', min: '0.5', pad: '0.1' });
    await expect(page.locator('[data-control="threshold"]')).toHaveValue('-70');
    await expect(page.locator('[data-report-text]')).toContainText('gap');
  });

  test('the converter runs on the base tools alone', async ({ page }) => {
    await shimHost(page, 'document');
    await page.goto('/audio-converter');

    await expect(page.locator('[data-agent-status]')).toHaveText('4 agent tools ready');
    expect(await names(page)).toEqual([
      'export_download',
      'inspect_audio',
      'render_preview',
      'set_output_format',
    ]);

    await dropGeneratedAudio(page, { seconds: 3 });
    await waitForWorkspace(page);

    const changed = await call(page, 'set_output_format', { format: 'wav' });
    expect(changed.format).toMatchObject({ id: 'wav' });
    await expect(page.locator('[data-format]')).toHaveValue('wav');

    const refused = await call(page, 'set_output_format', { format: 'midi' });
    expect(refused.error).toBeTruthy();
    await expect(page.locator('[data-format]')).toHaveValue('wav');
  });

  test('a browser without a host keeps the page ordinary', async ({ page }) => {
    await page.goto('/audio-trimmer');
    await expect(page.locator('[data-agent-status]')).toBeHidden();
  });
});
