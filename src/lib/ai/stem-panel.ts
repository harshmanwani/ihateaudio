/**
 * Builds the multitrack panel and wires it to a StemPlayer.
 *
 * Split from stem-player.ts on purpose: that file is audio and has no idea the DOM
 * exists, which is what makes it testable. This one is all DOM and holds no audio
 * state of its own — everything it renders it reads back from the player.
 */
import { computeWaveform } from '../audio/analysis';
import { exportAudio } from '../audio/export';
import { saveBlob } from '../files';
import { timecode } from '../format';
import { StemPlayer, type Stem } from './stem-player';

export interface StemPanelOptions {
  /** Base name for downloads, usually the source file without its extension. */
  baseName: string;
  /** Export format id, taken from the tool's own picker. */
  format: () => string;
  /** Called when something goes wrong encoding a download. */
  onError?: (message: string) => void;
}

interface Row {
  stem: Stem;
  element: HTMLElement;
  canvas: HTMLCanvasElement;
  mute: HTMLButtonElement;
  solo: HTMLButtonElement;
}

/**
 * One hue per track, spread right around the wheel rather than shaded from the
 * category colour.
 *
 * A mixer's whole job is telling four rows apart at a glance, and four tints of the
 * same coral fails at that — which is exactly how the first version looked. Lightness
 * and chroma are held constant so no track reads as more important than another;
 * only the hue moves. All four are chosen to sit legibly on the dark strip.
 */
const TRACK_HUES = [
  'oklch(0.72 0.17 26)',
  'oklch(0.78 0.16 95)',
  'oklch(0.72 0.14 205)',
  'oklch(0.72 0.16 300)',
];

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

  const context = canvas.getContext('2d');
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

export class StemPanel {
  private root: HTMLElement;
  private player: StemPlayer;
  private rows: Row[] = [];
  private options: StemPanelOptions;
  private unsubscribe: (() => void) | null = null;
  private scrubbing = false;

  private playButton: HTMLButtonElement | null;
  private scrub: HTMLElement | null;
  private scrubFill: HTMLElement | null;
  private timeLabel: HTMLElement | null;
  private list: HTMLElement | null;

  constructor(root: HTMLElement, stems: Stem[], options: StemPanelOptions) {
    this.root = root;
    this.options = options;
    this.player = new StemPlayer(stems);

    this.playButton = root.querySelector('[data-stem-play]');
    this.scrub = root.querySelector('[data-stem-scrub]');
    this.scrubFill = root.querySelector('[data-stem-scrub-fill]');
    this.timeLabel = root.querySelector('[data-stem-time]');
    this.list = root.querySelector('[data-stem-list]');

    this.build(stems);
    this.bindTransport();

    this.unsubscribe = this.player.subscribe((state) => this.render(state));
    root.hidden = false;

    // Canvases have no width until the panel is visible, so the first paint waits
    // for layout rather than drawing into a zero-width buffer.
    requestAnimationFrame(() => this.repaint());

    const observer = new ResizeObserver(() => this.repaint());
    observer.observe(root);
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

      element.append(name, controls, canvas);
      this.list.append(element);
      this.rows.push({ stem, element, canvas, mute, solo });
    }
  }

  private bindTransport(): void {
    this.playButton?.addEventListener('click', () => void this.player.toggle());

    if (this.scrub) {
      const seekFrom = (event: PointerEvent): void => {
        const rect = this.scrub!.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        this.player.seek(ratio * this.player.state().duration);
      };

      this.scrub.addEventListener('pointerdown', (event) => {
        this.scrubbing = true;
        this.scrub!.setPointerCapture(event.pointerId);
        seekFrom(event);
      });
      this.scrub.addEventListener('pointermove', (event) => {
        if (this.scrubbing) seekFrom(event);
      });
      const end = (event: PointerEvent): void => {
        if (!this.scrubbing) return;
        this.scrubbing = false;
        this.scrub!.releasePointerCapture(event.pointerId);
      };
      this.scrub.addEventListener('pointerup', end);
      this.scrub.addEventListener('pointercancel', end);
    }

    this.root
      .querySelector<HTMLButtonElement>('[data-stem-mix]')
      ?.addEventListener('click', (event) => {
        void this.downloadMix(event.currentTarget as HTMLButtonElement);
      });

    // Space is the universal play/pause, and it should work from anywhere in the
    // panel rather than only when the button happens to have focus.
    this.root.addEventListener('keydown', (event) => {
      if (event.key !== ' ' && event.key !== 'Spacebar') return;
      const target = event.target as HTMLElement;
      // Not when the focus is on a control that uses space itself.
      if (target.tagName === 'BUTTON' || target.tagName === 'INPUT') return;
      event.preventDefault();
      void this.player.toggle();
    });
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

    const ratio = state.duration > 0 ? state.time / state.duration : 0;
    if (this.scrubFill) this.scrubFill.style.width = `${ratio * 100}%`;
    if (this.timeLabel) {
      this.timeLabel.textContent = `${timecode(state.time)} / ${timecode(state.duration)}`;
    }

    for (const row of this.rows) {
      const soloed = state.solo === row.stem.id;
      const muted = this.player.isMuted(row.stem.id);
      const audible = state.solo ? soloed : !muted;
      row.element.dataset.audible = String(audible);
      row.mute.setAttribute('aria-pressed', String(muted));
      row.solo.setAttribute('aria-pressed', String(soloed));
    }
  }

  private repaint(): void {
    for (let i = 0; i < this.rows.length; i += 1) {
      const row = this.rows[i]!;
      paintWave(row.canvas, row.stem, TRACK_HUES[i % TRACK_HUES.length]!);
    }
  }

  private async download(stem: Stem, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    try {
      const format = this.options.format();
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
      const format = this.options.format();
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
