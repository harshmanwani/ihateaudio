import { test, expect } from '@playwright/test';
import { dropGeneratedAudio, captureDownload, getDownloads, waitForWorkspace } from './helpers';

/**
 * Tier 2: the 31 MB ffmpeg core. Slow by nature and skipped on mobile, but it
 * is the one path the cheaper tiers cannot stand in for, so it needs a real
 * end-to-end run rather than trust.
 */
test.describe('ffmpeg tier', () => {
  test.slow();

  test('exports M4A through the ffmpeg core', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Loading a 31 MB core under mobile emulation is not the point');

    await page.goto('/m4a-converter');
    await captureDownload(page);
    await dropGeneratedAudio(page, { seconds: 3 });
    await waitForWorkspace(page);

    await page.click('[data-download]');

    // The UI must say what the wait is for, not just spin.
    await expect(page.locator('[data-status]')).toContainText(/converter|loading/i, {
      timeout: 30_000,
    });

    await expect
      .poll(async () => (await getDownloads(page)).length, { timeout: 180_000 })
      .toBe(1);

    const [download] = await getDownloads(page);
    expect(download.name).toMatch(/\.m4a$/);
    expect(download.size).toBeGreaterThan(2000);
    await expect(page.locator('[role="alert"]')).toBeHidden();
  });

  test('produces an M4R ringtone', async ({ page, isMobile }) => {
    test.skip(isMobile, 'Core download size makes this desktop-only in CI');

    await page.goto('/ringtone-maker');
    await captureDownload(page);
    await dropGeneratedAudio(page, { seconds: 20 });
    await waitForWorkspace(page);

    await page.click('[data-download]');
    await expect
      .poll(async () => (await getDownloads(page)).length, { timeout: 180_000 })
      .toBe(1);

    const [download] = await getDownloads(page);
    expect(download.name).toMatch(/\.m4r$/);
    expect(download.size).toBeGreaterThan(2000);
  });
});

/**
 * HQ task #157: visitors on old iPhones pressed Download five and eight times
 * in a few minutes, and each press re-fetched the 31 MB core and failed the same
 * way. The core is blocked here so the failure is the same on every browser, and
 * what is checked is what the visitor sees and what the network is asked for.
 */
test.describe('ffmpeg core that will not load', () => {
  test('stops re-downloading it, says what to do instead, and reports why', async ({ page }) => {
    let coreRequests = 0;
    await page.route('**/ffmpeg/**', (route) => {
      coreRequests += 1;
      return route.abort();
    });

    // Stand-in for PostHog, so the events the page would send can be read back.
    await page.addInitScript(() => {
      const sent: [string, Record<string, unknown>][] = [];
      (window as unknown as { __sent: typeof sent }).__sent = sent;
      (window as unknown as { posthog: unknown }).posthog = {
        capture: (event: string, props: Record<string, unknown>) => sent.push([event, props]),
      };
    });

    await page.goto('/ringtone-maker');
    await dropGeneratedAudio(page, { seconds: 5 });
    await waitForWorkspace(page);

    const alert = page.locator('[data-alert]');
    const fix = page.locator('[data-alert-fix]');

    // First failure: could be the network, so the usual advice and a real retry.
    await page.click('[data-download]');
    await expect(alert).toBeVisible();
    await expect(fix).toContainText(/connection/i);
    expect(coreRequests).toBeGreaterThan(0);

    // Second failure: the page now knows this device cannot run it.
    await page.click('[data-download]');
    await expect(fix).toContainText(/GarageBand/);
    await expect(fix).not.toContainText(/connection/i);

    // From here on, pressing Download must not touch the network at all.
    const settled = coreRequests;
    for (let i = 0; i < 3; i += 1) {
      await page.click('[data-download]');
      await expect(fix).toContainText(/GarageBand/);
    }
    expect(coreRequests).toBe(settled);

    const errors = await page.evaluate(() =>
      (window as unknown as { __sent: [string, Record<string, unknown>][] }).__sent.filter(
        ([event]) => event === 'tool_error'
      )
    );
    expect(errors.length).toBeGreaterThanOrEqual(5);
    const [, first] = errors[0];
    expect(first).toMatchObject({ code: 'ffmpeg-load-failed', stage: 'load', attempt: 1 });
    expect(first.gave_up).toBe(false);
    expect(typeof first.cause).toBe('string');
    expect(errors[errors.length - 1][1]).toMatchObject({ stage: 'blocked', gave_up: true });

    // Nothing in what was sent may be free text: every value is a token or a flag.
    for (const [, props] of errors) {
      for (const value of Object.values(props)) {
        expect(String(value)).toMatch(/^[A-Za-z0-9:_-]{0,40}$/);
      }
    }
  });
});
