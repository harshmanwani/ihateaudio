import { test, expect, type Page } from '@playwright/test';
import { dropGeneratedAudio, waitForWorkspace } from './helpers';

/**
 * The site-level agent tools: discovery from any page including the homepage,
 * navigation, hand-off of audio between tools without a re-upload, and loading
 * from a URL. Together these are what let one request run as a whole workflow
 * with the person choosing a file once.
 */

type Registered = {
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean };
  execute: (input: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
};

type ShimWindow = Window & { __siteTools?: Record<string, Registered> };

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

async function names(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys((window as ShimWindow).__siteTools ?? {}).sort());
}

async function call(page: Page, name: string, input: Record<string, unknown> = {}) {
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

/** A 16-bit mono WAV of a steady tone, built in Node for route responses. */
function wavBytes(seconds: number, sampleRate = 44100): Buffer {
  const frames = Math.round(sampleRate * seconds);
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5;
    buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return buffer;
}

test.describe('site-level agent tools', () => {
  test('the homepage lists every tool with its action and can open one', async ({ page }) => {
    await shimHost(page);
    await page.goto('/');

    await expect(page.locator('[data-agent-status]')).toHaveText('2 agent tools ready');
    expect(await names(page)).toEqual(['list_tools', 'open_tool']);

    const catalog = await call(page, 'list_tools');
    const tools = catalog.tools as { slug: string; url: string; action?: { name: string; params: string[] } }[];
    expect(tools.length).toBeGreaterThan(40);
    const trimmer = tools.find((tool) => tool.slug === 'audio-trimmer');
    expect(trimmer?.url).toMatch(/\/audio-trimmer$/);
    expect(trimmer?.action).toMatchObject({ name: 'set_trim', params: ['startSec', 'endSec', 'mode', 'fade'] });
    const converter = tools.find((tool) => tool.slug === 'audio-converter');
    expect(converter?.action).toBeUndefined();

    const opened = await call(page, 'open_tool', { slug: 'silence-remover' });
    expect(opened.opening).toBe('/silence-remover');
    await page.waitForURL('**/silence-remover');
    await expect(page.locator('[data-agent-status]')).toContainText('agent tools ready');
    expect(await names(page)).toContain('set_silence_removal');
  });

  test('open_tool refuses a slug that is not a tool', async ({ page }) => {
    await shimHost(page);
    await page.goto('/');
    const refused = await call(page, 'open_tool', { slug: 'admin' });
    expect(refused.error).toBeTruthy();
    expect(page.url()).toMatch(/\/$/);
  });

  test('send_to_tool hands the rendered result to the next tool without a re-upload', async ({
    page,
  }) => {
    await shimHost(page);
    await page.goto('/audio-trimmer');
    await dropGeneratedAudio(page, { seconds: 4, channels: 1 });
    await waitForWorkspace(page);

    await call(page, 'set_trim', { startSec: 1, endSec: 3, mode: 'keep' });
    const sent = await call(page, 'send_to_tool', { slug: 'silence-remover' });
    expect(sent.sentTo).toBe('silence-remover');
    expect(sent.durationSec as number).toBeCloseTo(2, 1);

    await page.waitForURL('**/silence-remover');
    await waitForWorkspace(page);
    const inspection = await call(page, 'inspect_audio');
    expect(inspection.ready).toBe(true);
    expect((inspection.audio as { durationSec: number }).durationSec).toBeCloseTo(2, 1);
    expect((inspection.file as { name: string }).name).toMatch(/trimmed/);
  });

  test('load_audio_from_url opens a public file so a job can run hands-free', async ({ page }) => {
    await shimHost(page);
    const body = wavBytes(3);
    await page.route('https://media.example/sample.wav', (route) =>
      route.fulfill({
        body,
        contentType: 'audio/wav',
        headers: { 'access-control-allow-origin': '*' },
      })
    );
    await page.goto('/audio-normalizer');

    const loaded = await call(page, 'load_audio_from_url', { url: 'https://media.example/sample.wav' });
    expect(loaded.loaded).toBe(true);
    await waitForWorkspace(page);
    const inspection = await call(page, 'inspect_audio');
    expect(inspection.ready).toBe(true);
    expect((inspection.file as { name: string }).name).toBe('sample.wav');
    expect((inspection.audio as { durationSec: number }).durationSec).toBeCloseTo(3, 1);
  });

  test('load_audio_from_url accepts a localhost URL, so an agent with a shell can serve a file', async ({
    page,
  }) => {
    await shimHost(page);
    await page.route('http://localhost:9977/attached.wav', (route) =>
      route.fulfill({
        body: wavBytes(2),
        contentType: 'audio/wav',
        headers: { 'access-control-allow-origin': '*' },
      })
    );
    await page.goto('/audio-trimmer');
    const loaded = await call(page, 'load_audio_from_url', { url: 'http://localhost:9977/attached.wav' });
    expect(loaded.loaded).toBe(true);
    await waitForWorkspace(page);
    expect(((await call(page, 'inspect_audio')).file as { name: string }).name).toBe('attached.wav');
  });

  test('load_audio_from_url reports a fetch failure instead of hanging', async ({ page }) => {
    await shimHost(page);
    await page.route('https://media.example/missing.wav', (route) => route.fulfill({ status: 404 }));
    await page.goto('/audio-normalizer');
    const failed = await call(page, 'load_audio_from_url', { url: 'https://media.example/missing.wav' });
    expect(failed.error).toBeTruthy();
  });
});
