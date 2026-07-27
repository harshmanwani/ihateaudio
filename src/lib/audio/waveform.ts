/**
 * Canvas waveform renderer with a zoomable viewport.
 *
 * Four decisions carry this:
 *
 * 1. **The backing store is pinned to whole device pixels.** The canvas used to
 *    be sized `width: 100%` with a floored backing store, so a 700.4px box
 *    became a 1401px bitmap resampled across 1400.8 device pixels. Every
 *    browser bilinear-filters that, which is exactly why the waveform looked
 *    soft. Setting the CSS width to `backing / dpr` makes the mapping 1:1 and
 *    the drawing lands on real pixels.
 * 2. **Crisp hull, smooth body.** The outer hull is drawn as integer-aligned
 *    one-pixel columns, so every transient is a hard edge you can actually
 *    read. The RMS body over it is a continuous filled path. Accuracy from the
 *    first, shape from the second.
 * 3. **A viewport, not a whole file.** All sampling and all coordinate maths go
 *    through `view`, so zooming is not a visual trick over pre-computed data:
 *    the samples are re-scanned for the visible range, and zooming in genuinely
 *    resolves more detail.
 * 4. **Individual samples past the point where columns run out.** Once a column
 *    covers less than about two samples, drawing peak-per-column is a lie.
 *    Below that threshold it switches to a polyline through the real samples
 *    with a dot on each, which is what makes a click or a DC offset visible.
 */
import { computeWaveform, type WaveformData } from './analysis';

export interface WaveformStyle {
  wave: string;
  waveDeep: string;
  waveDim: string;
  background: string;
  backgroundAlt: string;
  line: string;
  flag: string;
  ink: string;
  inkDim: string;
}

export interface WaveformRegion {
  start: number;
  end: number;
}

export interface WaveformGrid {
  /** Seconds between lines. */
  period: number;
  /** Seconds from the file start to the first line. */
  offset: number;
  /** Draw every nth line stronger, e.g. 4 for a downbeat. 0 for no accent. */
  accent: number;
}

export interface WaveformView {
  start: number;
  end: number;
}

export interface WaveformOptions {
  /** Time ruler above the wave. Drawn here so there is one time mapping. */
  ruler?: HTMLCanvasElement | null;
  /** Whole-file overview with the viewport marked on it. */
  minimap?: HTMLCanvasElement | null;
  /** Fires whenever the visible range changes, for overlays and labels. */
  onViewChange?: (view: WaveformView) => void;
  style?: Partial<WaveformStyle>;
}

/** Fraction of half-height the hull may occupy, leaving a little air. */
const VERTICAL_FIT = 0.9;

/** Shortest span the viewport may hold. Below this, zooming stops. */
const MIN_SPAN = 0.005;

/** Columns per sample above which individual samples get drawn. */
const SAMPLE_VIEW_THRESHOLD = 0.5;

/** Nice-number ladder for ruler ticks. */
const TICK_STEPS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60,
  120, 300, 600, 900, 1800, 3600,
];

/**
 * Formats a tick label at the precision its step implies.
 *
 * Decomposed from an integer at label precision rather than from the float, so
 * 59.7 at a one-second step cannot render as "0:60".
 */
function tickLabel(seconds: number, step: number): string {
  const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  const scale = 10 ** decimals;
  const units = Math.max(0, Math.round(seconds * scale));
  const whole = Math.floor(units / scale);
  const frac = units - whole * scale;

  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;

  const secText =
    decimals === 0
      ? String(secs).padStart(2, '0')
      : `${String(secs).padStart(2, '0')}.${String(frac).padStart(decimals, '0')}`;

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${secText}`
    : `${minutes}:${secText}`;
}

/** Smallest step from the ladder whose spacing clears `minPx`. */
function chooseStep(pixelsPerSecond: number, minPx: number): number {
  for (const step of TICK_STEPS) {
    if (step * pixelsPerSecond >= minPx) return step;
  }
  return TICK_STEPS[TICK_STEPS.length - 1];
}

export class Waveform {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ruler: HTMLCanvasElement | null;
  private minimap: HTMLCanvasElement | null;
  private onViewChange: ((view: WaveformView) => void) | undefined;

  private buffer: AudioBuffer | null = null;
  private data: WaveformData | null = null;
  private dataKey = '';
  /** Whole-file scan, cached separately so the minimap never rescans. */
  private overview: WaveformData | null = null;
  private overviewKey = '';

  private style: WaveformStyle;
  private region: WaveformRegion | null = null;
  private markers: number[] = [];
  private highlights: WaveformRegion[] = [];
  private grid: WaveformGrid | null = null;
  private view: WaveformView = { start: 0, end: 0 };
  private observer: ResizeObserver | null = null;
  private frame = 0;

  constructor(canvas: HTMLCanvasElement, options: WaveformOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D context unavailable.');
    this.ctx = ctx;

    this.ruler = options.ruler ?? null;
    this.minimap = options.minimap ?? null;
    this.onViewChange = options.onViewChange;

    // Read the palette from CSS so the canvas can never drift from the tokens.
    const computed = getComputedStyle(canvas);
    const token = (name: string, fallback: string): string =>
      computed.getPropertyValue(name).trim() || fallback;

    this.style = {
      wave: token('--wave', '#31d685'),
      waveDeep: token('--wave-deep', '#12a35f'),
      waveDim: token('--wave-dim', '#385c46'),
      background: token('--stage', '#0a110c'),
      backgroundAlt: token('--stage-2', '#18241c'),
      line: token('--stage-line', '#28372e'),
      flag: token('--playhead', '#e9ad3f'),
      ink: token('--stage-ink', '#e5e9e6'),
      inkDim: token('--stage-ink-2', '#8e9490'),
      ...options.style,
    };

    if (typeof ResizeObserver !== 'undefined') {
      // Observe the wrappers, not the canvases: this class writes each canvas's
      // own CSS size to pin it to device pixels, which would otherwise
      // re-trigger the observer on every frame.
      //
      // All three wrappers, not just the waveform's. The ruler and the overview
      // start life inside a hidden or zero-height parent, where there is nothing
      // to measure; without a repaint when they gain a size, they keep the
      // default 300x150 backing store forever.
      this.observer = new ResizeObserver(() => this.scheduleRender());
      for (const target of [canvas, this.ruler, this.minimap]) {
        const box = target?.parentElement ?? target;
        if (box) this.observer.observe(box);
      }
    }
  }

  /**
   * `keepView` is for live previews. A tool that re-renders its preview on every
   * slider move hands over a brand new AudioBuffer each time, and resetting the
   * zoom on each of those would make the two features mutually exclusive.
   */
  setBuffer(buffer: AudioBuffer | null, keepView = false): void {
    const previous = this.buffer;
    this.buffer = buffer;
    this.data = null;
    this.dataKey = '';
    this.overview = null;
    this.overviewKey = '';

    if (buffer !== previous) {
      const total = buffer?.duration ?? 0;
      if (keepView && total > 0) {
        // A speed change alters the duration, so the old range may not fit.
        const span = Math.min(total, this.span);
        const start = Math.max(0, Math.min(total - span, this.view.start));
        this.view = { start, end: start + span };
      } else {
        this.view = { start: 0, end: total };
      }
      this.emitView();
    }

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

  /**
   * A repeating grid of vertical lines, for a detected beat.
   *
   * Drawn here rather than as a separate canvas over the top so it inherits the
   * viewport: zoom into one bar and the grid zooms with the audio, which is the
   * only way to check whether the lines actually land on the transients. Pass
   * null to clear.
   */
  setGrid(grid: WaveformGrid | null): void {
    this.grid = grid;
    this.scheduleRender();
  }

  // ---------- viewport ----------

  getView(): WaveformView {
    return { ...this.view };
  }

  /** Total file length, or 0 before a file is loaded. */
  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  /** Visible span in seconds. */
  get span(): number {
    return Math.max(MIN_SPAN, this.view.end - this.view.start);
  }

  /** How far in we are: 1 is the whole file, 40 is a fortieth of it. */
  zoomLevel(): number {
    const total = this.duration;
    return total > 0 ? total / this.span : 1;
  }

  /** True when the whole file is on screen, so "fit" is a no-op. */
  isFullyZoomedOut(): boolean {
    return this.span >= this.duration - 1e-6;
  }

  /** True when zooming in further would hit the floor. */
  isFullyZoomedIn(): boolean {
    return this.span <= MIN_SPAN + 1e-9;
  }

  setView(start: number, end: number): void {
    const total = this.duration;
    if (total <= 0) return;

    let span = Math.min(total, Math.max(MIN_SPAN, end - start));
    let from = Math.max(0, Math.min(total - span, start));
    if (!Number.isFinite(from)) from = 0;
    if (!Number.isFinite(span)) span = total;

    const next = { start: from, end: from + span };
    if (
      Math.abs(next.start - this.view.start) < 1e-9 &&
      Math.abs(next.end - this.view.end) < 1e-9
    ) {
      return;
    }

    this.view = next;
    this.emitView();
    this.scheduleRender();
  }

  /**
   * Multiplies the zoom, holding `anchor` still. Anchoring on the pointer is
   * what makes wheel zoom feel like a magnifier rather than a slider.
   */
  zoomBy(factor: number, anchor?: number): void {
    const total = this.duration;
    if (total <= 0) return;

    const current = this.span;
    const target = Math.min(total, Math.max(MIN_SPAN, current / factor));
    const at = anchor ?? this.view.start + current / 2;
    // Keep the anchor at the same fraction across the viewport.
    const ratio = Math.min(1, Math.max(0, (at - this.view.start) / current));
    this.setView(at - ratio * target, at - ratio * target + target);
  }

  zoomToFit(): void {
    this.setView(0, this.duration);
  }

  /** Frames a region with a little air either side. */
  zoomToRegion(region: WaveformRegion): void {
    const span = Math.max(MIN_SPAN, region.end - region.start);
    const pad = span * 0.08;
    this.setView(region.start - pad, region.end + pad);
  }

  panBy(seconds: number): void {
    this.setView(this.view.start + seconds, this.view.end + seconds);
  }

  /** Pans so `seconds` sits at `place` across the viewport (0..1). */
  centreOn(seconds: number, place = 0.5): void {
    const span = this.span;
    this.setView(seconds - span * place, seconds - span * place + span);
  }

  /**
   * Keeps a moving playhead on screen while zoomed, paging rather than
   * scrolling continuously so the waveform is readable during playback.
   */
  followPlayhead(seconds: number): void {
    if (this.isFullyZoomedOut()) return;
    const { start, end } = this.view;
    const margin = this.span * 0.08;
    if (seconds >= start + margin && seconds <= end - margin) return;
    this.centreOn(seconds, seconds < start ? 0.7 : 0.3);
  }

  private emitView(): void {
    this.onViewChange?.(this.getView());
  }

  // ---------- rendering ----------

  /** Coalesces repaints to one per frame during drags. */
  scheduleRender(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  /**
   * Sizes a canvas so one backing pixel is exactly one device pixel.
   *
   * The CSS size is written back in px. Any fractional layout width would
   * otherwise make the browser resample the bitmap, which is the whole reason
   * a per-pixel waveform can come out looking soft.
   */
  private sync(canvas: HTMLCanvasElement): { w: number; h: number } | null {
    // clientWidth/Height, never getBoundingClientRect: the rect is affected by
    // transforms, and the canvas carries a scaleY entrance animation. Measuring
    // mid-animation sized the backing store to a twentieth of the real box and
    // then wrote that size back, so the waveform was drawn into a sliver and
    // stretched to fill. That was the blur.
    const boxW = canvas.clientWidth;
    const boxH = canvas.clientHeight;
    if (boxW < 1 || boxH < 1) return null;

    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(boxW * dpr));
    const h = Math.max(1, Math.round(boxH * dpr));

    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      if (canvas === this.canvas) {
        this.data = null;
        this.dataKey = '';
      }
    }

    const cssW = `${w / dpr}px`;
    const cssH = `${h / dpr}px`;
    if (canvas.style.width !== cssW) canvas.style.width = cssW;
    if (canvas.style.height !== cssH) canvas.style.height = cssH;

    return { w, h };
  }

  render(): void {
    const size = this.sync(this.canvas);
    if (!size) return;
    const { w: width, h: height } = size;
    const { ctx } = this;

    ctx.fillStyle = this.style.background;
    ctx.fillRect(0, 0, width, height);

    if (!this.buffer) {
      this.renderRuler();
      this.renderMinimap();
      return;
    }

    if (this.view.end <= this.view.start) {
      this.view = { start: 0, end: this.buffer.duration };
    }

    const rate = this.buffer.sampleRate;
    const from = this.view.start * rate;
    const to = this.view.end * rate;

    const key = `${width}|${from.toFixed(3)}|${to.toFixed(3)}`;
    if (!this.data || this.dataKey !== key) {
      this.data = computeWaveform(this.buffer, width, from, to);
      this.dataKey = key;
    }

    const mid = height / 2;
    const scale = mid * VERTICAL_FIT;
    const toX = (seconds: number): number =>
      ((seconds - this.view.start) / this.span) * width;

    this.paintSegments(width, height, toX);
    this.paintHighlights(height, toX);
    this.paintBeatGrid(height, toX);
    this.paintGrid(width, height);

    // Centreline: gives silence a visible spine instead of a blank gap.
    ctx.fillStyle = this.style.line;
    ctx.fillRect(0, Math.round(mid), width, 1);

    const columnsPerSample = width / Math.max(1, to - from);

    if (columnsPerSample > SAMPLE_VIEW_THRESHOLD) {
      this.paintSamples(width, mid, scale, from, to);
    } else {
      const active = this.region
        ? { from: toX(this.region.start), to: toX(this.region.end) }
        : { from: 0, to: width };

      // Everything dim first, then the active span repainted bright through a
      // clip — cheaper and crisper than deciding a colour per column.
      this.paintWave(width, height, mid, scale, false);

      if (active.to > active.from) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(active.from, 0, active.to - active.from, height);
        ctx.clip();
        this.paintWave(width, height, mid, scale, true);
        ctx.restore();
      }
    }

    this.paintMarkers(height, toX);
    this.renderRuler();
    this.renderMinimap();
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

  /**
   * The beat grid.
   *
   * Every `period` seconds from `offset`, with every `accent`-th line drawn
   * stronger so bars are countable rather than an undifferentiated comb. Only
   * the lines inside the current view are computed, so zooming out on a long
   * track costs the same as zooming in.
   */
  private paintBeatGrid(height: number, toX: (seconds: number) => number): void {
    const grid = this.grid;
    if (!grid || grid.period <= 0) return;

    const { ctx } = this;
    const { start, end } = this.view;
    // Start at the first line at or after the left edge of the view.
    const first = Math.max(0, Math.ceil((start - grid.offset) / grid.period));
    const last = Math.floor((end - grid.offset) / grid.period);
    // A grid finer than a few pixels is a solid wash, so stop drawing it.
    if (toX(grid.offset + grid.period) - toX(grid.offset) < 3) return;

    ctx.save();
    ctx.fillStyle = this.style.flag;
    for (let n = first; n <= last; n += 1) {
      const time = grid.offset + n * grid.period;
      const x = Math.round(toX(time));
      const accented = grid.accent > 0 && n % grid.accent === 0;
      ctx.globalAlpha = accented ? 0.75 : 0.3;
      ctx.fillRect(x, accented ? 0 : height * 0.12, 1, accented ? height : height * 0.76);
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

  /**
   * Faint vertical lines on the same ticks the ruler labels.
   *
   * Without them, a zoomed waveform is a shape with no scale: you can see a
   * transient but not tell whether it is 200ms or 2s from the last one.
   */
  private paintGrid(width: number, height: number): void {
    const { ctx } = this;
    const perSecond = width / this.span;
    const step = chooseStep(perSecond, 108);

    ctx.save();
    ctx.fillStyle = this.style.line;
    ctx.globalAlpha = 0.5;
    const first = Math.ceil(this.view.start / step) * step;
    for (let t = first; t <= this.view.end; t += step) {
      const x = Math.round(((t - this.view.start) / this.span) * width);
      if (x > 0 && x < width) ctx.fillRect(x, 0, 1, height);
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

  /** Vertical gradient so the body has depth without being decorated. */
  private fill(height: number, active: boolean): CanvasGradient | string {
    if (!active) return this.style.waveDim;
    const gradient = this.ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, this.style.waveDeep);
    gradient.addColorStop(0.5, this.style.wave);
    gradient.addColorStop(1, this.style.waveDeep);
    return gradient;
  }

  /**
   * Crisp hull, smooth body.
   *
   * The hull is one integer-aligned rect per column, collected into a single
   * path and filled once: hard edges, one fill call. The RMS body over it is a
   * continuous path, which is what stops a per-pixel waveform reading as noise.
   */
  private paintWave(
    width: number,
    height: number,
    mid: number,
    scale: number,
    active: boolean
  ): void {
    const data = this.data;
    if (!data) return;

    const { ctx } = this;
    const { peaks, rms } = data;
    const paint = this.fill(height, active);

    ctx.fillStyle = paint;

    // Outer hull, as hard-edged columns.
    ctx.globalAlpha = active ? 0.5 : 0.75;
    ctx.beginPath();
    for (let x = 0; x < width; x += 1) {
      const top = Math.round(mid - peaks[x * 2 + 1] * scale);
      const bottom = Math.round(mid - peaks[x * 2] * scale);
      ctx.rect(x, top, 1, Math.max(1, bottom - top));
    }
    ctx.fill();

    // RMS body, as one continuous shape.
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid - rms[0] * scale);
    for (let x = 0; x < width; x += 1) ctx.lineTo(x, mid - rms[x] * scale);
    for (let x = width - 1; x >= 0; x -= 1) ctx.lineTo(x, mid + rms[x] * scale);
    ctx.closePath();
    ctx.fill();

    ctx.globalAlpha = 1;
  }

  /**
   * Individual samples, for when the viewport holds fewer samples than pixels.
   *
   * Peak-per-column stops meaning anything at that point, and this is the view
   * that makes a click, a clipped peak or a DC offset visible.
   */
  private paintSamples(
    width: number,
    mid: number,
    scale: number,
    fromSample: number,
    toSample: number
  ): void {
    const buffer = this.buffer;
    if (!buffer) return;

    const { ctx } = this;
    const first = Math.max(0, Math.floor(fromSample));
    const last = Math.min(buffer.length, Math.ceil(toSample) + 1);
    if (last <= first) return;

    const channels = Math.min(2, buffer.numberOfChannels);
    const perSample = width / (toSample - fromSample);
    const dotRadius = Math.min(3.5, Math.max(1, perSample * 0.16));

    for (let c = 0; c < channels; c += 1) {
      const samples = buffer.getChannelData(c);
      const active = c === 0;

      ctx.save();
      ctx.strokeStyle = active ? this.style.wave : this.style.waveDeep;
      ctx.globalAlpha = channels > 1 ? (active ? 0.95 : 0.55) : 1;
      ctx.lineWidth = Math.max(1.5, Math.min(2.5, perSample * 0.1));
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      // A stem from the centreline to each sample, which is what turns a line
      // into readable sample values. Only once they are far enough apart that
      // the stems are not just a solid block.
      if (perSample > 12) {
        ctx.save();
        ctx.globalAlpha *= 0.4;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = first; i < last; i += 1) {
          const x = Math.round((i - fromSample) * perSample) + 0.5;
          ctx.moveTo(x, mid);
          ctx.lineTo(x, mid - samples[i] * scale);
        }
        ctx.stroke();
        ctx.restore();
      }

      ctx.beginPath();
      for (let i = first; i < last; i += 1) {
        const x = (i - fromSample) * perSample;
        const y = mid - samples[i] * scale;
        if (i === first) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // A dot per sample, once they are far enough apart to be distinct.
      if (perSample > 5) {
        ctx.fillStyle = active ? this.style.wave : this.style.waveDeep;
        ctx.beginPath();
        for (let i = first; i < last; i += 1) {
          const x = (i - fromSample) * perSample;
          const y = mid - samples[i] * scale;
          ctx.moveTo(x + dotRadius, y);
          ctx.arc(x, y, dotRadius, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // ---------- ruler ----------

  private renderRuler(): void {
    const canvas = this.ruler;
    if (!canvas) return;
    const size = this.sync(canvas);
    if (!size) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w: width, h: height } = size;
    const dpr = Math.min(2, window.devicePixelRatio || 1);

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = this.style.backgroundAlt;
    ctx.fillRect(0, 0, width, height);

    if (!this.buffer) return;

    const perSecond = width / this.span;
    const step = chooseStep(perSecond, 108);
    const minor = step / (step === 0.5 || step === 15 || step === 5 ? 5 : 4);

    ctx.font = `500 ${Math.round(10.5 * dpr)}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textBaseline = 'alphabetic';

    const firstMinor = Math.ceil(this.view.start / minor) * minor;
    ctx.fillStyle = this.style.line;
    for (let t = firstMinor; t <= this.view.end; t += minor) {
      const x = Math.round(((t - this.view.start) / this.span) * width);
      ctx.fillRect(x, height - Math.round(4 * dpr), 1, Math.round(4 * dpr));
    }

    const firstMajor = Math.ceil(this.view.start / step) * step;
    for (let t = firstMajor; t <= this.view.end; t += step) {
      const x = Math.round(((t - this.view.start) / this.span) * width);
      ctx.fillStyle = this.style.inkDim;
      ctx.fillRect(x, height - Math.round(8 * dpr), 1, Math.round(8 * dpr));
      // Nudge the first label inboard so it is never clipped by the edge.
      const label = tickLabel(t, step);
      const metrics = ctx.measureText(label);
      const tx = Math.min(width - metrics.width - 4 * dpr, Math.max(3 * dpr, x + 4 * dpr));
      ctx.fillStyle = this.style.ink;
      ctx.fillText(label, tx, Math.round(height - 11 * dpr));
    }
  }

  // ---------- minimap ----------

  private renderMinimap(): void {
    const canvas = this.minimap;
    if (!canvas) return;
    const size = this.sync(canvas);
    if (!size) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w: width, h: height } = size;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = this.style.backgroundAlt;
    ctx.fillRect(0, 0, width, height);

    const buffer = this.buffer;
    if (!buffer) return;

    const key = `${width}|${buffer.length}`;
    if (!this.overview || this.overviewKey !== key) {
      this.overview = computeWaveform(buffer, width);
      this.overviewKey = key;
    }

    const mid = height / 2;
    const scale = mid * 0.86;
    const { peaks } = this.overview;

    ctx.fillStyle = this.style.waveDim;
    ctx.beginPath();
    for (let x = 0; x < width; x += 1) {
      const top = Math.round(mid - peaks[x * 2 + 1] * scale);
      const bottom = Math.round(mid - peaks[x * 2] * scale);
      ctx.rect(x, top, 1, Math.max(1, bottom - top));
    }
    ctx.fill();

    const total = this.duration;
    if (total <= 0) return;

    const exactFrom = (this.view.start / total) * width;
    const exactTo = (this.view.end / total) * width;

    // Zoomed right in, the true window is a fraction of a pixel wide. It is
    // widened to a floor here so it stays visible and stays grabbable, centred
    // on where the window really is rather than drifting to one side.
    const minSpan = Math.min(width, 10);
    const span = Math.max(minSpan, exactTo - exactFrom);
    const centre = (exactFrom + exactTo) / 2;
    const from = Math.round(
      Math.max(0, Math.min(width - span, centre - span / 2))
    );
    const wide = Math.round(span);

    // The visible slice, repainted bright inside the window.
    ctx.save();
    ctx.beginPath();
    ctx.rect(from, 0, wide, height);
    ctx.clip();
    ctx.fillStyle = this.style.wave;
    ctx.beginPath();
    for (let x = from; x < from + wide; x += 1) {
      if (x < 0 || x >= width) continue;
      const top = Math.round(mid - peaks[x * 2 + 1] * scale);
      const bottom = Math.round(mid - peaks[x * 2] * scale);
      ctx.rect(x, top, 1, Math.max(1, bottom - top));
    }
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = this.style.wave;
    ctx.lineWidth = 2;
    ctx.strokeRect(from + 1, 1, Math.max(2, wide - 2), height - 2);
  }

  /** Fraction across the minimap to a time in seconds. */
  minimapTimeAt(clientX: number): number {
    const canvas = this.minimap;
    if (!canvas || !this.buffer) return 0;
    const rect = canvas.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    return Math.min(this.duration, Math.max(0, ratio * this.duration));
  }

  // ---------- coordinates ----------

  /** Pixel x within the canvas to a time in seconds, through the viewport. */
  timeAt(clientX: number): number {
    if (!this.buffer) return 0;
    const rect = this.canvas.getBoundingClientRect();
    const ratio = (clientX - rect.left) / rect.width;
    return Math.min(
      this.buffer.duration,
      Math.max(0, this.view.start + ratio * this.span)
    );
  }

  /**
   * Seconds to a percentage across the viewport, for positioning overlays in
   * CSS. Deliberately not clamped: a caller needs to know that a marker is off
   * screen so it can hide it rather than pin it to the edge.
   */
  positionOf(seconds: number): number {
    if (!this.buffer || this.span <= 0) return 0;
    return ((seconds - this.view.start) / this.span) * 100;
  }

  /** Whether a time falls inside the visible range. */
  inView(seconds: number): boolean {
    return seconds >= this.view.start - 1e-9 && seconds <= this.view.end + 1e-9;
  }

  /** Seconds represented by one CSS pixel, for keyboard nudge sizing. */
  secondsPerPixel(): number {
    const box = this.canvas.clientWidth;
    return box > 0 ? this.span / box : 0;
  }

  /**
   * A sensible thing to hold still while zooming: the playhead when it is
   * somewhere in the middle of the view, the centre otherwise. Anchoring on a
   * playhead parked at 0:00 would zoom into the very start of the file, which
   * is never what pressing "+" is asking for.
   */
  anchorFor(playhead: number): number {
    const { start } = this.view;
    const span = this.span;
    const at = (playhead - start) / span;
    return at > 0.1 && at < 0.9 ? playhead : start + span / 2;
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
    background = '#0a110c',
    color = '#31d685',
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
