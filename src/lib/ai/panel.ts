/**
 * Drives the AI setup panel: offer, download, ready.
 *
 * Shared by every AI tool, because the sequence is the same each time and the
 * only differences are which weights are needed and what the phases are called.
 */
import { filesize } from '../format';
import { isReady, loadModel, outstandingBytes, type ModelAsset } from './store';

export interface PanelPhases {
  /** Shown while weights come down. */
  download: string;
  /** Shown while the runtime starts, which has no measurable progress. */
  start: string;
  /** Shown while the model runs. */
  work: string;
}

export interface AiPanel {
  /** Fetches whatever is missing, resolving once the tool can run. */
  ensure(signal?: AbortSignal): Promise<void>;
  /** Reflects an arbitrary phase, for the work that follows the download. */
  setPhase(label: string, ratio: number | null): void;
  /** Back to the quiet ready line. */
  finish(): void;
  /** True once every asset is present, without fetching anything. */
  ready(): Promise<boolean>;
}

interface Elements {
  root: HTMLElement;
  offer: HTMLElement | null;
  loading: HTMLElement | null;
  readyLine: HTMLElement | null;
  start: HTMLButtonElement | null;
  phase: HTMLElement | null;
  count: HTMLElement | null;
  track: HTMLElement | null;
  bar: HTMLElement | null;
  hint: HTMLElement | null;
}

function find(root: HTMLElement): Elements {
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel);
  return {
    root,
    offer: $('[data-ai-offer]'),
    loading: $('[data-ai-loading]'),
    readyLine: $('[data-ai-ready]'),
    start: $<HTMLButtonElement>('[data-ai-start]'),
    phase: $('[data-ai-phase]'),
    count: $('[data-ai-count]'),
    track: $('[data-ai-bar-track]'),
    bar: $('[data-ai-bar]'),
    hint: $('[data-ai-hint]'),
  };
}

/**
 * Wires up the panel for a set of assets.
 *
 * Returns null when the markup is absent, so a page that does not include the
 * component is not a crash — the tool simply fetches without narration.
 */
export function createAiPanel(
  root: HTMLElement | null,
  assets: ModelAsset[],
  phases: PanelPhases
): AiPanel {
  const el = root ? find(root) : null;

  const show = (which: 'offer' | 'loading' | 'ready' | 'none'): void => {
    if (!el) return;
    el.root.hidden = which === 'none';
    if (el.offer) el.offer.hidden = which !== 'offer';
    if (el.loading) el.loading.hidden = which !== 'loading';
    if (el.readyLine) el.readyLine.hidden = which !== 'ready';
  };

  const paint = (label: string, ratio: number | null, detail?: string): void => {
    if (!el) return;
    if (el.phase) el.phase.textContent = label;
    if (el.count) el.count.textContent = detail ?? '';
    if (el.track) {
      // An indeterminate phase sweeps rather than showing a number it does not
      // have. Claiming 40% while starting a runtime is a lie the user can feel.
      el.track.dataset.indeterminate = ratio === null ? 'true' : 'false';
      el.track.setAttribute(
        'aria-valuenow',
        ratio === null ? '0' : String(Math.round(ratio * 100))
      );
    }
    if (el.bar && ratio !== null) el.bar.style.width = `${Math.round(ratio * 100)}%`;
  };

  // Reflect what is already stored, so a returning visitor never sees the offer.
  const settle = async (): Promise<boolean> => {
    const have = assets.length === 0 || (await isReady(assets));
    show(have ? 'ready' : 'offer');
    return have;
  };
  void settle();

  let started: Promise<void> | null = null;

  const fetchAll = async (signal?: AbortSignal): Promise<void> => {
    show('loading');

    // Progress across several files has to be reported as one bar, or the stem
    // splitter's four downloads look like four separate waits.
    const total = assets.reduce((sum, asset) => sum + asset.bytes, 0);
    const loadedPer = new Map<string, number>();

    const report = (): void => {
      let loaded = 0;
      for (const value of loadedPer.values()) loaded += value;
      paint(
        phases.download,
        total ? Math.min(1, loaded / total) : null,
        total ? `${filesize(loaded)} of ${filesize(total)}` : ''
      );
    };
    report();

    for (const asset of assets) {
      await loadModel(asset, {
        signal,
        onProgress: ({ loaded, verifying }) => {
          loadedPer.set(asset.file, loaded);
          if (verifying) {
            paint(`Checking ${asset.file}`, null);
          } else {
            report();
          }
        },
      });
      loadedPer.set(asset.file, asset.bytes);
      report();
    }

    if (el?.hint) {
      el.hint.textContent = 'Stored on this device. Next time it starts instantly.';
    }
  };

  if (el?.start) {
    el.start.addEventListener('click', () => {
      if (started) return;
      started = fetchAll().then(
        () => {
          show('ready');
        },
        (error: unknown) => {
          // Let the tool's own error surface handle wording; reset so the button
          // can be pressed again rather than leaving a dead panel.
          started = null;
          show('offer');
          throw error;
        }
      );
      // A rejection here is reported by whoever awaits ensure(); swallow the
      // unhandled-rejection warning from this speculative call.
      void started.catch(() => {});
    });
  }

  return {
    async ensure(signal?: AbortSignal): Promise<void> {
      if (assets.length === 0) return;
      if (started) return started;
      if (await isReady(assets)) {
        show('ready');
        return;
      }
      started = fetchAll(signal);
      try {
        await started;
        show('ready');
      } catch (error) {
        started = null;
        show('offer');
        throw error;
      }
    },

    setPhase(label: string, ratio: number | null): void {
      show('loading');
      paint(label, ratio);
      if (el?.hint) {
        el.hint.textContent =
          'Running on your machine. Nothing is uploaded, which is also why it takes a moment.';
      }
    },

    finish(): void {
      show('ready');
    },

    async ready(): Promise<boolean> {
      return assets.length === 0 || isReady(assets);
    },
  };
}

/** Bytes still to fetch, for copy that quotes a figure before the click. */
export async function pendingDownload(assets: ModelAsset[]): Promise<number> {
  return outstandingBytes(assets);
}
