/**
 * Canvas colour compatibility for the tool panels.
 *
 * The design tokens are authored in `oklch()` and the panels tint them with
 * `color-mix()`. Both are newer than some of the browsers that actually turn
 * up: roughly one Chrome session in ten is on a build older than 111, which is
 * where the pair landed. Chrome 109 in particular is the terminal version for
 * Windows 7, 8 and 8.1, so that tail does not shrink on its own.
 *
 * Canvas refuses an unreadable colour in two different ways, and the quieter
 * one is the worse one. `addColorStop` throws, which is how the waveform's
 * gradient took the whole render down — loud, and already fixed. `fillStyle`
 * and `strokeStyle` instead ignore what they cannot parse and keep whatever
 * was set before, so a panel draws its curve in the grid's colour, or in the
 * background's, and nothing anywhere reports a problem. That is the failure
 * this module exists for, and it spans every tint expression in every panel.
 *
 * Two guarantees, because the panels need both:
 *
 * 1. `panelColors` reads a design token only if the canvas can actually draw
 *    with it, falling back to the hex the panels already carried.
 * 2. `panelContext` translates a tint the canvas cannot parse into one it can,
 *    at the point it is assigned — which is what keeps the ~190 `color-mix`
 *    expressions working without every one of them having to know about this.
 *
 * On any browser that understands the tokens, `panelContext` hands back the
 * context untouched: no wrapper, no interception, nothing to go wrong for the
 * traffic that was never affected.
 */

/** Nests both syntaxes, so one parse answers for both. */
const SUPPORT_PROBE = 'color-mix(in oklch, oklch(62% 0.15 156) 55%, transparent)';

/** Scratch context for parsing colours without disturbing a live one. */
let scratch: CanvasRenderingContext2D | null | undefined;

function scratchContext(): CanvasRenderingContext2D | null {
  if (scratch === undefined) {
    scratch =
      typeof document === 'undefined'
        ? null
        : document.createElement('canvas').getContext('2d');
  }
  return scratch;
}

let handlesTokens: boolean | undefined;

/**
 * Whether this browser needs any of the translation below.
 *
 * Probed once and cached. Absent a canvas altogether there is nothing to draw
 * on and nothing to fix, so the answer is yes and every path stays inert.
 */
function browserHandlesTokens(): boolean {
  if (handlesTokens === undefined) {
    const ctx = scratchContext();
    handlesTokens = ctx ? usableColor(ctx, SUPPORT_PROBE, '') !== '' : true;
  }
  return handlesTokens;
}

/**
 * A colour the canvas can actually draw with, or the fallback.
 *
 * A custom property is untyped, so it hands back its text on a browser that
 * has never heard of the syntax, and "the token is set" stops meaning "the
 * canvas can use it".
 *
 * Support is probed rather than sniffed by version or by string, so the check
 * keeps holding for whatever colour syntax the tokens are written in next. Two
 * sentinels, because the value under test may well be the first one.
 */
export function usableColor(
  ctx: CanvasRenderingContext2D,
  value: string,
  fallback: string
): string {
  if (!value) return fallback;

  const previous = ctx.fillStyle;
  ctx.fillStyle = '#000000';
  ctx.fillStyle = value;
  let usable = ctx.fillStyle !== '#000000';
  if (!usable) {
    ctx.fillStyle = '#ffffff';
    ctx.fillStyle = value;
    usable = ctx.fillStyle !== '#ffffff';
  }
  ctx.fillStyle = previous;

  return usable ? value : fallback;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/**
 * Resolves anything the canvas understands to concrete channels.
 *
 * The canvas is the parser: assigning a colour and reading it back normalises
 * it to `#rrggbb` or `rgba(...)`. Cheaper and far more correct than carrying a
 * colour parser of our own.
 */
function toRgba(
  ctx: CanvasRenderingContext2D,
  value: string,
  depth = 0
): Rgba | null {
  if (usableColor(ctx, value, '') === '') {
    // A tint is sometimes built out of another tint — the panels warn by
    // mixing an already-lightened danger colour into the background. Translate
    // the inside before giving up on the outside. Bounded, so a pathological
    // string cannot spin here.
    if (depth >= 4) return null;
    const inner = colorMixFallback(ctx, value, depth + 1);
    return inner ? toRgba(ctx, inner, depth + 1) : null;
  }

  const previous = ctx.fillStyle;
  ctx.fillStyle = value;
  const text = typeof ctx.fillStyle === 'string' ? ctx.fillStyle : '';
  ctx.fillStyle = previous;

  const hex = /^#([0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }

  const rgb = /^rgba?\(([^)]+)\)$/i.exec(text);
  if (rgb) {
    const parts = rgb[1]!.split(',').map((part) => Number(part.trim()));
    if (parts.length >= 3 && parts.every((part) => Number.isFinite(part))) {
      return {
        r: parts[0]!,
        g: parts[1]!,
        b: parts[2]!,
        a: parts.length > 3 ? parts[3]! : 1,
      };
    }
  }

  return null;
}

/** Splits on commas that are not inside brackets, so nested colours survive. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** "#123456 55%" -> the colour and its share. The percentage is optional. */
function splitShare(part: string): { color: string; weight: number | null } {
  const trimmed = part.trim();
  const match = /^(.*?)\s+([\d.]+)%$/.exec(trimmed);
  if (match) return { color: match[1]!.trim(), weight: Number(match[2]) };
  return { color: trimmed, weight: null };
}

const MIX = /^color-mix\(\s*in\s+[\w-]+\s*,\s*(.+)\)$/i;

/**
 * A `color-mix()` rewritten as `rgba()`, or null if it cannot be read.
 *
 * Interpolation is premultiplied, which is what makes the overwhelmingly
 * common case exact rather than approximate: mixing against `transparent`
 * leaves the channels alone and scales only the alpha, so
 * `color-mix(in oklch, X 55%, transparent)` really is X at 55% alpha and the
 * hue cannot drift. The handful of mixes against `white` or `black` are
 * genuinely approximated — those interpolate in sRGB here rather than in
 * oklch — but this only ever runs on browsers that cannot do oklch at all, and
 * a slightly different tint beats a colour the canvas discards outright.
 */
export function colorMixFallback(
  ctx: CanvasRenderingContext2D,
  value: string,
  depth = 0
): string | null {
  const outer = MIX.exec(value.trim());
  if (!outer) return null;

  const parts = splitTopLevel(outer[1]!);
  if (parts.length !== 2) return null;

  const first = splitShare(parts[0]!);
  const second = splitShare(parts[1]!);

  let share =
    first.weight ?? (second.weight === null ? 50 : 100 - second.weight);
  if (!Number.isFinite(share)) return null;
  share = Math.min(100, Math.max(0, share)) / 100;

  const a = toRgba(ctx, first.color, depth);
  const b = toRgba(ctx, second.color, depth);
  if (!a || !b) return null;

  const wa = a.a * share;
  const wb = b.a * (1 - share);
  const alpha = wa + wb;
  if (alpha <= 0) return 'rgba(0, 0, 0, 0)';

  const channel = (x: number, y: number): number =>
    Math.round(Math.min(255, Math.max(0, (x * wa + y * wb) / alpha)));

  const rounded = Math.round(alpha * 1000) / 1000;
  return `rgba(${channel(a.r, b.r)}, ${channel(a.g, b.g)}, ${channel(a.b, b.b)}, ${rounded})`;
}

/**
 * Translations already worked out, keyed by the string that came in.
 *
 * This runs on every colour assignment, and a panel that animates makes
 * hundreds of them per frame — on hardware old enough to still be running the
 * browsers this exists for. The distinct strings are few (a handful of tokens
 * across a set of percentages), so after the first frame every lookup is a hit.
 * Cleared wholesale rather than evicted if a page somehow generates enough
 * distinct colours to matter, which keeps the bound trivially obvious.
 */
const translations = new Map<string, string>();
const TRANSLATION_LIMIT = 512;

/** The value if the canvas can draw with it, a translation if one exists. */
function sanitize(ctx: CanvasRenderingContext2D, value: string): string {
  const cached = translations.get(value);
  if (cached !== undefined) return cached;

  let result: string;
  if (usableColor(ctx, value, '') !== '') {
    result = value;
  } else {
    const rewritten = colorMixFallback(ctx, value);
    // Leaving an unreadable value alone keeps the browser's own behaviour
    // rather than inventing a colour nobody asked for.
    result =
      rewritten && usableColor(ctx, rewritten, '') !== '' ? rewritten : value;
  }

  if (translations.size >= TRANSLATION_LIMIT) translations.clear();
  translations.set(value, result);
  return result;
}

/**
 * Shadows one colour property on this context alone.
 *
 * An own accessor over the prototype's, so nothing outside a context handed
 * out by `panelContext` is affected, and the cost falls only on assigning a
 * colour rather than on any drawing call.
 */
function guard(
  ctx: CanvasRenderingContext2D,
  property: 'fillStyle' | 'strokeStyle',
  parser: CanvasRenderingContext2D
): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(ctx),
    property
  );
  const get = descriptor?.get;
  const set = descriptor?.set;
  if (!get || !set) return;

  Object.defineProperty(ctx, property, {
    configurable: true,
    get(): string | CanvasGradient | CanvasPattern {
      return get.call(ctx);
    },
    set(value: string | CanvasGradient | CanvasPattern) {
      set.call(ctx, typeof value === 'string' ? sanitize(parser, value) : value);
    },
  });
}

/**
 * A 2D context for a tool panel, with the colour guarantee described above.
 *
 * Drop-in for `canvas.getContext('2d')`, including the null it returns when
 * there is no context to be had.
 */
export function panelContext(
  canvas: HTMLCanvasElement
): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (browserHandlesTokens()) return ctx;

  const parser = scratchContext();
  if (!parser) return ctx;

  guard(ctx, 'fillStyle', parser);
  guard(ctx, 'strokeStyle', parser);
  return ctx;
}

export interface PanelColors {
  /** Foreground for labels, axes and rules. */
  ink: string;
  /** The tool category's accent, which is what makes each panel its own. */
  hue: string;
  /** For the states a panel needs to warn about. */
  danger: string;
}

/**
 * The three design tokens every panel draws with, each one checked against the
 * canvas before it is handed back.
 *
 * Read off the panel element rather than the document, because `--cat-vivid`
 * is set per tool category and a panel is the thing that carries it.
 */
export function panelColors(element: Element): PanelColors {
  const styles = getComputedStyle(element);
  return {
    ink: colorToken(styles, '--stage-ink', '#fff'),
    hue: colorToken(styles, '--cat-vivid', '#3aa76d'),
    danger: colorToken(styles, '--danger', '#c0392b'),
  };
}

/**
 * One design token, checked against the canvas before it is handed back.
 *
 * Probed on the scratch canvas rather than the caller's, so a live context is
 * never handed a trial value even for the instant before it is restored.
 */
export function colorToken(
  styles: CSSStyleDeclaration,
  name: string,
  fallback: string
): string {
  return drawableColor(styles.getPropertyValue(name).trim(), fallback);
}

/**
 * The same check for a colour that comes from code rather than a token — the
 * palettes written in a module because they belong to one component and were
 * never worth a CSS variable.
 */
export function drawableColor(value: string, fallback: string): string {
  const ctx = scratchContext();
  if (!ctx) return value || fallback;
  return usableColor(ctx, value, fallback);
}
