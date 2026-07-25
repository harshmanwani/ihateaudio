/**
 * Canvas waveform renderer.
 *
 * Two decisions carry the accuracy here:
 *
 * 1. **One column per device pixel.** Sampling per *bar* instead threw away
 *    most of the detail — a 2px bar with a 1px gap meant one reading per three
 *    physical pixels, so transients vanished and steady tones aliased into
 *    false beat patterns.
 * 2. **Peak hull plus RMS body.** Peak alone stretches a whole column to full
 *    height for one stray sample, which is why cheap waveforms look like solid
 *    blocks. The RMS body traces the energy the ear follows, and drawing both
 *    is what makes loud and quiet legible at a glance.
 *
 * Both layers come from one pass over the samples, cached per width, so
 * dragging a selection repaints from small typed arrays rather than rescanning
 * millions of samples.
 */
import { computeWaveform, type WaveformData } from './analysis';

export interface WaveformStyle {
  wave: string;
  waveDim: string;
  background: string;
  line: string;
  flag: string;
}

export interface WaveformRegion {
  start: number;
  end: number;
}

/** Fraction of half-height the hull may occupy, leaving a little air. */
const VERTICAL_FIT = 0.9;

export class Waveform {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private buffer: AudioBuffer | null = null;
  private data: WaveformData | null = null;
  private style: WaveformStyle;
  private region: WaveformRegion | null = null;
  private markers: number[] = [];
  private highlights: WaveformRegion[] = [];
  private observer: ResizeObserver | null = null;
  private frame = 0;

  constructor(canvas: HTMLCanvasElement, style?: Partial<WaveformStyle>) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D context unavailable.');
    this.ctx = ctx;

    // Read the palette from CSS so the canvas can never drift from the tokens.
    const computed = getComputedStyle(canvas);
    const token = (name: string, fallback: string): string =>
      computed.getPropertyValue(name).trim() || fallback;

    this.style = {
      wave: token('--wave', '#5bbf94'),
      waveDim: token('--wave-dim', '#2f5a49'),
      background: token('--stage', '#0e1512'),
      line: token('--stage-line', '#3a4a44'),
      flag: token('--playhead', '#e0a33c'),
      ...style,
    };

    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.scheduleRender());
      this.observer.observe(canvas);
    }
  }

  setBuffer(buffer: AudioBuffer | null): void {
    this.buffer = buffer;
    this.data = null;
    this.scheduleRender();
  }

  /** Highlights [start, end] in seconds. Null draws the whole file as active. */
  setRegion(region: WaveformRegion | null): void {
    this.region = region;
    this.scheduleRender();
  }

  /**
   * Vertical cut lines, in seconds. Segments between them are tinted in
   * alternation so the parts are countable without reading any numbers.
   */
  setMarkers(times: number[]): void {
    this.markers = [...times].sort((a, b) => a - b);
    this.scheduleRender();
  }

  /**
   * Spans to call out on the waveform — the stretches a tool is about to
   * remove or alter. Showing them turns a threshold slider from a guess into
   * something you can see the result of before committing.
   */
  setHighlights(regions: WaveformRegion[]): void {
    this.highlights = regions;
    this.scheduleRender();
  }

  /** Coalesces repaints to one per frame during drags. */
  scheduleRender(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  render(): void {
    const { canvas, ctx } = this;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    // Capping DPR at 2 keeps the sample scan bounded on phones that report 3
    // or 4, where the extra columns are invisible on a waveform anyway.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.floor(rect.width * dpr);
    const height = Math.floor(rect.height * dpr);

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      this.data = null;
    }

    ctx.fillStyle = this.style.background;
    ctx.fillRect(0, 0, width, height);

    if (!this.buffer) return;

    if (!this.data || this.data.columns !== width) {
      this.data = computeWaveform(this.buffer, width);
    }

    const mid = height / 2;
    const scale = mid * VERTICAL_FIT;
    const duration = this.buffer.duration;
    const toX = (seconds: number): number =>
      duration > 0 ? (seconds / duration) * width : 0;

    this.paintSegments(width, height, toX);
    this.paintHighlights(height, toX);

    // Centreline: gives silence a visible spine instead of a blank gap.
    ctx.fillStyle = this.style.line;
    ctx.fillRect(0, Math.round(mid), width, 1);

    const active = this.region
      ? { from: toX(this.region.start), to: toX(this.region.end) }
      : { from: 0, to: width };

    // Everything dim first, then the active span repainted bright through a
    // clip — cheaper and crisper than deciding a colour per column.
    this.paintWave(width, mid, scale, this.style.waveDim);

    if (active.to > active.from) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(active.from, 0, active.to - active.from, height);
      ctx.clip();
      this.paintWave(width, mid, scale, this.style.wave);
      ctx.restore();
    }

    this.paintMarkers(height, toX);
  }

  /** Alternating tint per segment, so split parts are countable at a glance. */
  private paintSegments(
    width: number,
    height: number,
    toX: (seconds: number) => number
  ): void {
    if (this.markers.length === 0) return;

    const { ctx } = this;
    const edges = [0, ...this.markers.map(toX), width];

    ctx.save();
    ctx.fillStyle = this.style.wave;
    for (let i = 0; i < edges.length - 1; i += 1) {
      if (i % 2 === 1) continue;
      ctx.globalAlpha = 0.05;
      ctx.fillRect(edges[i], 0, edges[i + 1] - edges[i], height);
    }
    ctx.restore();
  }

  /** Tinted bands with a hairline edge, for spans a tool will act on. */
  private paintHighlights(height: number, toX: (seconds: number) => number): void {
    if (this.highlights.length === 0) return;

    const { ctx } = this;
    ctx.save();
    for (const region of this.highlights) {
      const from = toX(region.start);
      const span = Math.max(1, toX(region.end) - from);

      ctx.globalAlpha = 0.16;
      ctx.fillStyle = this.style.flag;
      ctx.fillRect(from, 0, span, height);

      ctx.globalAlpha = 0.55;
      ctx.fillRect(Math.round(from), 0, 1, height);
      ctx.fillRect(Math.round(from + span) - 1, 0, 1, height);
    }
    ctx.restore();
  }

  private paintMarkers(height: number, toX: (seconds: number) => number): void {
    if (this.markers.length === 0) return;

    const { ctx } = this;
    ctx.save();
    ctx.fillStyle = this.style.wave;
    for (const time of this.markers) {
      ctx.fillRect(Math.round(toX(time)), 0, 1, height);
    }
    ctx.restore();
  }

  /**
   * Paints the hull as a translucent envelope with the RMS body solid inside
   * it, both as single filled paths so the edge stays smooth at any width.
   */
  private paintWave(width: number, mid: number, scale: number, colour: string): void {
    const data = this.data;
    if (!data) return;

    const { ctx } = this;
    const { peaks, rms } = data;

    ctx.fillStyle = colour;

    // Outer hull.
    ctx.globalAlpha = 0.42;
    ctx.beginPath();
    ctx.moveTo(0, mid - peaks[1] * scale);
    for (let x = 0; x < width; x += 1) ctx.lineTo(x, mid - peaks[x * 2 + 1] * scale);
    for (let x = width - 1; x >= 0; x -= 1) ctx.lineTo(x, mid - peaks[x * 2] * scale);
    ctx.closePath();
    ctx.fill();

    // RMS body.
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid - rms[0] * scale);
    for (let x = 0; x < width; x += 1) ctx.lineTo(x, mid - rms[x] * scale);
    for (let x = width - 1; x >= 0; x -= 1) ctx.lineTo(x, mid + rms[x] * scale);
    ctx.closePath();
    ctx.fill();

    ctx.globalAlpha = 1;
  }

  /** Pixel x within the canvas to a time in seconds. */
  timeAt(clientX: number): number {
    if (!this.buffer) return 0;
    const rect = this.canvas.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    return Math.min(this.buffer.duration, Math.max(0, ratio * this.buffer.duration));
  }

  /** Seconds to a percentage, for positioning overlays in CSS. */
  positionOf(seconds: number): number {
    if (!this.buffer || this.buffer.duration === 0) return 0;
    return Math.min(100, Math.max(0, (seconds / this.buffer.duration) * 100));
  }

  destroy(): void {
    this.observer?.disconnect();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
}

/**
 * Renders a waveform to a standalone PNG — used by the waveform image tool and
 * for social preview generation.
 */
export function renderWaveformImage(
  buffer: AudioBuffer,
  options: {
    width?: number;
    height?: number;
    background?: string;
    color?: string;
    style?: 'bars' | 'filled' | 'line';
    transparent?: boolean;
  } = {}
): HTMLCanvasElement {
  const {
    width = 1600,
    height = 400,
    background = '#0e1512',
    color = '#5bbf94',
    style = 'bars',
    transparent = false,
  } = options;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable.');

  if (!transparent) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
  }

  const mid = height / 2;
  ctx.fillStyle = color;
  ctx.strokeStyle = color;

  if (style === 'line') {
    const { peaks } = computeWaveform(buffer, width);
    ctx.lineWidth = Math.max(1, height / 200);
    ctx.beginPath();
    for (let x = 0; x < width; x += 1) {
      const y = mid - peaks[x * 2 + 1] * mid * VERTICAL_FIT;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    return canvas;
  }

  if (style === 'filled') {
    const { peaks } = computeWaveform(buffer, width);
    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (let x = 0; x < width; x += 1) {
      ctx.lineTo(x, mid - peaks[x * 2 + 1] * mid * VERTICAL_FIT);
    }
    for (let x = width - 1; x >= 0; x -= 1) {
      ctx.lineTo(x, mid - peaks[x * 2] * mid * VERTICAL_FIT);
    }
    ctx.closePath();
    ctx.fill();
    return canvas;
  }

  const barWidth = Math.max(2, Math.round(width / 400));
  const gap = Math.max(1, Math.round(barWidth / 2));
  const columns = Math.floor(width / (barWidth + gap));
  const { peaks } = computeWaveform(buffer, columns);

  for (let i = 0; i < columns; i += 1) {
    const min = peaks[i * 2];
    const max = peaks[i * 2 + 1];
    const top = mid - max * mid * VERTICAL_FIT;
    const h = Math.max((max - min) * mid * VERTICAL_FIT, 2);
    ctx.beginPath();
    ctx.roundRect(i * (barWidth + gap), top, barWidth, h, barWidth / 2);
    ctx.fill();
  }

  return canvas;
}
