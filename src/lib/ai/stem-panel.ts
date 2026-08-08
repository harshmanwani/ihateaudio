/**
 * Builds the multitrack panel and wires it to a StemPlayer.
 *
 * Split from stem-player.ts on purpose: that file is audio and has no idea the DOM
 * exists, which is what makes it testable. This one is all DOM and holds no audio
 * state of its own — everything it renders it reads back from the player.
 */
import { computeWaveform } from '../audio/analysis';
import { drawableColor, panelContext } from '../canvas';
import { exportAudio } from '../audio/export';
import { saveBlob } from '../files';
import { timecode } from '../format';
import { StemPlayer, type Stem } from './stem-player';

export interface StemPanelOptions {
  /** Base name for downloads, usually the source file without its extension. */
  baseName: string;
  /**
   * Export format id. Optional because the panel now carries its own picker —
   * this exists only as a fallback for a page that renders the markup without
   * one.
   */
  format?: () => string;
  /** Called when something goes wrong encoding a download. */
  onError?: (message: string) => void;
  /**
   * 'full' is the mixer. 'listen' is the result strip: transport, waveform and
   * playhead only, because a single result has nothing to mute or solo against
   * and its download belongs to the export bar sitting under it.
   */
  chrome?: 'full' | 'listen';
}

interface Row {
  stem: Stem;
  element: HTMLElement;
  canvas: HTMLCanvasElement;
  mute: HTMLButtonElement | null;
  solo: HTMLButtonElement | null;
}

/**
 * One hue per track, spread right around the wheel rather than shaded from the
 * category colour.
 *
 * A mixer's whole job is telling four rows apart at a glance, and four tints of the
 * same coral fails at that — which is exactly how the first version looked. Lightness
 * and chroma are held constant so no track reads as more important than another;
 * only the hue moves. All four are chosen to sit legibly on the dark strip.
 *
 * Each carries the sRGB it resolves to, for canvases that cannot read `oklch()`.
 * Holding the pair here rather than converting on the fly keeps the authored
 * colour authoritative — the fallback is a transcription of it, not a guess.
 */
const TRACK_HUES = [
  ['oklch(0.72 0.17 26)', '#fd736a'],
  ['oklch(0.78 0.16 95)', '#d8b501'],
  ['oklch(0.72 0.14 205)', '#00bdce'],
  ['oklch(0.72 0.16 300)', '#b58bf9'],
] as const;

/**
 * Draws one stem's waveform into its strip.
 *
 * Deliberately plainer than the main tool waveform: this is a thumbnail whose job
 * is to show the shape of the part — where the vocal enters, whether the bass is
 * playing — at a glance, not to be scrubbed or measured. So it is a filled envelope
 * with no ruler, no playhead and no zoom.
 */
function paintWave(canvas: HTMLCanvasElement, stem: Stem, colour: string): void {
  const cssWidth = canvas.clientWidth;
  const cssHeight = canvas.clientHeight;
  if (cssWidth < 1 || cssHeight < 1) return;

  // clientWidth rather than getBoundingClientRect: the panel animates in, and a
  // transform-affected measurement would size the backing store to a sliver and
  // then stretch it. That was the cause of the blurry waveform on the tool pages.
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(cssWidth * dpr));
  const height = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const context = panelContext(canvas);
  if (!context) return;
  context.clearRect(0, 0, width, height);

  const columns = Math.max(1, Math.floor(width));
  const data = computeWaveform(stem.buffer, columns);
  const middle = height / 2;

  context.fillStyle = colour;
  for (let x = 0; x < columns; x += 1) {
    const low = data.peaks[2 * x] ?? 0;
    const high = data.peaks[2 * x + 1] ?? 0;
    const top = middle - high * middle;
    const bottom = middle - low * middle;
    // A minimum of one pixel, so silent passages read as a line rather than as a
    // gap that looks like missing data.
    context.fillRect(x, top, 1, Math.max(1, bottom - top));
  }
}

/** Timecode with tenths, for the bubble that rides on the playhead. */
function precise(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}

export class StemPanel {
  private root: HTMLElement;
  private player: StemPlayer;
  private rows: Row[] = [];
  private options: StemPanelOptions;
  private unsubscribe: (() => void) | null = null;
  private scrubbing = false;

  /**
   * Where the pointer has dragged to, or null when nothing is being dragged.
   *
   * Held separately from the player's own position because a drag updates the
   * display on every pointer move but only commits on release. Seeking a running
   * StemPlayer tears down and rebuilds a buffer source per stem, so seeking on
   * every move would be several hundred node rebuilds a second and audibly
   * stutters. Showing the drag and committing once is both cheaper and closer to
   * how a DAW behaves.
   */
  private dragRatio: number | null = null;

  private playButton: HTMLButtonElement | null;
  private scrub: HTMLElement | null;
  private scrubFill: HTMLElement | null;
  private timeLabel: HTMLElement | null;
  private list: HTMLElement | null;
  private formatSelect: HTMLSelectElement | null;
  private stage: HTMLElement | null;
  private head: HTMLElement | null;
  private headTime: HTMLElement | null;
  private ghost: HTMLElement | null;
  private ghostTime: HTMLElement | null;

  constructor(root: HTMLElement, stems: Stem[], options: StemPanelOptions) {
    this.root = root;
    this.options = options;
    this.player = new StemPlayer(stems);

    this.playButton = root.querySelector('[data-stem-play]');
    this.scrub = root.querySelector('[data-stem-scrub]');
    this.scrubFill = root.querySelector('[data-stem-scrub-fill]');
    this.timeLabel = root.querySelector('[data-stem-time]');
    this.list = root.querySelector('[data-stem-list]');
    this.formatSelect = root.querySelector('[data-stem-format]');
    this.stage = root.querySelector('[data-stem-stage]');
    this.head = root.querySelector('[data-stem-head]');
    this.headTime = root.querySelector('[data-stem-head-time]');
    this.ghost = root.querySelector('[data-stem-ghost]');
    this.ghostTime = root.querySelector('[data-stem-ghost-time]');

    this.build(stems);
    this.bindTransport();

    this.unsubscribe = this.player.subscribe((state) => this.render(state));
    root.hidden = false;

    // Canvases have no width until the panel is visible, so the first paint waits
    // for layout rather than drawing into a zero-width buffer.
    requestAnimationFrame(() => this.repaint());

    /**
     * Watches the first waveform as well as the panel.
     *
     * Observing only the panel is not enough. Both the waveform painting and the
     * playhead measurement give up on a zero-width canvas, and if the one frame
     * they run in happens to land before the canvas has been laid out, nothing
     * ever asks again and the playhead stays hidden for good. Watching the thing
     * actually being measured means the width arriving is itself the trigger.
     */
    const observer = new ResizeObserver(() => this.repaint());
    observer.observe(root);
    const first = this.rows[0]?.canvas;
    if (first) observer.observe(first);
  }

  private build(stems: Stem[]): void {
    if (!this.list) return;
    this.list.innerHTML = '';

    for (const stem of stems) {
      const element = document.createElement('div');
      element.className = 'stem';
      element.dataset.stemId = stem.id;
      element.dataset.audible = 'true';

      const name = document.createElement('span');
      name.className = 'stem__name';
      name.textContent = stem.name;

      if (this.options.chrome === 'listen') {
        // Name and waveform only. The canvas still binds for seeking.
        const canvas = document.createElement('canvas');
        canvas.className = 'stem__wave';
        this.bindCanvas(canvas);
        element.append(name, canvas);
        element.classList.add('stem--listen');
        this.list.append(element);
        this.rows.push({ stem, element, canvas, mute: null, solo: null });
        continue;
      }

      const controls = document.createElement('div');
      controls.className = 'stem__controls';

      const mute = document.createElement('button');
      mute.type = 'button';
      mute.className = 'stem__btn';
      mute.textContent = 'M';
      mute.setAttribute('aria-pressed', 'false');
      mute.setAttribute('aria-label', `Mute ${stem.name}`);
      mute.title = `Mute ${stem.name}`;
      mute.addEventListener('click', () => {
        this.player.setMuted(stem.id, !this.player.isMuted(stem.id));
      });

      const solo = document.createElement('button');
      solo.type = 'button';
      solo.className = 'stem__btn';
      solo.textContent = 'S';
      solo.setAttribute('aria-pressed', 'false');
      solo.setAttribute('aria-label', `Solo ${stem.name}`);
      solo.title = `Hear ${stem.name} on its own`;
      solo.addEventListener('click', () => this.player.setSolo(stem.id));

      const level = document.createElement('input');
      level.type = 'range';
      level.className = 'stem__level';
      level.min = '0';
      level.max = '1.5';
      level.step = '0.01';
      level.value = '1';
      level.setAttribute('aria-label', `${stem.name} level`);
      level.addEventListener('input', () => {
        this.player.setLevel(stem.id, Number(level.value));
      });

      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'stem__btn stem__save';
      save.innerHTML = '&darr;';
      save.setAttribute('aria-label', `Download ${stem.name}`);
      save.title = `Download ${stem.name}`;
      save.addEventListener('click', () => void this.download(stem, save));

      controls.append(mute, solo, level, save);

      const canvas = document.createElement('canvas');
      canvas.className = 'stem__wave';
      // The waveform is the seek surface. Binding here rather than to a
      // transparent overlay is what keeps the mute, solo and level controls
      // clickable: an overlay wide enough to cover the waveform also covers
      // those controls once the layout stacks under 720px.
      this.bindCanvas(canvas);

      element.append(name, controls, canvas);
      this.list.append(element);
      this.rows.push({ stem, element, canvas, mute, solo });
    }
  }

  /** Fraction along an element that a pointer event landed at, clamped. */
  private static ratioIn(element: HTMLElement, event: PointerEvent): number {
    const rect = element.getBoundingClientRect();
    if (rect.width < 1) return 0;
    return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
  }

  /** Drag begins: show the new position without disturbing playback yet. */
  private beginScrub(ratio: number): void {
    this.scrubbing = true;
    this.dragRatio = ratio;
    this.position();
  }

  private moveScrub(ratio: number): void {
    if (!this.scrubbing) return;
    this.dragRatio = ratio;
    this.position();
  }

  /** Drag ends: one seek, for the position actually chosen. */
  private endScrub(): void {
    if (!this.scrubbing) return;
    const ratio = this.dragRatio;
    this.scrubbing = false;
    this.dragRatio = null;
    if (ratio !== null) this.player.seek(ratio * this.player.state().duration);
  }

  private bindCanvas(canvas: HTMLCanvasElement): void {
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      canvas.setPointerCapture(event.pointerId);
      this.hideGhost();
      this.beginScrub(StemPanel.ratioIn(canvas, event));
      // So the arrow keys work straight after a click, without a second tab.
      this.stage?.focus({ preventScroll: true });
    });

    canvas.addEventListener('pointermove', (event) => {
      const ratio = StemPanel.ratioIn(canvas, event);
      if (this.scrubbing) this.moveScrub(ratio);
      else this.showGhost(ratio);
    });

    const end = (event: PointerEvent): void => {
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      this.endScrub();
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', () => {
      if (!this.scrubbing) this.hideGhost();
    });
  }

  private bindTransport(): void {
    this.playButton?.addEventListener('click', () => void this.player.toggle());

    if (this.scrub) {
      const bar = this.scrub;
      bar.addEventListener('pointerdown', (event) => {
        bar.setPointerCapture(event.pointerId);
        this.beginScrub(StemPanel.ratioIn(bar, event));
      });
      bar.addEventListener('pointermove', (event) => {
        this.moveScrub(StemPanel.ratioIn(bar, event));
      });
      const end = (event: PointerEvent): void => {
        if (bar.hasPointerCapture(event.pointerId)) bar.releasePointerCapture(event.pointerId);
        this.endScrub();
      };
      bar.addEventListener('pointerup', end);
      bar.addEventListener('pointercancel', end);
    }

    this.root
      .querySelector<HTMLButtonElement>('[data-stem-mix]')
      ?.addEventListener('click', (event) => {
        void this.downloadMix(event.currentTarget as HTMLButtonElement);
      });

    // Space is the universal play/pause and the arrows move the playhead, both
    // from anywhere in the panel rather than only when one particular thing has
    // focus. The buttons and the level sliders use all of these keys themselves,
    // so they keep them.
    this.root.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement;
      if (target.tagName === 'BUTTON' || target.tagName === 'INPUT') return;

      const state = this.player.state();
      const to = (seconds: number): void => {
        event.preventDefault();
        this.player.seek(seconds);
      };

      switch (event.key) {
        case ' ':
        case 'Spacebar':
          event.preventDefault();
          void this.player.toggle();
          break;
        // Shift for a fine nudge, since judging a separation often means landing
        // on one particular word rather than somewhere in the chorus.
        case 'ArrowLeft':
          to(state.time - (event.shiftKey ? 1 : 5));
          break;
        case 'ArrowRight':
          to(state.time + (event.shiftKey ? 1 : 5));
          break;
        case 'Home':
          to(0);
          break;
        case 'End':
          to(state.duration);
          break;
      }
    });
  }

  private showGhost(ratio: number): void {
    if (!this.ghost) return;
    this.ghost.hidden = false;
    this.stage?.style.setProperty('--hover', String(ratio));
    if (this.ghostTime) {
      this.ghostTime.textContent = precise(ratio * this.player.state().duration);
    }
  }

  private hideGhost(): void {
    if (this.ghost) this.ghost.hidden = true;
  }

  /**
   * Writes the playhead position, which is the drag if there is one and the
   * player's own position otherwise.
   *
   * Everything downstream is a custom property rather than a style recalculation:
   * CSS does the arithmetic against the measured column geometry, so this runs
   * sixty times a second without touching layout.
   */
  private position(state = this.player.state()): void {
    const ratio =
      this.dragRatio ?? (state.duration > 0 ? state.time / state.duration : 0);
    const time = ratio * state.duration;

    this.stage?.style.setProperty('--play', String(ratio));
    if (this.scrubFill) this.scrubFill.style.width = `${ratio * 100}%`;
    if (this.headTime) this.headTime.textContent = precise(time);
    if (this.timeLabel) {
      this.timeLabel.textContent = `${timecode(time)} / ${timecode(state.duration)}`;
    }
  }

  /**
   * Measures where the waveform column actually is and hands CSS the two numbers.
   *
   * Measured rather than assumed because the column moves: it is the third grid
   * column on a wide screen and a full-width row of its own under 720px. Reading
   * it back from a real canvas is the only thing that stays true through a
   * breakpoint change, a font swap or a scrollbar appearing.
   */
  private measure(): void {
    const canvas = this.rows[0]?.canvas;
    if (!canvas || !this.stage) return;

    const stage = this.stage.getBoundingClientRect();
    const wave = canvas.getBoundingClientRect();
    if (wave.width < 1) return;

    this.stage.style.setProperty('--wave-left', `${wave.left - stage.left}px`);
    this.stage.style.setProperty('--wave-width', `${wave.width}px`);
    // Held back until the geometry is real, so it never appears at the far left
    // for one frame before jumping into place.
    if (this.head) this.head.hidden = false;
  }

  private render(state: ReturnType<StemPlayer['state']>): void {
    if (this.playButton) {
      this.playButton.setAttribute(
        'aria-label',
        state.playing ? 'Pause all stems' : 'Play all stems'
      );
      // The icon is swapped by class rather than re-rendered, so the button never
      // loses focus mid-playback.
      this.playButton.dataset.playing = String(state.playing);
    }

    this.position(state);

    for (const row of this.rows) {
      const soloed = state.solo === row.stem.id;
      const muted = this.player.isMuted(row.stem.id);
      const audible = state.solo ? soloed : !muted;
      row.element.dataset.audible = String(audible);
      row.mute?.setAttribute('aria-pressed', String(muted));
      row.solo?.setAttribute('aria-pressed', String(soloed));
    }
  }

  private repaint(): void {
    for (let i = 0; i < this.rows.length; i += 1) {
      const row = this.rows[i]!;
      const [authored, srgb] = TRACK_HUES[i % TRACK_HUES.length]!;
      paintWave(row.canvas, row.stem, drawableColor(authored, srgb));
    }
    // Same trigger as the waveforms, because anything that changes their width
    // changes where the playhead has to sit.
    this.measure();
  }

  /** The panel's own picker first, the page's function as a fallback, WAV last. */
  private chosenFormat(): string {
    return this.formatSelect?.value ?? this.options.format?.() ?? 'wav';
  }

  private async download(stem: Stem, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const format = this.chosenFormat();
      const blob = await exportAudio(stem.buffer, format);
      const extension = format === 'wav' ? 'wav' : format;
      saveBlob(blob, `${this.options.baseName}-${stem.id}.${extension}`);
    } catch (error) {
      this.options.onError?.(
        error instanceof Error ? error.message : 'Could not encode that stem.'
      );
    } finally {
      button.disabled = false;
    }
  }

  private async downloadMix(button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const mixed = await this.player.mixdown();
      const format = this.chosenFormat();
      const blob = await exportAudio(mixed, format);
      const extension = format === 'wav' ? 'wav' : format;
      saveBlob(blob, `${this.options.baseName}-mix.${extension}`);
    } catch (error) {
      this.options.onError?.(
        error instanceof Error ? error.message : 'Could not mix those stems down.'
      );
    } finally {
      button.disabled = false;
    }
  }

  destroy(): void {
    this.unsubscribe?.();
    this.player.destroy();
    this.rows = [];
    this.root.hidden = true;
  }
}

/**
 * Replaces any existing panel on the page.
 *
 * Running a tool twice must not leave the first panel's AudioContext alive — a
 * second separation would otherwise play over the first.
 */
let active: StemPanel | null = null;

export function mountStemPanel(
  root: HTMLElement | null,
  stems: Stem[],
  options: StemPanelOptions
): StemPanel | null {
  active?.destroy();
  active = null;
  if (!root || stems.length === 0) return null;
  active = new StemPanel(root, stems, options);
  return active;
}
