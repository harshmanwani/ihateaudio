import { test, expect } from '@playwright/test';
import { TOOLS } from '../../src/data/tools';
import { dropGeneratedAudio, waitForWorkspace } from './helpers';

/**
 * WCAG AA contrast, measured against rendered pixels.
 *
 * Colours are resolved through a canvas rather than parsed from
 * getComputedStyle, because the tokens are OKLCH and the computed value comes
 * back as `oklch(...)` — string-parsing it as RGB silently produces garbage
 * ratios and an audit that passes or fails for the wrong reasons.
 */
const AUDIT = `(() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const cache = new Map();
  const toRgb = (css) => {
    if (cache.has(css)) return cache.get(css);
    ctx.clearRect(0,0,1,1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0,0,1,1);
    const d = ctx.getImageData(0,0,1,1).data;
    const v = [d[0], d[1], d[2], d[3]/255];
    cache.set(css, v); return v;
  };
  const srgb = c => { c/=255; return c<=0.03928 ? c/12.92 : Math.pow((c+0.055)/1.055, 2.4); };
  const lum = ([r,g,b]) => 0.2126*srgb(r)+0.7152*srgb(g)+0.0722*srgb(b);
  const ratio = (a,b) => { const l=[lum(a),lum(b)].sort((x,y)=>y-x); return (l[0]+0.05)/(l[1]+0.05); };
  const bgOf = el => {
    let n = el;
    while (n) {
      const c = toRgb(getComputedStyle(n).backgroundColor);
      if (c[3] > 0.95) return c;
      n = n.parentElement;
    }
    return [255,255,255,1];
  };
  const fails = []; const seen = new Set(); let tested = 0;
  document.querySelectorAll('body *').forEach(el => {
    if (el.closest('[hidden]') || !el.offsetParent) return;
    // WCAG 1.4.3 exempts text in an inactive user interface component, and a
    // disabled control is dimmed precisely so it reads as unavailable — the
    // segments drop to --ink-3 at 0.4 opacity, which no contrast rule could
    // survive and none is meant to. Auditing them enforced a requirement the
    // spec does not make, and it only surfaced now and then because the colour
    // transitions: sample early and you catch the enabled colour and pass,
    // sample once it has settled and you fail. A loaded machine samples late.
    if (el.closest('[disabled], [aria-disabled="true"]')) return;
    const own = Array.from(el.childNodes).filter(n => n.nodeType === 3)
      .map(n => n.textContent).join('');
    if (!/\\S/.test(own)) return;
    const s = getComputedStyle(el);
    const size = parseFloat(s.fontSize), weight = parseInt(s.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;
    const r = ratio(toRgb(s.color), bgOf(el));
    tested++;
    const key = s.color + '|' + Math.round(size) + '|' + weight;
    if (r < need && !seen.has(key)) {
      seen.add(key);
      fails.push({
        el: el.className || el.tagName, size: Math.round(size), weight,
        ratio: Math.round(r * 100) / 100, need, text: el.textContent.trim().slice(0, 40)
      });
    }
  });
  return { tested, fails };
})()`;

interface AuditResult {
  tested: number;
  fails: { el: string; size: number; ratio: number; need: number; text: string }[];
}

const STATIC = ['/', '/loudness-targets', '/audio-formats', '/about', '/privacy'];

test.describe('contrast (AA)', () => {
  for (const path of STATIC) {
    test(`${path} passes AA`, async ({ page }) => {
      await page.goto(path);
      const result = (await page.evaluate(AUDIT)) as AuditResult;
      expect(result.tested).toBeGreaterThan(20);
      expect(result.fails, JSON.stringify(result.fails, null, 1)).toEqual([]);
    });
  }

  // Sampled rather than exhaustive: every tool page draws from the same token
  // set, so a spread across the categories covers the real surface area.
  const sample = ['audio-trimmer', 'mp3-converter', 'audio-normalizer', 'slowed-reverb',
    'equalizer', 'loudness-meter', 'voice-recorder', 'waveform-generator',
    'audio-joiner', 'ringtone-maker', 'bpm-detector', 'stereo-to-mono'];

  // The empty state is the dark stage and is what every first visit sees, so
  // it is audited separately — the loaded-state tests below hide it.
  for (const slug of ['audio-trimmer', 'audio-joiner', 'video-to-audio']) {
    test(`/${slug} empty state passes AA on the dark stage`, async ({ page }) => {
      await page.goto(`/${slug}`);
      await expect(page.locator('[data-drop]')).toBeVisible();

      const result = (await page.evaluate(AUDIT)) as AuditResult;
      expect(result.tested).toBeGreaterThan(20);
      expect(result.fails, JSON.stringify(result.fails, null, 1)).toEqual([]);
    });
  }

  for (const slug of sample) {
    const tool = TOOLS.find((t) => t.slug === slug);
    if (!tool) continue;

    test(`/${slug} passes AA with a file loaded`, async ({ page }) => {
      await page.goto(`/${slug}`);

      // Some tools have no dropzone (the recorder); audit them as they load.
      const hasInput = await page.locator('[data-file-input]').count();
      if (hasInput > 0) {
        await dropGeneratedAudio(page, { seconds: 5 });
        await waitForWorkspace(page).catch(() => {
          /* A tool without the standard workspace still gets audited. */
        });
      }

      const result = (await page.evaluate(AUDIT)) as AuditResult;
      expect(result.tested).toBeGreaterThan(20);
      expect(result.fails, JSON.stringify(result.fails, null, 1)).toEqual([]);
    });
  }
});
