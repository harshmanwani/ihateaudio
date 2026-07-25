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
import { timecode, filesize, outputName, duration as fmtDuration } from './format';

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
  /** Reports 0..1 during a long process step. */
  progress: (ratio: number) => void;
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
  /** Optional: audio the transport should play instead of the raw source. */
  preview?: (ctx: ToolContext) => Promise<AudioBuffer> | AudioBuffer;
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
  private controller: AbortController | null = null;
  private detachDrop: (() => void) | null = null;
  private previewBuffer: AudioBuffer | null = null;
  private lastOutput: { blob: Blob; name: string } | null = null;

  // Cached elements — every tool page renders the same skeleton.
  private el: {
    drop: HTMLElement | null;
    input: HTMLInputElement | null;
    workspace: HTMLElement | null;
    status: HTMLElement | null;
    stage: HTMLElement | null;
    canvas: HTMLCanvasElement | null;
    canvasWrap: HTMLElement | null;
    playhead: HTMLElement | null;
    handleStart: HTMLElement | null;
    handleEnd: HTMLElement | null;
    maskLeft: HTMLElement | null;
    maskRight: HTMLElement | null;
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
    chain: HTMLElement | null;
    results: HTMLElement | null;
  };

  constructor(root: HTMLElement, config: ToolConfig) {
    this.root = root;
    this.config = config;

    this.el = {
      drop: $(root, '[data-drop]'),
      input: $<HTMLInputElement>(root, '[data-file-input]'),
      workspace: $(root, '[data-workspace]'),
      status: $(root, '[data-status]'),
      stage: $(root, '[data-stage]'),
      canvas: $<HTMLCanvasElement>(root, '[data-canvas]'),
      canvasWrap: $(root, '[data-canvas-wrap]'),
      playhead: $(root, '[data-playhead]'),
      handleStart: $(root, '[data-handle="start"]'),
      handleEnd: $(root, '[data-handle="end"]'),
      maskLeft: $(root, '[data-mask="left"]'),
      maskRight: $(root, '[data-mask="right"]'),
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
      chain: $(root, '[data-chain]'),
      results: $(root, '[data-results]'),
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
    this.el.format?.addEventListener('change', () => this.onFormatChange());
    this.el.quality?.addEventListener('change', () => this.updateSize());

    this.buildFormatOptions();
    this.setupTransport();
    this.setupKeyboard();

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

  async load(files: File[]): Promise<void> {
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

      this.files = files;
      this.buffers = decoded;
      this.selection = { start: 0, end: decoded[0].duration };
      this.lastOutput = null;

      this.setBusy(false);
      this.clearStatus();
      this.showWorkspace();
      this.mountStage();
      this.updateFileMeta();
      this.updateSize();
      this.el.chain?.setAttribute('hidden', '');
      if (this.el.results) this.el.results.innerHTML = '';

      this.config.onReady?.(this.context(), this);
      this.refreshPreview();
    } catch (err) {
      this.setBusy(false);
      const audioErr = toAudioError(err);
      if (audioErr.code !== 'cancelled') this.showError(audioErr);
    }
  }

  private showWorkspace(): void {
    this.el.drop?.setAttribute('hidden', '');
    this.el.workspace?.removeAttribute('hidden');
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

    if (!this.waveform) this.waveform = new Waveform(canvas);
    this.waveform.setBuffer(this.buffers[0]);

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

  private renderPlayhead(seconds: number): void {
    const { playhead, time } = this.el;
    const buffer = this.previewBuffer ?? this.buffers[0];
    if (playhead && this.waveform && buffer) {
      playhead.dataset.visible = 'true';
      playhead.style.left = `${(seconds / buffer.duration) * 100}%`;
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

  private renderSelection(): void {
    if (!this.config.selection || !this.waveform) return;
    const { handleStart, handleEnd, maskLeft, maskRight } = this.el;

    const startPct = this.waveform.positionOf(this.selection.start);
    const endPct = this.waveform.positionOf(this.selection.end);

    if (handleStart) {
      handleStart.style.left = `${startPct}%`;
      handleStart.setAttribute('aria-valuenow', this.selection.start.toFixed(2));
      const tip = handleStart.querySelector('[data-tip]');
      if (tip) tip.textContent = timecode(this.selection.start);
    }
    if (handleEnd) {
      handleEnd.style.left = `${endPct}%`;
      handleEnd.setAttribute('aria-valuenow', this.selection.end.toFixed(2));
      const tip = handleEnd.querySelector('[data-tip]');
      if (tip) tip.textContent = timecode(this.selection.end);
    }
    if (maskLeft) {
      maskLeft.style.left = '0';
      maskLeft.style.width = `${startPct}%`;
    }
    if (maskRight) {
      maskRight.style.left = `${endPct}%`;
      maskRight.style.width = `${100 - endPct}%`;
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

  // ---------- preview ----------

  /** Re-renders the transport's audio when controls change. */
  refreshPreview(): void {
    if (!this.config.preview || this.buffers.length === 0) return;
    void Promise.resolve(this.config.preview(this.context()))
      .then((buffer) => {
        this.previewBuffer = buffer;
        this.player?.setBuffer(buffer);
        this.waveform?.setBuffer(buffer);
        if (this.config.selection) this.player?.setRegion(this.selection);
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
      progress: (ratio) => this.showProgress(ratio, 'Processing'),
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

  async run(): Promise<void> {
    if (this.buffers.length === 0) return;

    this.controller?.abort();
    this.controller = new AbortController();

    const button = this.el.download;
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

    if (result instanceof Blob) {
      blob = result;
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

    const name = outputName(this.files[0]?.name ?? 'audio', suffix, spec.extension);
    saveBlob(blob, name);
    this.lastOutput = { blob, name };
    this.markReady();
    this.showChain();
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

  private showProgress(ratio: number, label: string): void {
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
  }

  showError(error: AudioError | Error): void {
    const status = this.el.status;
    if (!status) return;

    const fix = error instanceof AudioError ? error.fix : 'Try reloading the page.';
    status.innerHTML = `
      <div class="note note--error" role="alert">
        <div class="note__body">
          <div class="note__title"></div>
          <div data-fix></div>
        </div>
      </div>`;
    // textContent, never innerHTML — error text can contain a filename.
    const title = status.querySelector('.note__title');
    const body = status.querySelector('[data-fix]');
    if (title) title.textContent = error.message;
    if (body) body.textContent = fix;
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
    this.previewBuffer = null;
    this.lastOutput = null;

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
