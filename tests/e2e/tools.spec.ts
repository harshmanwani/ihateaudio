import { test, expect } from '@playwright/test';
import {
  dropGeneratedAudio,
  captureDownload,
  getDownloads,
  waitForWorkspace,
} from './helpers';

test.describe('audio trimmer', () => {
  test('decodes a file and shows the workspace', async ({ page }) => {
    await page.goto('/audio-trimmer');

    // The dropzone must be there before any file exists.
    await expect(page.locator('[data-drop]')).toBeVisible();
    await expect(page.locator('[data-workspace]')).toBeHidden();

    await dropGeneratedAudio(page, { seconds: 5, gap: [2, 2.8] });
    await waitForWorkspace(page);

    await expect(page.locator('[data-filename]')).toHaveText('test-tone.wav');
    // Native sample rate must survive decoding, not be resampled to the device's.
    await expect(page.locator('[data-filemeta]')).toContainText('44.1 kHz');
    await expect(page.locator('[data-filemeta]')).toContainText('Stereo');
    await expect(page.locator('[data-filemeta]')).toContainText('0:05');
  });

  test('renders a waveform with actual signal in it', async ({ page }) => {
    await page.goto('/audio-trimmer');
    await dropGeneratedAudio(page, { seconds: 5, gap: [2, 2.8] });
    await waitForWorkspace(page);

    const painted = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-canvas]');
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const colours = new Set<string>();
      for (let i = 0; i < data.length; i += 4 * 97) {
        colours.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
      }
      return { width: canvas.width, distinctColours: colours.size };
    });

    expect(painted).not.toBeNull();
    expect(painted!.width).toBeGreaterThan(100);
    // Background plus waveform means more than one colour was drawn.
    expect(painted!.distinctColours).toBeGreaterThan(1);
  });

  test('selection handles move and update the timecode fields', async ({ page }) => {
    await page.goto('/audio-trimmer');
    await dropGeneratedAudio(page, { seconds: 10 });
    await waitForWorkspace(page);

    await expect(page.locator('[data-control="start"]')).toHaveValue('0:00.00');
    await expect(page.locator('[data-control="end"]')).toHaveValue('0:10.00');

    await page.fill('[data-control="start"]', '0:02.50');
    await page.locator('[data-control="start"]').press('Enter');
    await page.fill('[data-control="end"]', '0:06.00');
    await page.locator('[data-control="end"]').press('Enter');

    // The handle position must follow the typed value.
    const left = await page.locator('[data-handle="start"]').evaluate(
      (el) => (el as HTMLElement).style.left
    );
    expect(parseFloat(left)).toBeCloseTo(25, 0);

    await expect(page.locator('[data-size]')).toContainText('KB');
  });

  test('keyboard nudges the selection', async ({ page }) => {
    await page.goto('/audio-trimmer');
    await dropGeneratedAudio(page, { seconds: 10 });
    await waitForWorkspace(page);

    const handle = page.locator('[data-handle="start"]');
    await handle.focus();
    await handle.press('ArrowRight');
    await handle.press('ArrowRight');

    // Two 0.05s nudges.
    await expect(page.locator('[data-control="start"]')).toHaveValue('0:00.10');

    await handle.press('Shift+ArrowRight');
    await expect(page.locator('[data-control="start"]')).toHaveValue('0:01.10');
  });

  test('exports a valid MP3 of the selected range', async ({ page }) => {
    await page.goto('/audio-trimmer');
    await captureDownload(page);
    await dropGeneratedAudio(page, { seconds: 10 });
    await waitForWorkspace(page);

    await page.fill('[data-control="start"]', '0:02.00');
    await page.locator('[data-control="start"]').press('Enter');
    await page.fill('[data-control="end"]', '0:04.00');
    await page.locator('[data-control="end"]').press('Enter');

    await page.click('[data-download]');
    await expect.poll(async () => (await getDownloads(page)).length, {
      timeout: 30_000,
    }).toBe(1);

    const [download] = await getDownloads(page);
    expect(download.name).toBe('test-tone-trimmed.mp3');
    expect(download.type).toBe('audio/mpeg');
    // 2 seconds at 192 kbps is roughly 48 KB; allow generous slack.
    expect(download.size).toBeGreaterThan(20_000);
    expect(download.size).toBeLessThan(90_000);

    await expect(page.locator('[data-chain]')).toBeVisible();
  });

  test('exports WAV without loading any encoder', async ({ page }) => {
    await page.goto('/audio-trimmer');
    await captureDownload(page);
    await dropGeneratedAudio(page, { seconds: 3 });
    await waitForWorkspace(page);

    await page.selectOption('[data-format]', 'wav');
    // Quality is meaningless for a lossless format and must be hidden.
    await expect(page.locator('[data-quality-field]')).toBeHidden();

    await page.click('[data-download]');
    await expect.poll(async () => (await getDownloads(page)).length, {
      timeout: 20_000,
    }).toBe(1);

    const [download] = await getDownloads(page);
    expect(download.name).toBe('test-tone-trimmed.wav');
    // 3s stereo 44.1kHz 16-bit is about 529 KB.
    expect(download.size).toBeGreaterThan(500_000);
  });

  test('clearing returns to the dropzone', async ({ page }) => {
    await page.goto('/audio-trimmer');
    await dropGeneratedAudio(page, { seconds: 3 });
    await waitForWorkspace(page);

    await page.click('[data-reset]');
    await expect(page.locator('[data-drop]')).toBeVisible();
    await expect(page.locator('[data-workspace]')).toBeHidden();
  });
});

test.describe('conversion panel', () => {
  test('compares source to output and updates as settings change', async ({ page }) => {
    await page.goto('/mp3-converter');
    await dropGeneratedAudio(page, { seconds: 8, filename: 'recording.wav' });
    await waitForWorkspace(page);

    const panel = page.locator('[data-convert]');
    await expect(panel).toBeVisible();

    await expect(page.locator('[data-src-format]')).toHaveText('WAV');
    await expect(page.locator('[data-src-rate]')).toHaveText('44.1 kHz');
    await expect(page.locator('[data-src-channels]')).toHaveText('Stereo');
    await expect(page.locator('[data-out-format]')).toContainText('MP3');
    await expect(page.locator('[data-out-size]')).toContainText('smaller');

    // A lossless source into a lossy target is the good case, not a warning.
    await expect(page.locator('[data-convert-verdict] .note')).toHaveClass(
      /note--info/
    );

    const before = await page.locator('[data-out-size]').textContent();
    await page.selectOption('[data-quality]', '320');
    await expect(page.locator('[data-out-format]')).toContainText('320 kbps');
    // The size estimate must actually move, not just the label.
    await expect(page.locator('[data-out-size]')).not.toHaveText(before ?? '');
  });

  test('warns that lossless output cannot improve a compressed source', async ({
    page,
  }) => {
    await page.goto('/audio-converter');
    // Named .mp3 so the verdict logic treats the source as already-lossy,
    // which is the case worth warning about.
    await dropGeneratedAudio(page, { seconds: 5, filename: 'song.mp3' });
    await waitForWorkspace(page);

    await page.selectOption('[data-format]', 'wav');
    const verdict = page.locator('[data-convert-verdict] .note');
    await expect(verdict).toHaveClass(/note--warn/);
    await expect(verdict).toContainText(/will not improve/i);
  });

  test('lays out side by side on desktop and stacks on mobile', async ({
    page,
    isMobile,
  }) => {
    await page.goto('/mp3-converter');
    await dropGeneratedAudio(page, { seconds: 5 });
    await waitForWorkspace(page);

    const boxes = await page.locator('.convert__side').evaluateAll((nodes) =>
      nodes.map((n) => n.getBoundingClientRect().x)
    );
    expect(boxes).toHaveLength(2);

    if (isMobile) {
      expect(boxes[0]).toBeCloseTo(boxes[1], 0);
    } else {
      expect(boxes[1]).toBeGreaterThan(boxes[0] + 100);
    }
  });
});

test.describe('failure paths', () => {
  test('an undecodable file produces a real message, not a stuck spinner', async ({
    page,
  }) => {
    await page.goto('/audio-trimmer');

    await page.evaluate(() => {
      const junk = new Uint8Array(4096).fill(0x41);
      const file = new File([junk], 'broken.mp3', { type: 'audio/mpeg' });
      const input = document.querySelector<HTMLInputElement>('[data-file-input]');
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input!.files = transfer.files;
      input!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const alert = page.locator('[role="alert"]');
    await expect(alert).toBeVisible({ timeout: 20_000 });
    // The message must say what to do, not just that something failed.
    await expect(alert).toContainText(/decoded|corrupted|re-export/i);
    await expect(page.locator('[data-workspace]')).toBeHidden();
  });

  test('an empty file is rejected before decoding is attempted', async ({ page }) => {
    await page.goto('/audio-trimmer');

    await page.evaluate(() => {
      const file = new File([], 'empty.mp3', { type: 'audio/mpeg' });
      const input = document.querySelector<HTMLInputElement>('[data-file-input]');
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input!.files = transfer.files;
      input!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await expect(page.locator('[role="alert"]')).toContainText(/empty/i, {
      timeout: 15_000,
    });
  });

  // The failure is only designed if it is seen. Every action button on these
  // pages sits below the fold once a file is loaded, so an error rendered up by
  // the dropzone is an error reported to nobody.
  test('a failure is in view even when the action pressed was below the fold', async ({
    page,
  }) => {
    await page.goto('/audio-trimmer');
    await dropGeneratedAudio(page, { seconds: 5 });
    await waitForWorkspace(page);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const scrolled = await page.evaluate(() => window.scrollY);
    expect(scrolled, 'the page must actually be scrolled for this to mean anything')
      .toBeGreaterThan(300);

    await page.evaluate(() => {
      const junk = new Uint8Array(4096).fill(0x41);
      const file = new File([junk], 'broken.mp3', { type: 'audio/mpeg' });
      const input = document.querySelector<HTMLInputElement>('[data-file-input]');
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input!.files = transfer.files;
      input!.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const alert = page.locator('[role="alert"]');
    await expect(alert).toBeVisible({ timeout: 20_000 });

    // toBeVisible only means "rendered with a box" — it passes for something a
    // thousand pixels above the viewport, which is the whole bug.
    const box = await alert.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        height: window.innerHeight,
        width: window.innerWidth,
        right: rect.right,
      };
    });

    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(box.height + 1);
    expect(box.right).toBeLessThanOrEqual(box.width + 1);

    // And it must not have shoved the tool down the page to get there.
    expect(await page.evaluate(() => window.scrollY)).toBe(scrolled);
  });
});

test.describe('AI setup panel', () => {
  // The panel is a direct child of the .controls grid, whose columns are
  // auto-fit at a 236px minimum. Without an explicit full-row span it lands in
  // a single column, and the honest "39 MB, once" copy that is the whole point
  // of the panel wraps one word per line next to a button that overlaps it.
  for (const path of [
    '/subtitle-generator',
    '/audio-transcriber',
    '/vocal-remover',
    '/acapella-extractor',
    '/stem-splitter',
  ]) {
    test(`${path} offers the download across the full controls width`, async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, 'The grid is a single column on phones, so there is no bug to catch');

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(path);

      // The panel is wired in onReady, so it does not exist until a file has
      // decoded — which is also the only state anyone ever sees it in.
      await dropGeneratedAudio(page, { seconds: 5 });
      await waitForWorkspace(page);

      await expect(page.locator('[data-ai-offer]')).toBeVisible({ timeout: 15_000 });

      const measured = await page.evaluate(() => {
        const panel = document.querySelector('[data-ai-setup]')!.getBoundingClientRect();
        const grid = document.querySelector('.controls')!.getBoundingClientRect();
        const title = document.querySelector('.setup__title')!;
        const style = getComputedStyle(title);
        return {
          panel: panel.width,
          grid: grid.width,
          titleHeight: title.getBoundingClientRect().height,
          lineHeight: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5,
        };
      });

      expect(measured.panel).toBeGreaterThan(measured.grid - 2);
      // One line at 1440px. Six words stacked vertically is the symptom.
      expect(Math.round(measured.titleHeight / measured.lineHeight)).toBe(1);
    });
  }
});

test.describe('accessibility', () => {
  test('every form control on a loaded tool has an accessible name', async ({
    page,
  }) => {
    await page.goto('/audio-trimmer');
    await dropGeneratedAudio(page, { seconds: 3 });
    await waitForWorkspace(page);

    const unnamed = await page.evaluate(() => {
      const bad: string[] = [];
      const controls = document.querySelectorAll<HTMLElement>(
        'button, input:not([type="file"]), select, [role="slider"]'
      );

      for (const el of controls) {
        if (el.closest('[hidden]')) continue;

        const labelled =
          el.getAttribute('aria-label') ??
          el.getAttribute('aria-labelledby') ??
          (el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : null) ??
          el.closest('label')?.textContent ??
          el.textContent;

        if (!labelled || labelled.trim() === '') {
          bad.push(`${el.tagName}.${el.className}`);
        }
      }
      return bad;
    });

    expect(unnamed).toEqual([]);
  });

  test('the skip link is the first focusable element', async ({ page }) => {
    await page.goto('/audio-trimmer');
    await page.keyboard.press('Tab');
    await expect(page.locator(':focus')).toHaveClass(/skip-link/);
  });

  test('focus is always visible', async ({ page }) => {
    await page.goto('/');
    await page.locator('#tool-search').focus();

    const outline = await page.locator('#tool-search').evaluate((el) => {
      const style = getComputedStyle(el);
      return { outline: style.outlineWidth, shadow: style.boxShadow };
    });

    // Either an outline or a focus ring shadow must be present.
    const hasRing =
      parseFloat(outline.outline) > 0 || outline.shadow !== 'none';
    expect(hasRing).toBe(true);
  });
});

test.describe('responsive', () => {
  test('no horizontal overflow at any common width', async ({ page }) => {
    for (const width of [320, 375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/audio-trimmer');
      await dropGeneratedAudio(page, { seconds: 5 });
      await waitForWorkspace(page);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(overflow, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(1);
    }
  });

  /*
    The test above only visits the trimmer, whose controls are two timecode
    fields — it cannot fail on a control that is too wide, because it never
    loads one.

    Segmented controls are where that bites: their labels are `white-space:
    nowrap`, so each segment's minimum width is its whole label, and three long
    labels at 320px need more room than the column has. These are the pages with
    the longest ones, checked at the two widths where the difference shows.
  */
  test('tool pages with segmented controls fit a phone', async ({ page }) => {
    const pages = [
      'stereo-to-mono',
      'speed-changer',
      'tempo-changer',
      'audio-splitter',
      'volume-booster',
    ];

    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 900 });
      for (const slug of pages) {
        await page.goto(`/${slug}`);
        await dropGeneratedAudio(page, { seconds: 5 });
        await waitForWorkspace(page);

        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        expect(overflow, `${slug} overflows at ${width}px`).toBeLessThanOrEqual(1);
      }
    }
  });

  // Touch sizing keys off `pointer: coarse`, not viewport width — a narrow
  // desktop window driven by a mouse genuinely does not need 44px targets.
  // So this has to run on a project with real touch emulation.
  test('touch targets meet the 44px minimum on touch devices', async ({
    page,
    isMobile,
  }) => {
    test.skip(!isMobile, 'Touch sizing only applies to coarse pointers');

    await page.goto('/audio-trimmer');
    await dropGeneratedAudio(page, { seconds: 5 });
    await waitForWorkspace(page);

    const small = await page.evaluate(() => {
      const bad: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>('button')) {
        if (el.closest('[hidden]') || el.offsetParent === null) continue;
        const rect = el.getBoundingClientRect();
        if (rect.height > 0 && rect.height < 40) {
          bad.push(`${el.className || el.tagName}: ${Math.round(rect.height)}px`);
        }
      }
      return bad;
    });

    expect(small).toEqual([]);
  });
});
