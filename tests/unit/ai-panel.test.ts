/**
 * Regression cover for what the AI setup button is allowed to download.
 *
 * The panel is built against a set of weights, but the button it binds lives in
 * markup that outlives the panel: the stem splitter rebuilds the panel on every
 * checkbox change, and every tool rebuilds it whenever a new file is decoded.
 * A listener left behind by a previous build still holds that build's asset
 * list, so one press used to fire all of them at once — fetching weights for a
 * selection the user had already moved away from, on a page that had just
 * promised a specific number of megabytes.
 *
 * These tests drive the panel through a fake of exactly the DOM surface it
 * touches. The thing under test is listener bookkeeping, so the fake button
 * keeps its listeners in a Set and fires them in insertion order, which is the
 * one browser behaviour the bug depended on.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { ModelAsset } from '../../src/lib/ai/store';

/** Every asset handed to loadModel, in call order. */
let requested: string[] = [];

vi.mock('../../src/lib/ai/store', () => ({
  isReady: async () => false,
  outstandingBytes: async () => 0,
  loadModel: async (asset: ModelAsset) => {
    requested.push(asset.file);
    return new ArrayBuffer(8);
  },
}));

const { createAiPanel } = await import('../../src/lib/ai/panel');

const PHASES = { download: 'Setting up', start: 'Starting', work: 'Splitting' };

const VOCALS: ModelAsset = { file: 'kuielab-vocals.onnx', bytes: 29_703_204 };
const DRUMS: ModelAsset = { file: 'kuielab-drums.onnx', bytes: 29_703_204 };

class FakeElement {
  hidden = false;
  textContent = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  private attributes: Record<string, string> = {};

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }
}

/** Mirrors the browser: distinct listeners all fire, oldest first. */
class FakeButton extends FakeElement {
  private listeners = new Set<() => void>();

  addEventListener(type: string, fn: () => void): void {
    if (type === 'click') this.listeners.add(fn);
  }

  removeEventListener(type: string, fn: () => void): void {
    if (type === 'click') this.listeners.delete(fn);
  }

  click(): void {
    for (const fn of [...this.listeners]) fn();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

/**
 * The panel markup, as far as the panel can tell.
 *
 * One element per selector, created up front and returned for every query, so
 * that rebuilding the panel finds the same button the previous build did —
 * which is the whole point.
 */
function makePanelDom(): { root: HTMLElement; start: FakeButton } {
  const start = new FakeButton();
  const bySelector = new Map<string, FakeElement>([
    ['[data-ai-offer]', new FakeElement()],
    ['[data-ai-loading]', new FakeElement()],
    ['[data-ai-ready]', new FakeElement()],
    ['[data-ai-start]', start],
    ['[data-ai-phase]', new FakeElement()],
    ['[data-ai-count]', new FakeElement()],
    ['[data-ai-bar-track]', new FakeElement()],
    ['[data-ai-bar]', new FakeElement()],
    ['[data-ai-hint]', new FakeElement()],
  ]);

  const root = new FakeElement() as FakeElement & {
    querySelector(selector: string): FakeElement | null;
  };
  root.querySelector = (selector: string) => bySelector.get(selector) ?? null;

  return { root: root as unknown as HTMLElement, start };
}

/** Lets the panel's own awaits settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('AI setup panel', () => {
  beforeEach(() => {
    requested = [];
  });

  it('downloads only the current selection after a rebuild', async () => {
    const dom = makePanelDom();

    // Vocals and drums are ticked, then the user unticks vocals and the page
    // rebuilds the panel for what is left.
    createAiPanel(dom.root, [VOCALS, DRUMS], PHASES);
    createAiPanel(dom.root, [DRUMS], PHASES);
    await flush();

    dom.start.click();
    await flush();

    // 28 MB was promised on screen, so 28 MB is what may be fetched.
    expect(requested).toEqual(['kuielab-drums.onnx']);
  });

  it('does not fetch twice when a second file rebuilds the panel', async () => {
    const dom = makePanelDom();

    // Every AI tool wires its panel in onReady, which runs again for each file
    // decoded. The markup is only hidden between files, never replaced.
    createAiPanel(dom.root, [DRUMS], PHASES);
    createAiPanel(dom.root, [DRUMS], PHASES);
    await flush();

    dom.start.click();
    await flush();

    expect(requested).toEqual(['kuielab-drums.onnx']);
  });

  it('leaves exactly one live listener however often it is rebuilt', async () => {
    const dom = makePanelDom();

    for (let i = 0; i < 4; i += 1) createAiPanel(dom.root, [DRUMS], PHASES);
    await flush();

    expect(dom.start.listenerCount).toBe(1);
  });

  it('still downloads when the button is pressed', async () => {
    const dom = makePanelDom();

    createAiPanel(dom.root, [VOCALS, DRUMS], PHASES);
    await flush();

    dom.start.click();
    await flush();

    expect(requested).toEqual(['kuielab-vocals.onnx', 'kuielab-drums.onnx']);
  });
});
