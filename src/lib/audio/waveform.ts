/**
 * Canvas waveform renderer.
 *
 * Peaks are computed once per width and cached, so dragging a selection
 * repaints from a small Float32Array instead of re-scanning millions of
 * samples. That is what keeps selection dragging at 60fps on an hour-long file.
 */
import { computePeaks } from './analysis';

export interface WaveformStyle {
  wave: string;
  waveDim: string;
  background: string;
}

export interface WaveformRegion {
  start: number;
  end: number;
}

const BAR_WIDTH = 2;
const BAR_GAP = 1;

export class Waveform {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private buffer: AudioBuffer | null = null;
  private peaks: Float32Array | null = null;
  private peakColumns = 0;
  private style: WaveformStyle;
  private region: WaveformRegion | null = null;
  private observer: ResizeObserver | null = null;
  private frame = 0;

  constructor(canvas: HTMLCanvasElement, style?: Partial<WaveformStyle>) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D context unavailable.');
    this.ctx = ctx;

    // Read the palette from CSS so the canvas can never drift from the tokens.
    const computed = getComputedStyle(canvas);
    this.style = {
      wave: computed.getPropertyValue('--wave').trim() || '#5bbf94',
      waveDim: computed.getPropertyValue('--wave-dim').trim() || '#2f5a49',
      background: computed.getPropertyValue('--stage').trim() || '#0e1512',
      ...style,
    };

    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.scheduleRender());
      this.observer.observe(canvas);
    }
  }

  setBuffer(buffer: AudioBuffer | null): void {
    this.buffer = buffer;
    this.peaks = null;
    this.peakColumns = 0;
    this.scheduleRender();
  }

  /** Highlights [start, end] in seconds. Null draws the whole file as active. */
  setRegion(region: WaveformRegion | null): void {
    this.region = region;
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

    // Cap DPR at 2: beyond that the extra pixels cost real time on phones and
    // are invisible on a waveform.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.floor(rect.width * dpr);
    const height = Math.floor(rect.height * dpr);

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    ctx.fillStyle = this.style.background;
    ctx.fillRect(0, 0, width, height);

    if (!this.buffer) return;

    const step = (BAR_WIDTH + BAR_GAP) * dpr;
    const columns = Math.max(1, Math.floor(width / step));

    if (!this.peaks || this.peakColumns !== columns) {
      this.peaks = computePeaks(this.buffer, columns);
      this.peakColumns = columns;
    }

    const mid = height / 2;
    const duration = this.buffer.duration;
    const regionStart = this.region ? this.region.start / duration : 0;
    const regionEnd = this.region ? this.region.end / duration : 1;

    const barW = BAR_WIDTH * dpr;
    const radius = Math.min(barW / 2, 2 * dpr);

    for (let i = 0; i < columns; i += 1) {
      const min = this.peaks[i * 2];
      const max = this.peaks[i * 2 + 1];
      const t = (i + 0.5) / columns;

      const inRegion = t >= regionStart && t <= regionEnd;
      ctx.fillStyle = inRegion ? this.style.wave : this.style.waveDim;

      const top = mid - max * mid * 0.92;
      const bottom = mid - min * mid * 0.92;
      // Silence still needs a visible line, otherwise the file looks broken.
      const h = Math.max(bottom - top, 1.5 * dpr);
      const x = i * step;

      if (h > radius * 2) {
        ctx.beginPath();
        ctx.roundRect(x, top, barW, h, radius);
        ctx.fill();
      } else {
        ctx.fillRect(x, top, barW, h);
      }
    }
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
    const peaks = computePeaks(buffer, width);
    ctx.lineWidth = Math.max(1, height / 200);
    ctx.beginPath();
    for (let x = 0; x < width; x += 1) {
      const y = mid - peaks[x * 2 + 1] * mid * 0.92;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    return canvas;
  }

  if (style === 'filled') {
    const peaks = computePeaks(buffer, width);
    ctx.beginPath();
    ctx.moveTo(0, mid);
    for (let x = 0; x < width; x += 1) {
      ctx.lineTo(x, mid - peaks[x * 2 + 1] * mid * 0.92);
    }
    for (let x = width - 1; x >= 0; x -= 1) {
      ctx.lineTo(x, mid - peaks[x * 2] * mid * 0.92);
    }
    ctx.closePath();
    ctx.fill();
    return canvas;
  }

  const barWidth = Math.max(2, Math.round(width / 400));
  const gap = Math.max(1, Math.round(barWidth / 2));
  const columns = Math.floor(width / (barWidth + gap));
  const peaks = computePeaks(buffer, columns);

  for (let i = 0; i < columns; i += 1) {
    const min = peaks[i * 2];
    const max = peaks[i * 2 + 1];
    const top = mid - max * mid * 0.92;
    const h = Math.max((max - min) * mid * 0.92, 2);
    ctx.beginPath();
    ctx.roundRect(i * (barWidth + gap), top, barWidth, h, barWidth / 2);
    ctx.fill();
  }

  return canvas;
}
