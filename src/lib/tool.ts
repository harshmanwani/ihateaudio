/**
 * The shared tool runtime.
 *
 * Every tool page renders the same DOM skeleton (see ToolShell.astro) and then
 * calls `createTool` with the handful of things that actually differ: which
 * controls it has, and what it does to the audio. Intake, decoding, the
 * waveform, the transport, selection, export, error handling and chaining all
 * live here — which is why adding a tool is a config plus a process function,
 * and why a user who learns one tool has learned all forty.
 */
import { decodeFile } from './audio/decode';
import { AudioError, toAudioError } from './audio/errors';
import { Player } from './audio/player';
import { Waveform } from './audio/waveform';
import {
  exportAudio,
  estimateSize,
  bitratesFor,
  formatById,
  FORMATS,
  type FormatSpec,
} from './audio/export';
import {
  attachDropzone,
  saveBlob,
  stashForNextTool,
  claimHandoff,
  AUDIO_ACCEPT,
  MEDIA_ACCEPT,
} from './files';
import { timecode, filesize, outputName, baseName, duration as fmtDuration } from './format';
import { track, durationBucket } from './track';
import { mountStemPanel } from './ai/stem-panel';

export interface Selection {
  start: number;
  end: number;
}

export interface ToolContext {
  /** The decoded source. Never mutated by the runtime. */
  buffer: AudioBuffer;
  /** Every decoded input, for multi-file tools. */
  buffers: AudioBuffer[];
  files: File[];
  selection: Selection;
  /** Reports 0..1 during a long process step, with an optional phase name. */
  progress: (ratio: number, label?: string) => void;
  signal: AbortSignal;
}

/** A named output. Tools returning several of these get a result list. */
export interface NamedOutput {
  name: string;
  buffer?: AudioBuffer;
  blob?: Blob;
}

export type ProcessResult =
  | AudioBuffer
  | Blob
  | NamedOutput[]
  | { buffer: AudioBuffer; suffix?: string };

export interface ToolConfig {
  /** Suffix appended to the output filename, e.g. "trimmed". */
  suffix: string;
  /** Accept and decode more than one file. */
  multiple?: boolean;
  /** Show draggable selection handles over the waveform. */
  selection?: boolean;
  /** Enable draggable cut markers over the waveform. */
  markers?: boolean;
  /** Hide the waveform entirely (for tools that only report numbers). */
  stage?: boolean;
  /** Accept video files too, for audio extraction. */
  video?: boolean;
  /** Format id preselected in the export bar. */
  defaultFormat?: string;
  /** Restrict the format list. Defaults to all formats. */
  formats?: string[];
  /** Called after decode. Wire up tool-specific controls here. */
  onReady?: (ctx: ToolContext, tool: ToolRuntime) => void;
  /** Produces the output. Runs when the user clicks the export button. */
  process: (ctx: ToolContext) => Promise<ProcessResult> | ProcessResult;
  /** Optional: renders the current settings into the result strip. */
  preview?: (ctx: ToolContext) => Promise<AudioBuffer> | AudioBuffer;
  /** Name on the result strip's row, e.g. "Equalised". Defaults to "Preview". */
  previewLabel?: string;
}

const $ = <T extends HTMLElement>(root: ParentNode, selector: string): T | null =>
  root.querySelector<T>(selector);

export class ToolRuntime {
  readonly root: HTMLElement;
  private config: ToolConfig;

  private files: File[] = [];
  private buffers: AudioBuffer[] = [];
  private waveform: Waveform | null = null;
  private player: Player | null = null;
  private selection: Selection = { start: 0, end: 0 };
  private markers: number[] = [];
  private controller: AbortController | null = null;
  private detachDrop: (() => void) | null = null;
  private lastOutput: { blob: Blob; name: string } | null = null;
  /** Last playhead position, so a zoom change can reposition it. */
  private playTime = 0;
  /** Suppresses selection and marker drags while a two-finger pinch is live. */
  private pinching = false;

  /** Pending removal of the error card, so a fast second failure can cancel it. */
  private alertTimer: number | null = null;

  // Cached elements — every tool page renders the same skeleton.
  private el: {
    drop: HTMLElement | null;
    input: HTMLInputElement | null;
    workspace: HTMLElement | null;
    status: HTMLElement | null;
    alert: HTMLElement | null;
    alertTitle: HTMLElement | null;
    alertFix: HTMLElement | null;
    alertClose: HTMLButtonElement | null;
    stage: HTMLElement | null;
    canvas: HTMLCanvasElement | null;
    canvasWrap: HTMLElement | null;
    ruler: HTMLCanvasElement | null;
    rulerTrack: HTMLElement | null;
    map: HTMLElement | null;
    minimap: HTMLCanvasElement | null;
    zoomLevel: HTMLElement | null;
    playhead: HTMLElement | null;
    handleStart: HTMLElement | null;
    handleEnd: HTMLElement | null;
    maskLeft: HTMLElement | null;
    maskRight: HTMLElement | null;
    markers: HTMLElement | null;
    play: HTMLButtonElement | null;
    loopBtn: HTMLButtonElement | null;
    time: HTMLElement | null;
    filename: HTMLElement | null;
    filemeta: HTMLElement | null;
    format: HTMLSelectElement | null;
    quality: HTMLSelectElement | null;
    qualityField: HTMLElement | null;
    size: HTMLElement | null;
    download: HTMLButtonElement | null;
    reset: HTMLButtonElement | null;
    addFiles: HTMLButtonElement | null;
    addInput: HTMLInputElement | null;
    chain: HTMLElement | null;
    results: HTMLElement | null;
    resultPanel: HTMLElement | null;
    runner: HTMLElement | null;
    runnerPhase: HTMLElement | null;
    runnerPct: HTMLElement | null;
    runnerTrack: HTMLElement | null;
    runnerBar: HTMLElement | null;
    runnerCancel: HTMLButtonElement | null;
  };

  /**
   * Output of the analyse step, waiting to be downloaded.
   *
   * Only used by tools that render a RunAction: those run the model on the first
   * press and save on the second, so the result has to survive in between. It is
   * cleared whenever anything that would change it changes — a new file, a
   * different setting — because offering a download of a result that no longer
   * matches the controls on screen is worse than asking for another run.
   */
  private analyzed: ProcessResult | null = null;

  constructor(root: HTMLElement, config: ToolConfig) {
    this.root = root;
    this.config = config;

    this.el = {
      drop: $(root, '[data-drop]'),
      input: $<HTMLInputElement>(root, '[data-file-input]'),
      workspace: $(root, '[data-workspace]'),
      status: $(root, '[data-status]'),
      alert: $(root, '[data-alert]'),
      alertTitle: $(root, '[data-alert-title]'),
      alertFix: $(root, '[data-alert-fix]'),
      alertClose: $<HTMLButtonElement>(root, '[data-alert-close]'),
      stage: $(root, '[data-stage]'),
      canvas: $<HTMLCanvasElement>(root, '[data-canvas]'),
      canvasWrap: $(root, '[data-canvas-wrap]'),
      ruler: $<HTMLCanvasElement>(root, '[data-ruler]'),
      rulerTrack: $(root, '[data-ruler-track]'),
      map: $(root, '[data-map]'),
      minimap: $<HTMLCanvasElement>(root, '[data-minimap]'),
      zoomLevel: $(root, '[data-zoom-fit]'),
      playhead: $(root, '[data-playhead]'),
      handleStart: $(root, '[data-handle="start"]'),
      handleEnd: $(root, '[data-handle="end"]'),
      maskLeft: $(root, '[data-mask="left"]'),
      maskRight: $(root, '[data-mask="right"]'),
      markers: $(root, '[data-markers]'),
      play: $<HTMLButtonElement>(root, '[data-play]'),
      loopBtn: $<HTMLButtonElement>(root, '[data-loop]'),
      time: $(root, '[data-time]'),
      filename: $(root, '[data-filename]'),
      filemeta: $(root, '[data-filemeta]'),
      format: $<HTMLSelectElement>(root, '[data-format]'),
      quality: $<HTMLSelectElement>(root, '[data-quality]'),
      qualityField: $(root, '[data-quality-field]'),
      size: $(root, '[data-size]'),
      download: $<HTMLButtonElement>(root, '[data-download]'),
      reset: $<HTMLButtonElement>(root, '[data-reset]'),
      addFiles: $<HTMLButtonElement>(root, '[data-add-files]'),
      addInput: $<HTMLInputElement>(root, '[data-add-input]'),
      chain: $(root, '[data-chain]'),
      results: $(root, '[data-results]'),
      resultPanel: $(root, '[data-stem-panel="result"]'),
      runner: $(root, '[data-runner]'),
      runnerPhase: $(root, '[data-runner-phase]'),
      runnerPct: $(root, '[data-runner-pct]'),
      runnerTrack: $(root, '[data-runner-track]'),
      runnerBar: $(root, '[data-runner-bar]'),
      runnerCancel: $<HTMLButtonElement>(root, '[data-runner-cancel]'),
    };

    this.init();
  }

  // ---------- lifecycle ----------

  private init(): void {
    const { drop, input } = this.el;
    if (drop && input) {
      input.accept = this.config.video ? MEDIA_ACCEPT : AUDIO_ACCEPT;
      input.multiple = Boolean(this.config.multiple);
      this.detachDrop = attachDropzone(drop, input, {
        multiple: Boolean(this.config.multiple),
        onFiles: (files) => void this.load(files),
      });
    }

    this.el.download?.addEventListener('click', () => void this.run());
    this.el.reset?.addEventListener('click', () => this.reset());

    // Add-files lives in the workspace header on multi-file tools, because the
    // drop zone it would otherwise use is hidden by then.
    if (this.el.addFiles && this.el.addInput) {
      const input = this.el.addInput;
      input.accept = this.config.video ? MEDIA_ACCEPT : AUDIO_ACCEPT;
      input.multiple = true;
      this.el.addFiles.addEventListener('click', () => input.click());
      input.addEventListener('change', () => {
        const chosen = Array.from(input.files ?? []);
        // Cleared so picking the same file twice in a row still fires a change.
        input.value = '';
        if (chosen.length > 0) void this.load(chosen, { append: true });
      });
    }

    this.el.alertClose?.addEventListener('click', () => this.hideAlert());
    this.el.format?.addEventListener('change', () => this.onFormatChange());
    this.el.quality?.addEventListener('change', () => this.updateSize());

    if (this.twoPhase()) {
      // Both the first button and the "Run again" one, which are the same action.
      this.root
        .querySelectorAll<HTMLButtonElement>('[data-analyze]')
        .forEach((button) => button.addEventListener('click', () => void this.analyze()));

      this.el.runnerCancel?.addEventListener('click', () => this.controller?.abort());

      /**
       * Any control the tool exposes invalidates a finished run.
       *
       * Ticking a different stem after a split has to send you back to the button,
       * not leave a Download sitting there that would quietly hand over the
       * previous selection. Listening on the root covers controls the page adds
       * later, which the AI pages all do.
       */
      this.root.addEventListener('change', (event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest('[data-control]')) this.invalidate();
      });
    }

    this.buildFormatOptions();
    this.setupTransport();
    this.setupKeyboard();
    this.setupMarkers();
    this.setupFloatingExport();

    // A file handed over by the previous tool loads with no upload step.
    const handed = claimHandoff();
    if (handed) void this.load([handed]);
  }

  private buildFormatOptions(): void {
    const select = this.el.format;
    if (!select) return;

    const allowed = this.config.formats
      ? FORMATS.filter((f) => this.config.formats?.includes(f.id))
      : FORMATS;

    select.innerHTML = '';
    for (const format of allowed) {
      const option = document.createElement('option');
      option.value = format.id;
      option.textContent = format.label;
      select.append(option);
    }

    const preferred = this.config.defaultFormat ?? allowed[0]?.id;
    if (preferred) select.value = preferred;
    this.onFormatChange();
  }

  private onFormatChange(): void {
    const select = this.el.format;
    const quality = this.el.quality;
    if (!select) return;

    let spec: FormatSpec;
    try {
      spec = formatById(select.value);
    } catch {
      return;
    }

    if (quality && this.el.qualityField) {
      if (spec.lossy) {
        const rates = bitratesFor(spec.id);
        const current = Number(quality.value);
        quality.innerHTML = '';
        for (const rate of rates) {
          const option = document.createElement('option');
          option.value = String(rate);
          option.textContent = `${rate} kbps`;
          quality.append(option);
        }
        quality.value = String(rates.includes(current) ? current : 192);
        this.el.qualityField.hidden = false;
      } else {
        this.el.qualityField.hidden = true;
      }
    }

    this.updateSize();
    // Converter pages render a live source-vs-output comparison, which has to
    // re-render whenever the target format or quality moves.
    this.root.dispatchEvent(
      new CustomEvent('formatchange', { detail: { format: spec.id } })
    );
  }

  /** The currently selected output format id. */
  getFormat(): string {
    return this.el.format?.value ?? this.config.defaultFormat ?? 'mp3';
  }

  /** The chosen bitrate in kbps. Meaningless for lossless formats. */
  getBitrate(): number {
    return this.bitrate();
  }

  /** The decoded source, or null before a file is loaded. */
  getBuffer(): AudioBuffer | null {
    return this.buffers[0] ?? null;
  }

  getFile(): File | null {
    return this.files[0] ?? null;
  }

  // ---------- intake ----------

  /**
   * Decodes files and opens the workspace on them.
   *
   * `append` keeps what is already loaded and adds to it, which is what the
   * multi-file tools need: the drop zone is gone once the workspace is open, so
   * without it the only way to add a fourth track to a join was to clear the
   * three already there and pick all four again.
   */
  async load(files: File[], { append = false }: { append?: boolean } = {}): Promise<void> {
    if (files.length === 0) return;

    this.controller?.abort();
    this.controller = new AbortController();
    const { signal } = this.controller;

    this.clearStatus();
    this.setBusy(true, 'Reading file');

    try {
      const decoded: AudioBuffer[] = [];
      for (let i = 0; i < files.length; i += 1) {
        const { buffer } = await decodeFile(files[i], {
          signal,
          onProgress: (ratio) => {
            const overall = (i + ratio) / files.length;
            this.showProgress(overall, `Reading ${files[i].name}`);
          },
        });
        decoded.push(buffer);
      }

      if (signal.aborted) return;

      this.files = append ? [...this.files, ...files] : files;
      this.buffers = append ? [...this.buffers, ...decoded] : decoded;
      // Appending must not move a selection the user has already made, and the
      // first buffer is still the one the stage is showing.
      if (!append) this.selection = { start: 0, end: decoded[0].duration };
      this.markers = append ? this.markers : [];
      this.lastOutput = null;

      this.setBusy(false);
      this.clearStatus();
      this.showWorkspace();
      // The stage shows the first buffer, which appending does not change —
      // remounting it would tear down the waveform and stop playback for a file
      // that is still the same file.
      if (!append) this.mountStage();
      this.updateFileMeta();
      this.updateSize();
      this.el.chain?.setAttribute('hidden', '');
      if (this.el.results) this.el.results.innerHTML = '';

      this.config.onReady?.(this.context(), this);
      this.refreshPreview();

      track('file_loaded', {
        files: files.length,
        length: durationBucket(decoded.reduce((sum, b) => sum + b.duration, 0)),
        channels: decoded[0].numberOfChannels,
        rate: decoded[0].sampleRate,
      });
    } catch (err) {
      this.setBusy(false);
      // The error is its own surface now, so it no longer overwrites the reading
      // bar on its way in — a file that failed must not leave one mid-progress.
      this.clearProgress();
      const audioErr = toAudioError(err);
      if (audioErr.code !== 'cancelled') this.showError(audioErr);
    }
  }

  private showWorkspace(): void {
    this.el.drop?.setAttribute('hidden', '');
    this.el.workspace?.removeAttribute('hidden');
    // A newly loaded file has not been analysed, so the run panel starts at the
    // button and the export bar starts disabled.
    if (this.twoPhase()) {
      this.analyzed = null;
      this.setRunner('idle');
    }
  }

  private updateFileMeta(): void {
    const file = this.files[0];
    const buffer = this.buffers[0];
    if (!file || !buffer) return;

    if (this.el.filename) {
      this.el.filename.textContent =
        this.files.length > 1 ? `${this.files.length} files` : file.name;
    }
    if (this.el.filemeta) {
      const total = this.buffers.reduce((sum, b) => sum + b.duration, 0);
      const parts = [
        fmtDuration(total),
        `${buffer.sampleRate / 1000} kHz`,
        buffer.numberOfChannels === 1 ? 'Mono' : 'Stereo',
        filesize(this.files.reduce((sum, f) => sum + f.size, 0)),
      ];
      this.el.filemeta.textContent = parts.join(' · ');
    }
  }

  // ---------- stage ----------

  private mountStage(): void {
    if (this.config.stage === false) return;
    const { canvas } = this.el;
    if (!canvas) return;

    if (!this.waveform) {
      this.waveform = new Waveform(canvas, {
        ruler: this.el.ruler,
        minimap: this.el.minimap,
        onViewChange: () => this.onViewChange(),
      });
      this.setupZoom();
    }
    this.waveform.setBuffer(this.buffers[0]);
    this.onViewChange();

    // Replay the draw-in animation on each new file.
    canvas.removeAttribute('data-enter');
    void canvas.offsetWidth;
    canvas.setAttribute('data-enter', 'true');

    if (!this.player) {
      this.player = new Player({
        time: (t) => this.renderPlayhead(t),
        play: () => this.setPlayButton(true),
        pause: () => this.setPlayButton(false),
        ended: () => this.setPlayButton(false),
      });
    }
    this.player.setBuffer(this.buffers[0]);

    if (this.config.selection) {
      this.setupSelection();
      this.player.setRegion(this.selection);
    }
    this.renderSelection();
    this.renderPlayhead(0);
  }

  private setupTransport(): void {
    this.el.play?.addEventListener('click', () => {
      this.player?.toggle();
    });

    this.el.loopBtn?.addEventListener('click', () => {
      const btn = this.el.loopBtn;
      if (!btn || !this.player) return;
      const next = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', String(next));
      this.player.setLoop(next);
    });

    this.root.querySelector('[data-skip-start]')?.addEventListener('click', () => {
      this.player?.seek(this.config.selection ? this.selection.start : 0);
    });

    this.root.querySelector('[data-skip-end]')?.addEventListener('click', () => {
      const end = this.config.selection ? this.selection.end : this.buffers[0]?.duration ?? 0;
      this.player?.seek(Math.max(0, end - 0.05));
    });

    // Click the waveform to seek.
    this.el.canvasWrap?.addEventListener('pointerdown', (event) => {
      if ((event.target as HTMLElement).closest('[data-handle]')) return;
      if (this.config.selection) return; // selection drag owns this gesture
      if (!this.waveform) return;
      this.player?.seek(this.waveform.timeAt(event.clientX));
    });
  }

  /**
   * On narrow screens the export row follows you down the page, but only once
   * the waveform has scrolled out of sight. Pinning it unconditionally put it
   * over the transport while both were on screen, which swapped a scroll for a
   * covered play button.
   */
  private setupFloatingExport(): void {
    const bar = this.root.querySelector<HTMLElement>('.export');
    const anchor = this.el.stage ?? this.el.drop;
    if (!bar || !anchor || typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        bar.dataset.float = String(!entries[0].isIntersecting);
      },
      { threshold: 0 }
    );
    observer.observe(anchor);
  }

  // ---------- zoom ----------

  /**
   * Zoom and pan.
   *
   * Each surface owns exactly one gesture, which is the only way a canvas with
   * this many overlapping affordances stays predictable:
   *
   * - the waveform draws selections and drops cut markers,
   * - the ruler seeks (the trimmer has no other way to move the playhead,
   *   because clicking the waveform there starts a selection),
   * - the overview strip pans,
   * - modifier-scroll and pinch zoom, plain scroll still belongs to the page.
   */
  private setupZoom(): void {
    const wave = this.waveform;
    const wrap = this.el.canvasWrap;
    if (!wave) return;

    const zoomStep = 1.8;

    this.root.querySelector('[data-zoom-in]')?.addEventListener('click', () => {
      wave.zoomBy(zoomStep, wave.anchorFor(this.playTime));
    });
    this.root.querySelector('[data-zoom-out]')?.addEventListener('click', () => {
      wave.zoomBy(1 / zoomStep, wave.anchorFor(this.playTime));
    });
    this.root.querySelector('[data-zoom-fit]')?.addEventListener('click', () => {
      wave.zoomToFit();
    });
    this.root
      .querySelector('[data-zoom-selection]')
      ?.addEventListener('click', () => wave.zoomToRegion(this.selection));

    // Scroll. Modifier-scroll zooms at the pointer; a trackpad pinch arrives as
    // ctrl+wheel, so the same branch covers both. Horizontal intent pans. Plain
    // vertical scroll is left alone: hijacking the page scroll over a tall
    // element is the single most hostile thing an editor can do.
    wrap?.addEventListener(
      'wheel',
      (event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) {
          event.preventDefault();
          const factor = Math.exp(-event.deltaY * 0.0022);
          wave.zoomBy(factor, wave.timeAt(event.clientX));
          return;
        }
        const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
        if (!horizontal && !event.shiftKey) return;
        if (wave.isFullyZoomedOut()) return;
        event.preventDefault();
        const delta = horizontal ? event.deltaX : event.deltaY;
        wave.panBy(delta * wave.secondsPerPixel());
      },
      { passive: false }
    );

    // Pinch. Tracked through touch events rather than pointer events so the
    // one-finger selection drag above keeps working untouched; it just steps
    // aside while `pinching` is set.
    let pinchSpan = 0;
    let pinchAnchor = 0;
    const distance = (touches: TouchList): number =>
      Math.abs(touches[0].clientX - touches[1].clientX);

    wrap?.addEventListener('touchstart', (event) => {
      if (event.touches.length !== 2) return;
      this.pinching = true;
      pinchSpan = Math.max(1, distance(event.touches));
      pinchAnchor = wave.timeAt(
        (event.touches[0].clientX + event.touches[1].clientX) / 2
      );
    });

    wrap?.addEventListener(
      'touchmove',
      (event) => {
        if (!this.pinching || event.touches.length !== 2) return;
        event.preventDefault();
        const now = Math.max(1, distance(event.touches));
        wave.zoomBy(now / pinchSpan, pinchAnchor);
        pinchSpan = now;
      },
      { passive: false }
    );

    const endPinch = (event: TouchEvent): void => {
      if (event.touches.length < 2) this.pinching = false;
    };
    wrap?.addEventListener('touchend', endPinch);
    wrap?.addEventListener('touchcancel', endPinch);

    this.setupRuler();
    this.setupMinimap();
    this.setupZoomKeys();
  }

  /** Click or drag the ruler to move the playhead. */
  private setupRuler(): void {
    const track = this.el.rulerTrack;
    if (!track) return;

    track.addEventListener('pointerdown', (event) => {
      if (!this.waveform || this.buffers.length === 0) return;
      event.preventDefault();
      track.setPointerCapture(event.pointerId);
      track.dataset.grabbed = 'true';

      const seek = (clientX: number): void => {
        this.player?.seek(this.waveform!.timeAt(clientX));
      };
      seek(event.clientX);

      const move = (moveEvent: PointerEvent): void => seek(moveEvent.clientX);
      const up = (): void => {
        delete track.dataset.grabbed;
        track.removeEventListener('pointermove', move);
        track.removeEventListener('pointerup', up);
        track.removeEventListener('pointercancel', up);
      };

      track.addEventListener('pointermove', move);
      track.addEventListener('pointerup', up);
      track.addEventListener('pointercancel', up);
    });
  }

  /** Drag anywhere on the overview to bring that part of the file into view. */
  private setupMinimap(): void {
    const map = this.el.minimap;
    if (!map) return;

    map.addEventListener('pointerdown', (event) => {
      const wave = this.waveform;
      if (!wave || this.buffers.length === 0) return;
      event.preventDefault();
      map.setPointerCapture(event.pointerId);
      map.dataset.grabbed = 'true';

      const go = (clientX: number): void => wave.centreOn(wave.minimapTimeAt(clientX));
      go(event.clientX);

      const move = (moveEvent: PointerEvent): void => go(moveEvent.clientX);
      const up = (): void => {
        delete map.dataset.grabbed;
        map.removeEventListener('pointermove', move);
        map.removeEventListener('pointerup', up);
        map.removeEventListener('pointercancel', up);
      };

      map.addEventListener('pointermove', move);
      map.addEventListener('pointerup', up);
      map.addEventListener('pointercancel', up);
    });
  }

  private setupZoomKeys(): void {
    this.root.addEventListener('keydown', (event) => {
      const wave = this.waveform;
      if (!wave || this.buffers.length === 0) return;
      // Never hijack typing, and never fight a handle that has already acted.
      const target = event.target as HTMLElement;
      if (target.matches('input, select, textarea')) return;
      if (event.defaultPrevented) return;

      const page = wave.span * 0.25;

      switch (event.key) {
        case '+':
        case '=':
          wave.zoomBy(1.8, wave.anchorFor(this.playTime));
          break;
        case '-':
        case '_':
          wave.zoomBy(1 / 1.8, wave.anchorFor(this.playTime));
          break;
        case '0':
          wave.zoomToFit();
          break;
        case 's':
        case 'S':
          if (!this.config.selection) return;
          wave.zoomToRegion(this.selection);
          break;
        case 'ArrowLeft':
          if (wave.isFullyZoomedOut()) return;
          wave.panBy(-page);
          break;
        case 'ArrowRight':
          if (wave.isFullyZoomedOut()) return;
          wave.panBy(page);
          break;
        default:
          return;
      }

      event.preventDefault();
    });
  }

  /**
   * Everything positioned in percentages has to move when the viewport does:
   * the handles, the cut markers, the dimming masks and the playhead.
   */
  private onViewChange(): void {
    const wave = this.waveform;
    if (!wave) return;

    const label = this.el.zoomLevel;
    if (label) {
      const level = wave.zoomLevel();
      // One decimal only when it says something: "1.0x" is noise, "2.4x" is not.
      const shown =
        level < 9.95 ? String(Math.round(level * 10) / 10) : String(Math.round(level));
      label.textContent = `${shown}×`;
      label.dataset.zoomed = String(!wave.isFullyZoomedOut());
    }

    const map = this.el.map;
    if (map) map.hidden = wave.isFullyZoomedOut();

    this.root.querySelector('[data-zoom-in]')?.toggleAttribute(
      'disabled',
      wave.isFullyZoomedIn()
    );
    this.root.querySelector('[data-zoom-out]')?.toggleAttribute(
      'disabled',
      wave.isFullyZoomedOut()
    );

    this.renderSelection();
    this.placeMarkers();
    this.renderPlayhead(this.playTime, false);
  }

  private setPlayButton(playing: boolean): void {
    const btn = this.el.play;
    if (!btn) return;
    btn.setAttribute('aria-pressed', String(playing));
    btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    const play = btn.querySelector<HTMLElement>('[data-icon-play]');
    const pause = btn.querySelector<HTMLElement>('[data-icon-pause]');
    if (play) play.style.display = playing ? 'none' : '';
    if (pause) pause.style.display = playing ? '' : 'none';
  }

  private renderPlayhead(seconds: number, follow = true): void {
    const { playhead, time } = this.el;
    const buffer = this.buffers[0];
    this.playTime = seconds;

    // Zoomed in, the playhead runs off the edge within a second or two. Paging
    // the view to keep up is the difference between zoom being usable during
    // playback and being something you have to undo first.
    if (follow) this.waveform?.followPlayhead(seconds);

    if (playhead && this.waveform && buffer) {
      const pct = this.waveform.positionOf(seconds);
      const visible = pct >= 0 && pct <= 100;
      playhead.dataset.visible = String(visible);
      if (visible) playhead.style.left = `${pct}%`;
    }
    if (time) {
      const total = buffer?.duration ?? 0;
      time.innerHTML = `${timecode(seconds)} <span>/ ${timecode(total)}</span>`;
    }
  }

  // ---------- selection ----------

  private setupSelection(): void {
    const { handleStart, handleEnd, canvasWrap } = this.el;
    if (!canvasWrap) return;

    handleStart?.removeAttribute('hidden');
    handleEnd?.removeAttribute('hidden');

    const drag = (handle: HTMLElement, edge: 'start' | 'end'): void => {
      handle.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        handle.setPointerCapture(event.pointerId);
        handle.dataset.grabbed = 'true';

        const move = (moveEvent: PointerEvent): void => {
          if (!this.waveform) return;
          this.moveEdge(edge, this.waveform.timeAt(moveEvent.clientX));
        };

        const up = (): void => {
          handle.dataset.grabbed = 'false';
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
        };

        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });

      // Keyboard: arrows nudge, shift jumps. Selection must be operable
      // without a pointer.
      handle.addEventListener('keydown', (event) => {
        const step = event.shiftKey ? 1 : 0.05;
        let delta = 0;
        if (event.key === 'ArrowLeft') delta = -step;
        else if (event.key === 'ArrowRight') delta = step;
        else if (event.key === 'Home') delta = -Infinity;
        else if (event.key === 'End') delta = Infinity;
        else return;

        event.preventDefault();
        const current = edge === 'start' ? this.selection.start : this.selection.end;
        this.moveEdge(edge, current + delta);
      });
    };

    if (handleStart) drag(handleStart, 'start');
    if (handleEnd) drag(handleEnd, 'end');

    // Drag on empty canvas draws a fresh selection.
    canvasWrap.addEventListener('pointerdown', (event) => {
      if ((event.target as HTMLElement).closest('[data-handle]')) return;
      if (this.pinching || !event.isPrimary) return;
      if (!this.waveform) return;
      event.preventDefault();
      canvasWrap.setPointerCapture(event.pointerId);

      const anchor = this.waveform.timeAt(event.clientX);
      this.setSelection({ start: anchor, end: anchor });

      const move = (moveEvent: PointerEvent): void => {
        if (!this.waveform) return;
        const now = this.waveform.timeAt(moveEvent.clientX);
        this.setSelection({
          start: Math.min(anchor, now),
          end: Math.max(anchor, now),
        });
      };

      const up = (): void => {
        canvasWrap.removeEventListener('pointermove', move);
        canvasWrap.removeEventListener('pointerup', up);
        canvasWrap.removeEventListener('pointercancel', up);
        // A click without a drag means "select everything", not "select nothing".
        if (this.selection.end - this.selection.start < 0.02) {
          this.setSelection({ start: 0, end: this.buffers[0]?.duration ?? 0 });
        }
      };

      canvasWrap.addEventListener('pointermove', move);
      canvasWrap.addEventListener('pointerup', up);
      canvasWrap.addEventListener('pointercancel', up);
    });
  }

  private moveEdge(edge: 'start' | 'end', value: number): void {
    const total = this.buffers[0]?.duration ?? 0;
    const clamped = Math.min(total, Math.max(0, value));
    // Keep at least 10ms so a selection can never become a zero-length export.
    if (edge === 'start') {
      this.setSelection({
        start: Math.min(clamped, this.selection.end - 0.01),
        end: this.selection.end,
      });
    } else {
      this.setSelection({
        start: this.selection.start,
        end: Math.max(clamped, this.selection.start + 0.01),
      });
    }
  }

  setSelection(next: Selection): void {
    const total = this.buffers[0]?.duration ?? 0;
    this.selection = {
      start: Math.max(0, Math.min(next.start, total)),
      end: Math.max(0, Math.min(next.end, total)),
    };
    this.renderSelection();
    this.player?.setRegion(this.selection);
    this.updateSize();
    this.root.dispatchEvent(
      new CustomEvent('selectionchange', { detail: this.selection })
    );
  }

  getSelection(): Selection {
    return { ...this.selection };
  }

  // ---------- markers ----------

  /**
   * Draggable cut points over the waveform, in seconds.
   *
   * A splitter that only takes a part count is a calculator, not an editor —
   * you cannot put a boundary between two songs or after an intro. Markers make
   * the waveform the control surface: the settings seed them, and dragging one
   * or clicking a new one takes over from there.
   */
  setMarkers(times: number[], options: { silent?: boolean } = {}): void {
    const total = this.buffers[0]?.duration ?? 0;
    // Snap out interior duplicates and anything sitting on the two ends: those
    // are implied by the file itself and would export a zero-length part.
    const cleaned = [...new Set(times.map((t) => Math.round(t * 1000) / 1000))]
      .filter((t) => t > 0.05 && t < total - 0.05)
      .sort((a, b) => a - b);

    this.markers = cleaned;
    this.waveform?.setMarkers(cleaned);
    this.renderMarkers();

    if (!options.silent) {
      this.root.dispatchEvent(
        new CustomEvent('markerschange', { detail: [...cleaned] })
      );
    }
  }

  getMarkers(): number[] {
    return [...this.markers];
  }

  /** Calls out spans on the waveform that the tool is about to act on. */
  setHighlights(regions: { start: number; end: number }[]): void {
    this.waveform?.setHighlights(regions);
  }

  /** Beat grid over the waveform. Null clears it. */
  setGrid(grid: { period: number; offset: number; accent: number } | null): void {
    this.waveform?.setGrid(grid);
  }

  /** Segment boundaries including the file's own start and end. */
  getSegments(): { start: number; end: number }[] {
    const total = this.buffers[0]?.duration ?? 0;
    const edges = [0, ...this.markers, total];
    const out: { start: number; end: number }[] = [];
    for (let i = 0; i < edges.length - 1; i += 1) {
      if (edges[i + 1] - edges[i] > 0.01) {
        out.push({ start: edges[i], end: edges[i + 1] });
      }
    }
    return out;
  }

  /**
   * Moves the existing marker handles to match the viewport.
   *
   * Separate from `renderMarkers` on purpose: panning fires on every frame of a
   * drag, and rebuilding the DOM at 60fps would drop the handle out from under
   * the pointer and reset focus.
   */
  private placeMarkers(): void {
    const layer = this.el.markers;
    const wave = this.waveform;
    if (!layer || !wave) return;

    layer.querySelectorAll<HTMLElement>('.stage__marker').forEach((handle) => {
      const time = this.markers[Number(handle.dataset.index)];
      if (time === undefined) return;
      const pct = wave.positionOf(time);
      handle.style.left = `${pct}%`;
      handle.dataset.offscreen = String(pct < 0 || pct > 100);
    });
  }

  private renderMarkers(): void {
    const layer = this.el.markers;
    if (!layer || !this.waveform) return;

    layer.innerHTML = '';

    this.markers.forEach((time, index) => {
      const handle = document.createElement('div');
      handle.className = 'stage__marker';
      const pct = this.waveform?.positionOf(time) ?? 0;
      handle.style.left = `${pct}%`;
      handle.dataset.offscreen = String(pct < 0 || pct > 100);
      handle.tabIndex = 0;
      handle.setAttribute('role', 'slider');
      handle.setAttribute('aria-label', `Cut point ${index + 1}`);
      handle.setAttribute('aria-valuenow', time.toFixed(2));
      handle.dataset.index = String(index);

      const tip = document.createElement('span');
      tip.className = 'stage__marker-tip';
      tip.textContent = timecode(time);
      handle.append(tip);

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'stage__marker-x';
      remove.setAttribute('aria-label', `Remove cut point ${index + 1}`);
      remove.textContent = '×';
      handle.append(remove);

      layer.append(handle);
    });
  }

  /** Pointer, keyboard and click-to-add behaviour for the marker layer. */
  private setupMarkers(): void {
    const layer = this.el.markers;
    const wrap = this.el.canvasWrap;
    if (!layer || !wrap) return;

    layer.addEventListener('pointerdown', (event) => {
      const target = event.target as HTMLElement;

      if (target.classList.contains('stage__marker-x')) {
        const index = Number(target.parentElement?.dataset.index);
        if (Number.isFinite(index)) {
          const next = this.getMarkers();
          next.splice(index, 1);
          this.setMarkers(next);
        }
        event.stopPropagation();
        return;
      }

      const handle = target.closest<HTMLElement>('.stage__marker');
      if (!handle) return;
      if (this.pinching || !event.isPrimary) return;

      event.preventDefault();
      event.stopPropagation();
      const index = Number(handle.dataset.index);
      handle.setPointerCapture(event.pointerId);
      handle.dataset.grabbed = 'true';

      const move = (moveEvent: PointerEvent): void => {
        if (!this.waveform) return;
        const next = this.getMarkers();
        next[index] = this.waveform.timeAt(moveEvent.clientX);
        // Re-sorting mid-drag would swap the handle out from under the pointer,
        // so the visual updates now and the sort lands on release.
        this.markers = next;
        this.waveform.setMarkers(next);
        handle.style.left = `${this.waveform.positionOf(next[index])}%`;
        const tip = handle.querySelector('.stage__marker-tip');
        if (tip) tip.textContent = timecode(next[index]);
      };

      const up = (): void => {
        handle.dataset.grabbed = 'false';
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        this.setMarkers(this.getMarkers());
      };

      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });

    layer.addEventListener('keydown', (event) => {
      const handle = (event.target as HTMLElement).closest<HTMLElement>(
        '.stage__marker'
      );
      if (!handle) return;
      const index = Number(handle.dataset.index);
      const step = event.shiftKey ? 1 : 0.05;

      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        const next = this.getMarkers();
        next.splice(index, 1);
        this.setMarkers(next);
        return;
      }

      let delta = 0;
      if (event.key === 'ArrowLeft') delta = -step;
      else if (event.key === 'ArrowRight') delta = step;
      else return;

      event.preventDefault();
      const next = this.getMarkers();
      next[index] += delta;
      this.setMarkers(next);
      // Keep focus on the marker the user is nudging, even if it re-sorted.
      const moved = this.getMarkers().indexOf(
        Math.round(next[index] * 1000) / 1000
      );
      const layerEl = this.el.markers;
      if (moved >= 0 && layerEl) {
        layerEl.querySelectorAll<HTMLElement>('.stage__marker')[moved]?.focus();
      }
    });

    // Clicking empty waveform adds a cut there — the whole point of making the
    // waveform the control surface.
    wrap.addEventListener('dblclick', (event) => {
      if (!this.config.markers || !this.waveform) return;
      if ((event.target as HTMLElement).closest('.stage__marker')) return;
      this.setMarkers([...this.getMarkers(), this.waveform.timeAt(event.clientX)]);
    });
  }

  private renderSelection(): void {
    if (!this.config.selection || !this.waveform) return;
    const { handleStart, handleEnd, maskLeft, maskRight } = this.el;

    const startPct = this.waveform.positionOf(this.selection.start);
    const endPct = this.waveform.positionOf(this.selection.end);
    const clamp = (value: number): number => Math.min(100, Math.max(0, value));

    // A handle scrolled out of the viewport is hidden rather than pinned to the
    // edge: a handle sitting at 0% that does not correspond to the selection
    // start would be a lie you could then drag.
    if (handleStart) {
      handleStart.style.left = `${startPct}%`;
      handleStart.dataset.offscreen = String(startPct < 0 || startPct > 100);
      handleStart.setAttribute('aria-valuenow', this.selection.start.toFixed(2));
      const tip = handleStart.querySelector('[data-tip]');
      if (tip) tip.textContent = timecode(this.selection.start);
    }
    if (handleEnd) {
      handleEnd.style.left = `${endPct}%`;
      handleEnd.dataset.offscreen = String(endPct < 0 || endPct > 100);
      handleEnd.setAttribute('aria-valuenow', this.selection.end.toFixed(2));
      const tip = handleEnd.querySelector('[data-tip]');
      if (tip) tip.textContent = timecode(this.selection.end);
    }
    if (maskLeft) {
      maskLeft.style.left = '0';
      maskLeft.style.width = `${clamp(startPct)}%`;
    }
    if (maskRight) {
      maskRight.style.left = `${clamp(endPct)}%`;
      maskRight.style.width = `${100 - clamp(endPct)}%`;
    }

    this.waveform.setRegion(this.selection);
  }

  // ---------- keyboard ----------

  private setupKeyboard(): void {
    this.root.addEventListener('keydown', (event) => {
      const target = event.target as HTMLElement;
      // Never hijack typing.
      if (target.matches('input, select, textarea')) return;
      if (event.key === ' ') {
        event.preventDefault();
        this.player?.toggle();
      }
    });
  }

  // ---------- result strip ----------

  /**
   * Mounts a result as its own player under the controls.
   *
   * The main transport always plays the source — swapping its buffer for a
   * preview looked like the file itself had changed, and made comparing the two
   * a memory exercise. The strip is the same player the splitter uses, cut down
   * to one listen-only row, so original and result sit one above the other and
   * either can be played at will.
   */
  showResult(buffer: AudioBuffer, name: string): void {
    if (!this.el.resultPanel) return;
    mountStemPanel(this.el.resultPanel, [{ id: 'result', name, buffer }], {
      baseName: baseName(this.files[0]?.name ?? 'result'),
      chrome: 'listen',
      onError: (message) => this.showNote(message, 'warn'),
    });
  }

  /** Unmounts the strip, for when the result no longer matches the controls. */
  hideResult(): void {
    if (!this.el.resultPanel) return;
    mountStemPanel(this.el.resultPanel, [], {
      baseName: 'result',
      chrome: 'listen',
    });
  }

  /** Re-renders the result strip when controls change. */
  refreshPreview(): void {
    if (!this.config.preview || this.buffers.length === 0) return;
    void Promise.resolve(this.config.preview(this.context()))
      .then((buffer) => {
        this.showResult(buffer, this.config.previewLabel ?? 'Preview');
      })
      .catch(() => {
        /* Preview is a convenience; export remains the source of truth. */
      });
  }

  // ---------- export ----------

  private context(): ToolContext {
    return {
      buffer: this.buffers[0],
      buffers: this.buffers,
      files: this.files,
      selection: this.getSelection(),
      // The label is optional so the forty non-AI tools keep calling this with a
      // bare ratio, but the AI ones can say which stem is running.
      progress: (ratio, label) => this.showProgress(ratio, label ?? 'Processing'),
      signal: this.controller?.signal ?? new AbortController().signal,
    };
  }

  /** Values of any control inside the tool, keyed by its data-control name. */
  values(): Record<string, string> {
    const out: Record<string, string> = {};
    this.root.querySelectorAll<HTMLInputElement>('[data-control]').forEach((el) => {
      const key = el.dataset.control;
      if (!key) return;
      out[key] = el.type === 'checkbox' ? String(el.checked) : el.value;
    });
    return out;
  }

  value(name: string, fallback = 0): number {
    const raw = this.values()[name];
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  flag(name: string): boolean {
    return this.values()[name] === 'true';
  }

  text(name: string, fallback = ''): string {
    return this.values()[name] ?? fallback;
  }

  /**
   * WAV bit depth comes from a page control rather than the shared export bar,
   * because it only applies to two of the forty tools. A page opts in by
   * rendering `data-control="bitdepth"`; everything else gets the default.
   */
  private bitDepth(): 16 | 24 | 32 {
    const raw = Number(this.values().bitdepth);
    return raw === 24 || raw === 32 ? raw : 16;
  }

  private bitrate(): number {
    return Number(this.el.quality?.value) || 192;
  }

  private updateSize(): void {
    const { size, format, quality } = this.el;
    if (!size || !format || this.buffers.length === 0) return;

    try {
      // Estimating from the selection keeps the number honest for trimmers.
      const seconds = this.config.selection
        ? Math.max(0.01, this.selection.end - this.selection.start)
        : this.buffers.reduce((sum, b) => sum + b.duration, 0);

      const reference = this.buffers[0];
      const proxy = {
        duration: seconds,
        length: Math.round(seconds * reference.sampleRate),
        numberOfChannels: reference.numberOfChannels,
        sampleRate: reference.sampleRate,
      } as AudioBuffer;

      const bytes = estimateSize(proxy, format.value, {
        bitrate: this.bitrate(),
        bitDepth: this.bitDepth(),
      });
      size.textContent = `about ${filesize(bytes)}`;
    } catch {
      size.textContent = '';
    }
  }

  /** True when the page renders a RunAction, i.e. model first, download second. */
  private twoPhase(): boolean {
    return this.el.runner !== null;
  }

  /**
   * Whether the export bar depends on this having run.
   *
   * True for the AI tools, where the model output is the file. False in preview
   * mode, where downloading renders on its own and this button only produces
   * something to hear first — disabling Download there would be a lie.
   */
  private gates(): boolean {
    return this.el.runner?.dataset.mode !== 'preview';
  }

  private setRunner(state: 'idle' | 'stale' | 'busy' | 'done'): void {
    this.el.runner?.setAttribute('data-state', state);
    if (this.gates() && this.el.download) {
      this.el.download.disabled = state !== 'done';
    }
  }

  /** Throws away a finished run, sending the user back to the button. */
  private invalidate(): void {
    if (!this.twoPhase() || this.analyzed === null) return;
    this.analyzed = null;
    // 'stale' rather than 'idle': there was a result a moment ago, and saying so
    // is the difference between a control that looks broken and one that tells
    // you it needs pressing again.
    this.setRunner('stale');
    // The result player goes too: keeping stale audio playable while the
    // controls describe a different result is the same lie as keeping its
    // download button enabled.
    this.hideResult();
  }

  /**
   * First press: run the model, keep the result, save nothing.
   *
   * Deliberately does not touch the export bar beyond enabling it. The point of
   * splitting the two presses is that this one can be watched, cancelled and
   * repeated with different settings without a file landing in the downloads
   * folder every time.
   */
  async analyze(): Promise<void> {
    if (this.buffers.length === 0) return;

    this.controller?.abort();
    this.controller = new AbortController();

    this.analyzed = null;
    this.setRunner('busy');
    this.runnerProgress(null, 'Starting');
    this.clearStatus();

    try {
      const result = await this.config.process(this.context());
      this.analyzed = result;

      /**
       * In preview mode this button's whole job is producing something to hear,
       * so mounting it is not the page's business. The gated tools opt out
       * because they render their own surface — the splitter's mixer would
       * otherwise be shadowed by a second, redundant strip.
       */
      if (!this.gates()) {
        const playable =
          result instanceof AudioBuffer
            ? result
            : result && typeof result === 'object' && 'buffer' in result
              ? ((result as { buffer?: AudioBuffer }).buffer ?? null)
              : null;
        if (playable) this.showResult(playable, this.config.previewLabel ?? 'Preview');
      }

      this.setRunner('done');
    } catch (err) {
      const audioErr = toAudioError(err);
      // Back to idle either way: a cancelled or failed run leaves nothing to
      // download, and the button that starts it again is the honest next step.
      this.setRunner('idle');
      if (audioErr.code !== 'cancelled') this.showError(audioErr);
    }
  }

  async run(): Promise<void> {
    if (this.buffers.length === 0) return;

    const button = this.el.download;

    // Deliver what the run panel already produced, when there is something. This
    // press says Download, so it saves what is on screen and never quietly
    // re-runs a four-minute model. In preview mode nothing may have been run at
    // all, and that falls through to a fresh render below — the download has to
    // work whether or not anyone pressed Preview.
    if (this.twoPhase() && this.analyzed !== null) {
      this.controller?.abort();
      this.controller = new AbortController();
      if (button) button.dataset.loading = 'true';
      try {
        if (Array.isArray(this.analyzed)) await this.deliverMany(this.analyzed);
        else await this.deliverOne(this.analyzed);
      } catch (err) {
        const audioErr = toAudioError(err);
        if (audioErr.code !== 'cancelled') this.showError(audioErr);
      } finally {
        if (button) delete button.dataset.loading;
        this.clearProgress();
      }
      return;
    }

    this.controller?.abort();
    this.controller = new AbortController();

    if (button) button.dataset.loading = 'true';
    this.clearStatus();

    try {
      const ctx = this.context();
      const result = await this.config.process(ctx);

      if (Array.isArray(result)) {
        await this.deliverMany(result);
      } else {
        await this.deliverOne(result);
      }
    } catch (err) {
      const audioErr = toAudioError(err);
      if (audioErr.code !== 'cancelled') this.showError(audioErr);
    } finally {
      if (button) delete button.dataset.loading;
      this.clearProgress();
    }
  }

  private async deliverOne(result: ProcessResult): Promise<void> {
    const formatId = this.el.format?.value ?? this.config.defaultFormat ?? 'mp3';
    const spec = formatById(formatId);

    let blob: Blob;
    let suffix = this.config.suffix;
    /**
     * Extension for an already-encoded result.
     *
     * A Blob coming back from process() has nothing to do with the audio format
     * picker — it is finished output that chose its own type. Taking the
     * extension from the export bar named a subtitle file `.mp3`, because a page
     * with no export bar falls through to the 'mp3' default. The blob's own MIME
     * type is the only thing that knows what it actually is.
     */
    let extension = spec.extension;

    if (result instanceof Blob) {
      blob = result;
      const known: Record<string, string> = {
        'text/plain': 'txt',
        'text/vtt': 'vtt',
        'application/x-subrip': 'srt',
        'application/json': 'json',
      };
      const mime = result.type.split(';')[0]?.trim() ?? '';
      extension = known[mime] ?? (mime.startsWith('audio/') ? spec.extension : 'txt');
    } else {
      const buffer =
        'buffer' in (result as { buffer: AudioBuffer })
          ? (result as { buffer: AudioBuffer; suffix?: string }).buffer
          : (result as AudioBuffer);
      if ('suffix' in (result as { suffix?: string })) {
        suffix = (result as { suffix?: string }).suffix ?? suffix;
      }

      blob = await exportAudio(buffer, formatId, {
        bitrate: this.bitrate(),
        bitDepth: this.bitDepth(),
        signal: this.controller?.signal,
        onProgress: (r) => this.showProgress(r, 'Encoding'),
        onEngineLoad: (r) =>
          this.showProgress(r, 'Loading the converter (one time, ~10 MB)'),
      });
    }

    const name = outputName(this.files[0]?.name ?? 'audio', suffix, extension);
    saveBlob(blob, name);
    this.lastOutput = { blob, name };
    this.markReady();
    this.showChain();

    track('export_done', { format: spec.id, bitrate: this.bitrate() });
  }

  private async deliverMany(outputs: NamedOutput[]): Promise<void> {
    const formatId = this.el.format?.value ?? 'mp3';
    const spec = formatById(formatId);
    const list = this.el.results;
    if (list) list.innerHTML = '';

    for (let i = 0; i < outputs.length; i += 1) {
      const item = outputs[i];
      this.showProgress(i / outputs.length, `Encoding ${i + 1} of ${outputs.length}`);

      const blob =
        item.blob ??
        (item.buffer
          ? await exportAudio(item.buffer, formatId, {
              bitrate: this.bitrate(),
              bitDepth: this.bitDepth(),
              signal: this.controller?.signal,
            })
          : null);
      if (!blob) continue;

      const name = item.name.includes('.') ? item.name : `${item.name}.${spec.extension}`;
      if (list) list.append(this.resultRow(name, blob));
    }

    this.clearProgress();
    this.markReady();

    track('export_done', { format: spec.id, parts: outputs.length });
  }

  private resultRow(name: string, blob: Blob): HTMLElement {
    const row = document.createElement('div');
    row.className = 'result';

    const label = document.createElement('span');
    label.className = 'result__name';
    label.textContent = name;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--quiet btn--sm';
    button.textContent = filesize(blob.size);
    button.addEventListener('click', () => saveBlob(blob, name));

    row.append(label, button);
    return row;
  }

  private markReady(): void {
    const button = this.el.download;
    if (!button) return;
    button.classList.remove('btn--ready');
    void button.offsetWidth;
    button.classList.add('btn--ready');
  }

  private showChain(): void {
    const chain = this.el.chain;
    if (!chain || !this.lastOutput) return;
    chain.removeAttribute('hidden');
    chain.querySelectorAll<HTMLAnchorElement>('[data-chain-link]').forEach((link) => {
      link.onclick = () => {
        if (this.lastOutput) {
          stashForNextTool(this.lastOutput.blob, this.lastOutput.name);
        }
      };
    });
  }

  // ---------- status ----------

  private setBusy(busy: boolean, label?: string): void {
    this.root.setAttribute('aria-busy', String(busy));
    if (busy && label) this.showProgress(0, label);
  }

  /**
   * Progress inside the run panel, where the button that started it is.
   *
   * A null ratio means the phase genuinely cannot report one — fetching a model
   * of unknown length, building an ONNX session — and the bar animates instead of
   * sitting at 0%, which reads as stuck.
   */
  private runnerProgress(ratio: number | null, label: string): void {
    const { runnerPhase, runnerPct, runnerBar, runnerTrack } = this.el;
    const known = ratio !== null && Number.isFinite(ratio);
    const clamped = known ? Math.min(1, Math.max(0, ratio)) : 0;

    if (runnerPhase) runnerPhase.textContent = label;
    runnerTrack?.setAttribute('data-indeterminate', String(!known));
    if (runnerPct) runnerPct.textContent = known ? `${Math.round(clamped * 100)}%` : '';
    if (runnerBar && known) runnerBar.style.width = `${clamped * 100}%`;
  }

  private showProgress(ratio: number, label: string): void {
    // While the run panel is working, that is where progress belongs. The bar by
    // the dropzone is for reading files, which happens before there is a
    // workspace to put anything in.
    if (this.twoPhase() && this.el.runner?.dataset.state === 'busy') {
      this.runnerProgress(ratio, label);
      return;
    }

    const status = this.el.status;
    if (!status) return;

    let bar = status.querySelector<HTMLElement>('.progress');
    if (!bar) {
      status.innerHTML = `
        <div class="progress" role="status" aria-live="polite">
          <div class="progress__meta"><span data-label></span><span data-pct></span></div>
          <div class="progress__track"><div class="progress__bar"></div></div>
        </div>`;
      bar = status.querySelector<HTMLElement>('.progress');
    }
    if (!bar) return;

    const clamped = Math.min(1, Math.max(0, ratio));
    const labelEl = bar.querySelector('[data-label]');
    const pctEl = bar.querySelector('[data-pct]');
    const fill = bar.querySelector<HTMLElement>('.progress__bar');
    if (labelEl) labelEl.textContent = label;
    if (pctEl) pctEl.textContent = `${Math.round(clamped * 100)}%`;
    if (fill) fill.style.width = `${clamped * 100}%`;
  }

  private clearProgress(): void {
    const status = this.el.status;
    if (status?.querySelector('.progress')) status.innerHTML = '';
  }

  private clearStatus(): void {
    if (this.el.status) this.el.status.innerHTML = '';
    this.hideAlert();
  }

  private hideAlert(): void {
    const card = this.el.alert;
    if (!card || card.hidden) return;
    card.removeAttribute('data-in');
    // Long enough for the fade to finish, short enough that the next failure is
    // never waiting behind the last one's exit.
    this.alertTimer = window.setTimeout(() => {
      card.hidden = true;
      this.alertTimer = null;
    }, 220);
  }

  showError(error: AudioError | Error): void {
    const card = this.el.alert;
    if (!card) return;

    // Both entry points clear the status first, so a failure that arrives inside
    // the fade-out would otherwise be hidden by the previous card's exit.
    if (this.alertTimer !== null) {
      window.clearTimeout(this.alertTimer);
      this.alertTimer = null;
    }

    const fix = error instanceof AudioError ? error.fix : 'Try reloading the page.';
    // The error code, never the message: messages can contain a filename.
    track('tool_error', {
      code: error instanceof AudioError ? error.code : 'unknown',
    });

    // textContent, never innerHTML — error text can contain a filename.
    if (this.el.alertTitle) this.el.alertTitle.textContent = error.message;
    if (this.el.alertFix) this.el.alertFix.textContent = fix;

    card.hidden = false;
    // Flush layout so the transition has a start state, then flip in the same
    // task rather than waiting for a frame. Processing long files is exactly when
    // someone switches tabs, and a backgrounded tab produces no frames — an
    // rAF here would leave the card at zero opacity until they came back.
    void card.offsetWidth;
    card.setAttribute('data-in', 'true');
  }

  showNote(message: string, kind: 'info' | 'warn' = 'info'): void {
    const status = this.el.status;
    if (!status) return;
    status.innerHTML = `<div class="note note--${kind}"><div class="note__body" data-msg></div></div>`;
    const body = status.querySelector('[data-msg]');
    if (body) body.textContent = message;
  }

  reset(): void {
    this.controller?.abort();
    this.player?.destroy();
    this.player = null;
    this.waveform?.destroy();
    this.waveform = null;
    this.buffers = [];
    this.files = [];
    this.markers = [];
    this.lastOutput = null;
    this.analyzed = null;
    this.hideResult();
    if (this.twoPhase()) this.setRunner('idle');

    this.el.workspace?.setAttribute('hidden', '');
    this.el.drop?.removeAttribute('hidden');
    this.el.chain?.setAttribute('hidden', '');
    if (this.el.results) this.el.results.innerHTML = '';
    this.clearStatus();
  }

  destroy(): void {
    this.detachDrop?.();
    this.reset();
  }
}

/** Entry point used by every tool page's inline script. */
export function createTool(config: ToolConfig): ToolRuntime | null {
  const root = document.querySelector<HTMLElement>('[data-tool]');
  if (!root) return null;
  return new ToolRuntime(root, config);
}
