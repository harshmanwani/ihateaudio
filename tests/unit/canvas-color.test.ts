/**
 * The panels read their palette from the CSS tokens so the canvas can never
 * drift from the stylesheet, and tint those tokens with `color-mix()`. Both are
 * written in syntax some visiting browsers predate, and a custom property hands
 * back its text regardless of whether the browser understands it. So "the token
 * is set" is not the same as "the canvas can draw with it", and a tint the
 * canvas cannot parse is silently dropped rather than reported.
 */
import { describe, expect, it } from 'vitest';
import { colorMixFallback, usableColor } from '../../src/lib/canvas';

/**
 * A canvas whose colour support is a parameter.
 *
 * Faithful on the three points that matter: an unparseable value leaves
 * `fillStyle` untouched rather than throwing, a parseable one is normalised on
 * the way in, and reading back gives that normalised form.
 */
function fakeContext(supports: (value: string) => boolean): {
  ctx: CanvasRenderingContext2D;
  read: () => string;
} {
  const names: Record<string, string> = {
    black: '#000000',
    white: '#ffffff',
    transparent: 'rgba(0, 0, 0, 0)',
  };
  let fill = '#123456';
  const ctx = {
    get fillStyle(): string {
      return fill;
    },
    set fillStyle(next: string) {
      if (supports(next)) fill = names[next.toLowerCase()] ?? next.toLowerCase();
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, read: () => fill };
}

/** Anything before Chrome 111: no oklch(), no color-mix(). */
const oldChrome = (value: string): boolean =>
  !/^\s*(oklch|oklab|lch|lab|color-mix)\s*\(/i.test(value);
const modern = (): boolean => true;

describe('usableColor', () => {
  it('falls back when the browser cannot parse the token', () => {
    const { ctx } = fakeContext(oldChrome);
    expect(usableColor(ctx, 'oklch(62% 0.15 156)', '#12a35f')).toBe('#12a35f');
  });

  it('keeps the token when the browser can parse it', () => {
    const { ctx } = fakeContext(modern);
    expect(usableColor(ctx, 'oklch(62% 0.15 156)', '#12a35f')).toBe(
      'oklch(62% 0.15 156)'
    );
  });

  it('falls back when the token is missing altogether', () => {
    const { ctx } = fakeContext(modern);
    expect(usableColor(ctx, '', '#12a35f')).toBe('#12a35f');
  });

  it('keeps a colour that matches the probe it is tested against', () => {
    // The probe works by checking whether assigning the value moves fillStyle,
    // so black is the one colour a single-sentinel check would wrongly reject.
    const { ctx } = fakeContext(modern);
    expect(usableColor(ctx, '#000000', '#12a35f')).toBe('#000000');
    expect(usableColor(ctx, 'black', '#12a35f')).toBe('black');
  });

  it('leaves fillStyle as it found it', () => {
    const { ctx, read } = fakeContext(oldChrome);
    usableColor(ctx, 'oklch(62% 0.15 156)', '#12a35f');
    expect(read()).toBe('#123456');
  });
});

describe('colorMixFallback', () => {
  it('turns a mix against transparent into the same colour at that alpha', () => {
    // The overwhelmingly common tint, and the one the fallback gets exactly
    // right: premultiplied interpolation leaves the channels alone.
    const { ctx } = fakeContext(oldChrome);
    expect(colorMixFallback(ctx, 'color-mix(in oklch, #12a35f 55%, transparent)')).toBe(
      'rgba(18, 163, 95, 0.55)'
    );
  });

  it('blends against an opaque colour', () => {
    const { ctx } = fakeContext(oldChrome);
    expect(colorMixFallback(ctx, 'color-mix(in oklch, #000000 62%, white)')).toBe(
      'rgba(97, 97, 97, 1)'
    );
  });

  it('reads a percentage carried by the second colour instead', () => {
    const { ctx } = fakeContext(oldChrome);
    expect(colorMixFallback(ctx, 'color-mix(in oklch, #ffffff, #000000 25%)')).toBe(
      'rgba(191, 191, 191, 1)'
    );
  });

  it('survives a colour that contains commas of its own', () => {
    const { ctx } = fakeContext(oldChrome);
    expect(
      colorMixFallback(ctx, 'color-mix(in oklch, rgba(18, 163, 95, 1) 50%, transparent)')
    ).toBe('rgba(18, 163, 95, 0.5)');
  });

  it('translates a tint built out of another tint', () => {
    // How the panels warn: a danger colour lightened toward white, then mixed
    // into the background. Both layers have to be unwound.
    const { ctx } = fakeContext(oldChrome);
    const inner = 'color-mix(in oklch, #c0392b 62%, white)';
    // #c0392b lightened 62% toward white is (216, 132, 124); the outer mix
    // then takes that to 60% alpha without touching the channels.
    expect(colorMixFallback(ctx, `color-mix(in oklch, ${inner} 60%, transparent)`)).toBe(
      'rgba(216, 132, 124, 0.6)'
    );
  });

  it('returns null for anything that is not a mix', () => {
    const { ctx } = fakeContext(oldChrome);
    expect(colorMixFallback(ctx, 'oklch(62% 0.15 156)')).toBeNull();
    expect(colorMixFallback(ctx, '#12a35f')).toBeNull();
  });

  it('returns null when the browser cannot read the colour being mixed', () => {
    // Which is exactly why panelColors resolves the tokens to something the
    // canvas understands before any of them reach a tint.
    const { ctx } = fakeContext(oldChrome);
    expect(
      colorMixFallback(ctx, 'color-mix(in oklch, oklch(62% 0.15 156) 55%, transparent)')
    ).toBeNull();
  });

  it('leaves fillStyle as it found it', () => {
    const { ctx, read } = fakeContext(oldChrome);
    colorMixFallback(ctx, 'color-mix(in oklch, #12a35f 55%, transparent)');
    expect(read()).toBe('#123456');
  });
});
