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
