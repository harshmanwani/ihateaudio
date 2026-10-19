import { test, expect, type Page } from '@playwright/test';
import { dropGeneratedAudio, captureDownload, getDownloads, waitForWorkspace } from './helpers';

/**
 * M4A, M4R and AAC without the 31 MB ffmpeg core.
 *
 * The core needs WebAssembly SIMD, which Safari only compiles from 16.4. On
 * iOS 15 the ringtone maker downloaded 31 MB for every press and failed every
 * time. These run the light AAC encoder in a real browser, where the core
 * cannot run and where it fails to load, and check what the page says about
 * the formats that have no light encoder.
 */

/** Makes this Chromium answer the core's SIMD probe the way Safari 15 does. */
async function withoutSimd(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const validate = WebAssembly.validate.bind(WebAssembly);
    // The probe is the only 31-byte module the site validates.
    WebAssembly.validate = (bytes: BufferSource) => (bytes.byteLength === 31 ? false : validate(bytes));
  });
}

/** Records what the page sends, with analytics otherwise off in the test build. */
async function recordEvents(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const events: [string, Record<string, unknown>][] = [];
    (window as unknown as { __events: typeof events }).__events = events;
    (window as unknown as { posthog: unknown }).posthog = {
      capture: (event: string, props: Record<string, unknown>) => events.push([event, props]),
    };
  });
}

function events(page: Page): Promise<[string, Record<string, unknown>][]> {
  return page.evaluate(() => (window as unknown as { __events: [string, Record<string, unknown>][] }).__events);
}

/** Every request for the ffmpeg core, from the page and its workers. */
function coreRequests(page: Page): string[] {
  const seen: string[] = [];
  page.context().on('request', (request) => {
    if (request.url().includes('/ffmpeg/')) seen.push(request.url());
  });
  return seen;
}

/** The download's boxes, read in the page: an MP4 with an AAC sample entry. */
async function readDownload(page: Page): Promise<{ boxes: string[]; codec: boolean; seconds: number | null }> {
  return page.evaluate(async () => {
    const store = (window as unknown as { __downloads: { href: string }[] }).__downloads;
    const bytes = new Uint8Array(await (await fetch(store[0]!.href)).arrayBuffer());
    const view = new DataView(bytes.buffer);
    const boxes: string[] = [];
    for (let at = 0; at + 8 <= bytes.length; ) {
      boxes.push(String.fromCharCode(...bytes.slice(at + 4, at + 8)));
      at += view.getUint32(at);
    }
    const text = String.fromCharCode(...bytes.slice(0, 4096));
    let seconds: number | null = null;
    try {
      const context = new OfflineAudioContext(1, 1, 44100);
      seconds = (await context.decodeAudioData(bytes.buffer.slice(0))).duration;
    } catch {
      /* A browser build without an AAC decoder; the boxes still say what it is. */
    }
    return { boxes, codec: text.includes('mp4a') && text.includes('esds'), seconds };
  });
}

test.describe('AAC without the ffmpeg core', () => {
  test('makes an M4R where the core cannot run, and never asks for it', async ({ page }) => {
    const requested = coreRequests(page);
    await withoutSimd(page);
    await recordEvents(page);

    await page.goto('/ringtone-maker');
    await captureDownload(page);
    await dropGeneratedAudio(page, { seconds: 20 });
    await waitForWorkspace(page);

    // The ringtone maker's only format has a light encoder, so nothing warns.
    await expect(page.locator('[data-format] option')).toHaveText(['M4R (iPhone ringtone)']);
    await expect(page.locator('[data-engine-note]')).toHaveCount(0);

    await page.click('[data-download]');
    await expect.poll(async () => (await getDownloads(page)).length, { timeout: 60_000 }).toBe(1);

    const [download] = await getDownloads(page);
    expect(download!.name).toMatch(/\.m4r$/);
    expect(download!.size).toBeGreaterThan(100_000);
    const file = await readDownload(page);
    expect(file.boxes).toEqual(['ftyp', 'moov', 'mdat']);
    expect(file.codec).toBe(true);
    if (file.seconds !== null) expect(file.seconds).toBeCloseTo(20, 1);

    await expect(page.locator('[role="alert"]')).toBeHidden();
    expect(requested).toEqual([]);
    expect(await events(page)).toContainEqual([
      'engine_fallback',
      expect.objectContaining({ format: 'm4r', reason: 'no-simd', aac_engine: 'wasm' }),
    ]);
  });

  test('makes the M4R anyway when the core fails to load, and stops asking for it', async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, 'The core path is desktop-only in this suite');
    const requested = coreRequests(page);
    await page.route('**/ffmpeg/**', (route) => route.abort('failed'));
    await recordEvents(page);

    await page.goto('/ringtone-maker');
    await captureDownload(page);
    await dropGeneratedAudio(page, { seconds: 8 });
    await waitForWorkspace(page);

    await page.click('[data-download]');
    await expect.poll(async () => (await getDownloads(page)).length, { timeout: 60_000 }).toBe(1);
    await expect(page.locator('[role="alert"]')).toBeHidden();
    const asked = requested.length;
    expect(asked).toBeGreaterThan(0);

    // The second ringtone goes straight to the light encoder.
    await page.click('[data-download]');
    await expect.poll(async () => (await getDownloads(page)).length, { timeout: 60_000 }).toBe(2);
    expect(requested.length).toBe(asked);

    const fallbacks = (await events(page)).filter(([name]) => name === 'engine_fallback');
    expect(fallbacks[0]![1]).toMatchObject({ format: 'm4r', reason: 'load-failed', stage: 'download' });
    expect(fallbacks[1]![1]).toMatchObject({ reason: 'failed-before' });
    expect((await events(page)).filter(([name]) => name === 'tool_error')).toEqual([]);
  });

  test('uses the JavaScript build where the CSP refuses WebAssembly', async ({ page }) => {
    await withoutSimd(page);
    await recordEvents(page);
    // Safari 15 does not know 'wasm-unsafe-eval', so under the site's CSP it
    // compiles no WebAssembly at all. A worker runs under the policy on its own
    // response, so this one gets a policy without the keyword. Only the
    // context, not the page, sees the worker's script request.
    await page.context().route('**/*', async (route) => {
      if (!/encode-aac\.worker/.test(route.request().url())) return route.continue();
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'content-security-policy': "script-src 'self'" },
      });
    });

    await page.goto('/m4a-converter');
    await captureDownload(page);
    await dropGeneratedAudio(page, { seconds: 5 });
    await waitForWorkspace(page);

    await page.click('[data-download]');
    await expect.poll(async () => (await getDownloads(page)).length, { timeout: 90_000 }).toBe(1);
    const [download] = await getDownloads(page);
    expect(download!.name).toMatch(/\.m4a$/);
    expect((await readDownload(page)).codec).toBe(true);
    expect(await events(page)).toContainEqual([
      'engine_fallback',
      expect.objectContaining({ format: 'm4a', aac_engine: 'js' }),
    ]);
  });

  test('says before any download that OGG cannot be written here, and what can', async ({ page }) => {
    const requested = coreRequests(page);
    await withoutSimd(page);
    await recordEvents(page);

    // The page that offers every format: only those with no engine here are marked.
    await page.goto('/audio-converter');
    await expect(page.locator('[data-format] option[value="ogg"]')).toHaveText(/not in this browser/);
    for (const id of ['mp3', 'wav', 'm4a', 'm4r', 'aac']) {
      await expect(page.locator(`[data-format] option[value="${id}"]`)).not.toHaveText(/not in this browser/);
    }

    await captureDownload(page);
    await dropGeneratedAudio(page, { seconds: 3 });
    await waitForWorkspace(page);
    await page.selectOption('[data-format]', 'ogg');
    await expect(page.locator('[data-engine-note]')).toContainText(/MP3 and WAV work/);

    await page.click('[data-download]');
    await expect(page.locator('[data-alert-title]')).toHaveText(/can't run the converter/);
    expect(requested).toEqual([]);
    expect(await events(page)).toContainEqual([
      'tool_error',
      expect.objectContaining({ code: 'ffmpeg-unsupported', blocker: 'no-simd', stage: 'support' }),
    ]);

    // Moving to a format that works takes the note away and exports.
    await page.selectOption('[data-format]', 'mp3');
    await expect(page.locator('[data-engine-note]')).toHaveCount(0);
    await page.click('[data-download]');
    await expect.poll(async () => (await getDownloads(page)).length, { timeout: 60_000 }).toBe(1);
  });
});
