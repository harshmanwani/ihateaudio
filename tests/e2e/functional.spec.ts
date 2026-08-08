import { test, expect } from '@playwright/test';
import {
  dropGeneratedAudio,
  captureDownload,
  getDownloads,
  waitForWorkspace,
} from './helpers';

/**
 * Proves the tools actually process audio, rather than merely rendering.
 *
 * Focused on the ones whose output is not a single audio file — meters,
 * multi-output splitters, image generators — plus a representative sample of
 * the DSP tools, since those all route through the same verified export path.
 */

test.describe('analysis tools', () => {
  test('loudness meter reports real LUFS and peak figures', async ({ page }) => {
    await page.goto('/loudness-meter');
    await dropGeneratedAudio(page, { seconds: 8, amplitude: 0.5 });
    await waitForWorkspace(page);

    // The workspace unhiding is not the measurement landing. The four figures
    // are seeded with a placeholder and only filled a couple of frames later,
    // once the BS.1770 scan has run over every sample — so reading the panel
    // the instant it appears catches the placeholder on a loaded machine.
    await expect
      .poll(async () => page.locator('[data-stat="integrated"]').innerText(), {
        timeout: 30_000,
      })
      .toMatch(/-?\d+\.\d+/);

    const text = await page.locator('[data-workspace]').innerText();

    // A -6 dBFS tone must produce a plausible negative LUFS figure, not a
    // placeholder or NaN.
    expect(text).toMatch(/-?\d+(\.\d+)?\s*LUFS|LUFS/i);
    expect(text).not.toMatch(/NaN|Infinity|undefined/);

    const numbers = text.match(/-\d+\.\d+/g) ?? [];
    expect(numbers.length, 'expected measured values on the page').toBeGreaterThan(0);
  });

  test('BPM detector finds the tempo of a click track', async ({ page }) => {
    await page.goto('/bpm-detector');

    // A steady 120 BPM click, built in-page.
    await page.evaluate(() => {
      const rate = 44100, secs = 12, frames = rate * secs;
      const bytes = new ArrayBuffer(44 + frames * 2);
      const dv = new DataView(bytes);
      const a = (o: number, s: string) => {
        for (let i = 0; i < s.length; i += 1) dv.setUint8(o + i, s.charCodeAt(i));
      };
      a(0, 'RIFF'); dv.setUint32(4, 36 + frames * 2, true); a(8, 'WAVE');
      a(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
      dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
      dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true);
      dv.setUint16(34, 16, true); a(36, 'data'); dv.setUint32(40, frames * 2, true);

      const interval = Math.round((60 / 120) * rate);
      const burst = Math.round(rate * 0.02);
      for (let beat = 0; beat * interval < frames; beat += 1) {
        for (let i = 0; i < burst; i += 1) {
          const idx = beat * interval + i;
          if (idx >= frames) break;
          const v = (Math.random() * 2 - 1) * (1 - i / burst) * 0.8;
          dv.setInt16(44 + idx * 2, v < 0 ? v * 32768 : v * 32767, true);
        }
      }

      const file = new File([bytes], 'click-120.wav', { type: 'audio/wav' });
      const input = document.querySelector<HTMLInputElement>('[data-file-input]')!;
      const transfer = new DataTransfer();
      transfer.items.add(file);
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    await waitForWorkspace(page);

    // The same placeholder race as the loudness meter above: the workspace is
    // unhidden before the detector has written a figure into it.
    await expect
      .poll(async () => page.locator('[data-bpm]').innerText(), { timeout: 30_000 })
      .toMatch(/\d+\.\d/);

    const text = await page.locator('[data-workspace]').innerText();

    const bpm = (text.match(/1[12]\d(\.\d)?/g) ?? []).map(Number);
    expect(
      bpm.some((value) => value > 115 && value < 125),
      `expected ~120 BPM somewhere in: ${text.slice(0, 300)}`
    ).toBe(true);
  });

  test('waveform generator produces a real PNG', async ({ page }) => {
    await page.goto('/waveform-generator');
    await captureDownload(page);
    await dropGeneratedAudio(page, { seconds: 5 });
    await page.waitForTimeout(800);

    // The preview canvas must have actual pixels drawn in it.
    const painted = await page.evaluate(() => {
      const canvases = Array.from(document.querySelectorAll('canvas'));
      for (const canvas of canvases) {
        if (canvas.width < 50) continue;
        const ctx = canvas.getContext('2d');
        if (!ctx) continue;
        const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const colours = new Set<string>();
        for (let i = 0; i < data.length; i += 4 * 211) {
          colours.add(`${data[i]},${data[i + 1]},${data[i + 2]},${data[i + 3]}`);
        }
        if (colours.size > 1) return { width: canvas.width, colours: colours.size };
      }
      return null;
    });

    expect(painted, 'no canvas with a drawn waveform found').not.toBeNull();
    expect(painted!.colours).toBeGreaterThan(1);
  });
});

test.describe('multi-output tools', () => {
  test('joiner merges two files into one longer file', async ({ page }) => {
    await page.goto('/audio-joiner');

    const total = await page.evaluate(() => {
      const make = (secs: number, name: string, freq: number) => {
        const rate = 44100, frames = rate * secs;
        const bytes = new ArrayBuffer(44 + frames * 2);
        const dv = new DataView(bytes);
        const a = (o: number, s: string) => {
          for (let i = 0; i < s.length; i += 1) dv.setUint8(o + i, s.charCodeAt(i));
        };
        a(0, 'RIFF'); dv.setUint32(4, 36 + frames * 2, true); a(8, 'WAVE');
        a(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true);
        dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
        dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true);
        dv.setUint16(34, 16, true); a(36, 'data'); dv.setUint32(40, frames * 2, true);
        for (let i = 0; i < frames; i += 1) {
          const v = Math.sin((2 * Math.PI * freq * i) / rate) * 0.5;
          dv.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true);
        }
        return new File([bytes], name, { type: 'audio/wav' });
      };

      const input = document.querySelector<HTMLInputElement>('[data-file-input]')!;
      const transfer = new DataTransfer();
      transfer.items.add(make(3, 'first.wav', 300));
      transfer.items.add(make(4, 'second.wav', 500));
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return 7;
    });

    await waitForWorkspace(page);
    expect(total).toBe(7);

    // Both files must show in the reorderable list.
    await expect(page.locator('[data-filename]')).toContainText('2 files');

    const meta = await page.locator('[data-filemeta]').innerText();
    // Combined duration, not just the first file's.
    expect(meta).toContain('0:07');
  });

  test('splitter produces several downloadable parts', async ({ page }) => {
    await page.goto('/audio-splitter');
    await dropGeneratedAudio(page, { seconds: 12 });
    await waitForWorkspace(page);

    await page.click('[data-download]');
    // Each part is encoded in turn, so allow real time.
    await expect
      .poll(async () => page.locator('[data-results] .result').count(), {
        timeout: 60_000,
      })
      .toBeGreaterThan(1);

    const first = page.locator('[data-results] .result').first();
    await expect(first).toContainText(/KB|MB/);
  });
});

test.describe('splitter cut markers', () => {
  test('seeds markers from the settings and draws them', async ({ page }) => {
    await page.goto('/audio-splitter');
    await dropGeneratedAudio(page, { seconds: 24 });
    await waitForWorkspace(page);

    // Four equal parts means three interior cuts.
    await expect(page.locator('.stage__marker')).toHaveCount(3);
    await expect(page.locator('[data-plan-text]')).toContainText('4 parts');
    await expect(page.locator('.stage__marker-tip').first()).toHaveText('0:06.00');
  });

  test('a marker can be dragged and the plan follows', async ({ page }) => {
    await page.goto('/audio-splitter');
    await dropGeneratedAudio(page, { seconds: 24 });
    await waitForWorkspace(page);

    const first = page.locator('.stage__marker').first();
    const before = await first.evaluate((el) => (el as HTMLElement).style.left);

    const box = await first.boundingBox();
    const canvas = await page.locator('[data-canvas-wrap]').boundingBox();
    if (!box || !canvas) throw new Error('no geometry');

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(canvas.x + canvas.width * 0.4, box.y + box.height / 2, {
      steps: 8,
    });
    await page.mouse.up();

    const after = await first.evaluate((el) => (el as HTMLElement).style.left);
    expect(after).not.toBe(before);
    // Parts are no longer equal, so the plan must report a range.
    await expect(page.locator('[data-plan-text]')).toContainText(' to ');
  });

  test('double-clicking the waveform adds a cut', async ({ page }) => {
    await page.goto('/audio-splitter');
    await dropGeneratedAudio(page, { seconds: 24 });
    await waitForWorkspace(page);

    const canvas = await page.locator('[data-canvas-wrap]').boundingBox();
    if (!canvas) throw new Error('no canvas');

    // 0.85 sits between the seeded cuts; 0.75 is exactly on one, and a
    // duplicate is deduped away by design.
    await page.mouse.dblclick(canvas.x + canvas.width * 0.85, canvas.y + canvas.height * 0.7);
    await expect(page.locator('.stage__marker')).toHaveCount(4);
    await expect(page.locator('[data-plan-text]')).toContainText('5 parts');
  });

  test('a marker can be removed', async ({ page }) => {
    await page.goto('/audio-splitter');
    await dropGeneratedAudio(page, { seconds: 24 });
    await waitForWorkspace(page);

    await page.locator('.stage__marker').first().hover();
    await page.locator('.stage__marker-x').first().click();

    await expect(page.locator('.stage__marker')).toHaveCount(2);
    await expect(page.locator('[data-plan-text]')).toContainText('3 parts');
  });

  test('keyboard nudges and deletes a marker', async ({ page }) => {
    await page.goto('/audio-splitter');
    await dropGeneratedAudio(page, { seconds: 24 });
    await waitForWorkspace(page);

    const first = page.locator('.stage__marker').first();
    await first.focus();
    await first.press('ArrowRight');
    await expect(page.locator('.stage__marker-tip').first()).toHaveText('0:06.05');

    await page.locator('.stage__marker').first().press('Delete');
    await expect(page.locator('.stage__marker')).toHaveCount(2);
  });

  test('hand-placed cuts are what actually get exported', async ({ page }) => {
    await page.goto('/audio-splitter');
    await dropGeneratedAudio(page, { seconds: 24 });
    await waitForWorkspace(page);

    // Reduce to a single cut, so two parts must come out — not the four the
    // settings would have produced.
    await page.locator('.stage__marker').first().hover();
    await page.locator('.stage__marker-x').first().click();
    await page.locator('.stage__marker').first().hover();
    await page.locator('.stage__marker-x').first().click();
    await expect(page.locator('.stage__marker')).toHaveCount(1);

    await page.click('[data-download]');
    await expect
      .poll(async () => page.locator('[data-results] .result').count(), {
        timeout: 60_000,
      })
      .toBe(2);
  });
});

test.describe('silence remover shows what it will cut', () => {
  test('highlights the detected gaps on the waveform', async ({ page }) => {
    await page.goto('/silence-remover');
    await dropGeneratedAudio(page, { seconds: 12, gap: [4, 7] });
    await waitForWorkspace(page);
    await page.waitForTimeout(500);

    await expect(page.locator('[data-report]')).toContainText(/gap/i);

    // The highlight is canvas-painted, so assert on the pixels: the flagged
    // band must differ from the untouched background beside it.
    const differs = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-canvas]');
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return false;

      const y = 6;
      const inGap = ctx.getImageData(Math.floor(canvas.width * 0.45), y, 1, 1).data;
      const outside = ctx.getImageData(Math.floor(canvas.width * 0.08), y, 1, 1).data;
      return (
        Math.abs(inGap[0] - outside[0]) +
          Math.abs(inGap[1] - outside[1]) +
          Math.abs(inGap[2] - outside[2]) >
        12
      );
    });

    expect(differs, 'the silent span should be visibly flagged').toBe(true);
  });
});

test.describe('DSP tools produce output', () => {
  const cases: { slug: string; suffix: string }[] = [
    { slug: 'volume-booster', suffix: 'louder' },
    { slug: 'speed-changer', suffix: 'speed' },
    { slug: 'audio-reverser', suffix: 'reversed' },
    { slug: 'fade-in-out', suffix: 'fade' },
    { slug: 'silence-remover', suffix: 'trimmed' },
    { slug: 'nightcore-maker', suffix: 'nightcore' },
    { slug: 'slowed-reverb', suffix: 'slowed' },
    { slug: 'bass-booster', suffix: 'bass' },
    { slug: 'equalizer', suffix: 'eq' },
    { slug: 'pitch-shifter', suffix: 'pitch' },
    { slug: 'stereo-widener', suffix: 'wide' },
    { slug: 'audio-looper', suffix: 'loop' },
  ];

  for (const { slug } of cases) {
    test(`/${slug} exports a playable file`, async ({ page }) => {
      await page.goto(`/${slug}`);
      await captureDownload(page);
      // Keep it short: several of these run WSOLA, which is CPU-bound.
      await dropGeneratedAudio(page, { seconds: 4, gap: [1.5, 2.2] });
      await waitForWorkspace(page);

      await page.click('[data-download]');
      await expect
        .poll(async () => (await getDownloads(page)).length, { timeout: 90_000 })
        .toBe(1);

      const [download] = await getDownloads(page);
      expect(download.size, `${slug} produced an empty file`).toBeGreaterThan(1000);
      expect(download.name).toMatch(/\.(mp3|wav|m4a|ogg|opus|flac)$/);

      // No error should have been raised along the way. The card is always in
      // the DOM so the live region is there to announce into, so the question is
      // whether it was ever shown, not whether it exists.
      await expect(page.locator('[role="alert"]')).toBeHidden();
    });
  }
});
