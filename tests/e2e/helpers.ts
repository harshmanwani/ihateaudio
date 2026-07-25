import type { Page } from '@playwright/test';

/**
 * Builds a WAV in the page and feeds it to the tool's file input.
 *
 * Generating in-page rather than shipping a fixture keeps the repo free of
 * binaries and lets each test choose material that actually exercises what it
 * is checking — a silent gap for the silence remover, a click track for BPM.
 */
export async function dropGeneratedAudio(
  page: Page,
  options: {
    seconds?: number;
    /** Insert a silent stretch, as [startSec, endSec]. */
    gap?: [number, number];
    frequency?: number;
    channels?: number;
    sampleRate?: number;
    amplitude?: number;
    filename?: string;
  } = {}
): Promise<number> {
  return page.evaluate((opts) => {
    const {
      seconds = 5,
      gap = null,
      frequency = 440,
      channels = 2,
      sampleRate = 44100,
      amplitude = 0.55,
      filename = 'test-tone.wav',
    } = opts;

    const frames = Math.round(sampleRate * seconds);
    const bytes = new ArrayBuffer(44 + frames * channels * 2);
    const dv = new DataView(bytes);
    const ascii = (offset: number, text: string) => {
      for (let i = 0; i < text.length; i += 1) dv.setUint8(offset + i, text.charCodeAt(i));
    };

    ascii(0, 'RIFF');
    dv.setUint32(4, 36 + frames * channels * 2, true);
    ascii(8, 'WAVE');
    ascii(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true);
    dv.setUint16(22, channels, true);
    dv.setUint32(24, sampleRate, true);
    dv.setUint32(28, sampleRate * channels * 2, true);
    dv.setUint16(32, channels * 2, true);
    dv.setUint16(34, 16, true);
    ascii(36, 'data');
    dv.setUint32(40, frames * channels * 2, true);

    let offset = 44;
    for (let i = 0; i < frames; i += 1) {
      const t = i / sampleRate;
      const silent = gap !== null && t >= gap[0] && t < gap[1];
      const value = silent
        ? 0
        : Math.sin(2 * Math.PI * frequency * t) * amplitude;
      const clamped = Math.max(-1, Math.min(1, value));
      const sample = clamped < 0 ? clamped * 32768 : clamped * 32767;
      for (let c = 0; c < channels; c += 1) {
        dv.setInt16(offset, sample, true);
        offset += 2;
      }
    }

    const file = new File([bytes], filename, { type: 'audio/wav' });
    const input = document.querySelector<HTMLInputElement>('[data-file-input]');
    if (!input) throw new Error('No file input on this page');

    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));

    return file.size;
  }, options);
}

/**
 * Intercepts the download so a test can inspect the produced blob rather than
 * writing it to disk. Returns a handle whose `result` resolves once a download
 * has been triggered.
 */
export async function captureDownload(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store: { name: string; href: string }[] = [];
    (window as unknown as { __downloads: typeof store }).__downloads = store;

    const original = HTMLAnchorElement.prototype.click;
    (window as unknown as { __origClick: typeof original }).__origClick = original;

    HTMLAnchorElement.prototype.click = function patched(this: HTMLAnchorElement) {
      if (this.download) {
        store.push({ name: this.download, href: this.href });
        return;
      }
      return original.call(this);
    };
  });
}

export async function getDownloads(
  page: Page
): Promise<{ name: string; size: number; type: string }[]> {
  return page.evaluate(async () => {
    const store =
      (window as unknown as { __downloads?: { name: string; href: string }[] })
        .__downloads ?? [];

    return Promise.all(
      store.map(async (entry) => {
        const response = await fetch(entry.href);
        const blob = await response.blob();
        return { name: entry.name, size: blob.size, type: blob.type };
      })
    );
  });
}

/** Waits for a file to finish decoding and the workspace to appear. */
export async function waitForWorkspace(page: Page): Promise<void> {
  await page.waitForSelector('[data-workspace]:not([hidden])', { timeout: 20_000 });
}
