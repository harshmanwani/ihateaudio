/**
 * Guards the panels against the colour syntax outrunning the browsers.
 *
 * The tokens are authored in `oklch()` and the panels tint them with
 * `color-mix()`. Both landed in Chrome 111, and a real slice of the traffic is
 * older than that — Chrome 109 is the terminal version for Windows 7, 8 and
 * 8.1, so it does not age out. On those browsers `fillStyle` and `strokeStyle`
 * drop a colour they cannot parse and keep whatever was set before, which draws
 * the panel in the wrong colour and reports nothing.
 *
 * Counting pixels cannot catch that: a dropped colour still paints. What is
 * measurable is whether any colour reaching a canvas is one the browser would
 * have refused — so that is what this asserts, with the refusal simulated at
 * exactly the layer where those browsers differ.
 *
 * A new panel that reads a token without going through `panelColors`, or takes
 * a raw `getContext('2d')` instead of `panelContext`, fails here.
 */
import { test, expect, type Page } from '@playwright/test';
import { dropGeneratedAudio, waitForWorkspace } from './helpers';

/** A spread of panels: curve, animated, meter, danger states, and the send chart. */
const PAGES = [
  'equalizer',
  '8d-audio-maker',
  'loudness-meter',
  'volume-booster',
  'audio-normalizer',
  'stereo-to-mono',
  'send-audio-on-whatsapp',
];

/**
 * Makes the page behave like Chrome before 111: the colour properties ignore
 * `oklch()` and `color-mix()`, while custom properties still hand back their
 * text, which is what made the mismatch invisible in the first place.
 */
async function pretendOldChrome(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __ok: string[]; __no: string[] };
    w.__ok = [];
    w.__no = [];
    const proto = CanvasRenderingContext2D.prototype;
    for (const prop of ['fillStyle', 'strokeStyle'] as const) {
      const d = Object.getOwnPropertyDescriptor(proto, prop);
      if (!d?.get || !d.set) continue;
      const { get, set } = d;
      Object.defineProperty(proto, prop, {
        configurable: true,
        get(this: CanvasRenderingContext2D) {
          return get.call(this);
        },
        set(this: CanvasRenderingContext2D, value: unknown) {
          if (typeof value === 'string') {
            const unreadable = /^\s*(oklch|oklab|lch|lab|color-mix)\s*\(/i.test(value);
            // Only canvases on the page count. Support is probed by trying a
            // colour on a detached scratch canvas to see whether it sticks, and
            // those trials are not drawing.
            if (this.canvas.isConnected) (unreadable ? w.__no : w.__ok).push(value);
            if (unreadable) return;
          }
          set.call(this, value);
        },
      });
    }
  });
}

for (const slug of PAGES) {
  test(`every canvas colour survives a pre-111 browser: ${slug}`, async ({ page }) => {
    await pretendOldChrome(page);
    await page.goto(`/${slug}`);
    await dropGeneratedAudio(page, { seconds: 6 });
    await waitForWorkspace(page);

    // Panels paint on their own schedule — an animation frame, a ResizeObserver,
    // an analysis finishing — so wait for drawing to start rather than guessing.
    await expect
      .poll(
        () =>
          page.evaluate(() => (window as unknown as { __ok: string[] }).__ok.length),
        { timeout: 20_000 }
      )
      .toBeGreaterThan(0);

    const refused = await page.evaluate(() => {
      const w = window as unknown as { __no: string[] };
      return [...new Set(w.__no)];
    });

    expect(
      refused,
      `${slug} handed a canvas colours a pre-111 browser cannot parse`
    ).toEqual([]);
  });
}
