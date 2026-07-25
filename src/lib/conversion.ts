/**
 * Drives ConversionPanel.astro.
 *
 * The interesting judgement here is the verdict line: telling someone that
 * re-encoding a 128 kbps MP3 to 320 kbps MP3 makes the file bigger without
 * making it better is the single most useful thing a converter can say, and no
 * other free converter says it.
 */
import type { ToolRuntime } from './tool';
import { formatById, estimateSize } from './audio/export';
import { filesize, duration, extensionOf, sampleRateLabel, channelLabel } from './format';

/** Formats whose data has already been through a lossy encoder. */
const LOSSY_EXTENSIONS = new Set([
  'mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma', 'amr', 'm4b', 'weba', 'webm',
  'mp4', 'mov', 'mkv', 'avi', '3gp',
]);

interface Verdict {
  kind: 'info' | 'warn';
  title: string;
  body: string;
}

/**
 * Estimates the source's bitrate from its size and duration. Approximate —
 * container overhead and tags are included — but close enough to tell a 128
 * from a 320.
 */
function sourceBitrate(bytes: number, seconds: number): number | null {
  if (seconds <= 0) return null;
  return Math.round((bytes * 8) / seconds / 1000);
}

function verdictFor(
  sourceExt: string,
  sourceKbps: number | null,
  targetId: string,
  targetKbps: number
): Verdict | null {
  const target = formatById(targetId);
  const sourceLossy = LOSSY_EXTENSIONS.has(sourceExt);

  if (!sourceLossy && !target.lossy) {
    return {
      kind: 'info',
      title: 'Lossless the whole way through.',
      body: 'Your source is uncompressed or losslessly compressed, and so is the output. Nothing is discarded.',
    };
  }

  if (!sourceLossy && target.lossy) {
    return {
      kind: 'info',
      title: 'One lossy encode, from a clean source.',
      body: `This is the ideal case: the encoder is working from full-quality audio, so ${targetKbps} kbps buys you the best quality that bitrate can hold.`,
    };
  }

  if (sourceLossy && !target.lossy) {
    return {
      kind: 'warn',
      title: 'This will not improve the audio.',
      body: `A lossless copy of an already-compressed file preserves exactly what is there — including what the first encoder threw away — at several times the size. Convert to ${target.label} only if a specific tool or device requires it.`,
    };
  }

  // Lossy to lossy: the case where the advice actually matters.
  if (sourceKbps !== null && targetKbps > sourceKbps * 1.15) {
    return {
      kind: 'warn',
      title: 'A higher bitrate cannot recover what is gone.',
      body: `Your source is roughly ${sourceKbps} kbps. Encoding at ${targetKbps} kbps makes the file bigger without making it sound better. Match the source, or go lower if you want it smaller.`,
    };
  }

  return {
    kind: 'warn',
    title: 'Second-generation encode.',
    body: 'Your source is already compressed, so this re-encode loses a little more, the way a photocopy of a photocopy does. At 192 kbps and above one extra pass is inaudible to almost everyone.',
  };
}

/**
 * Wires the panel to a tool runtime. Call once from `onReady`; it re-renders
 * itself on every subsequent format or quality change.
 */
export function wireConversionPanel(runtime: ToolRuntime): void {
  const root = runtime.root;
  const panel = root.querySelector<HTMLElement>('[data-convert]');
  if (!panel) return;

  const set = (selector: string, value: string): void => {
    const el = panel.querySelector(selector);
    if (el) el.textContent = value;
  };

  const render = (): void => {
    const buffer = runtime.getBuffer();
    const file = runtime.getFile();
    if (!buffer || !file) return;

    const sourceExt = extensionOf(file.name) || 'audio';
    const targetId = runtime.getFormat();
    const target = formatById(targetId);
    const targetKbps = runtime.getBitrate();

    const kbps = sourceBitrate(file.size, buffer.duration);
    const sourceIsLossy = LOSSY_EXTENSIONS.has(sourceExt);

    set('[data-src-format]', sourceIsLossy && kbps
      ? `${sourceExt.toUpperCase()} · about ${kbps} kbps`
      : sourceExt.toUpperCase());
    set('[data-src-length]', duration(buffer.duration));
    set('[data-src-rate]', sampleRateLabel(buffer.sampleRate));
    set('[data-src-channels]', channelLabel(buffer.numberOfChannels));
    set('[data-src-size]', filesize(file.size));

    set('[data-out-format]', target.lossy
      ? `${target.label} · ${targetKbps} kbps`
      : `${target.label} · lossless`);
    // Conversion never changes duration or channel layout on these pages.
    set('[data-out-length]', duration(buffer.duration));
    set('[data-out-rate]', sampleRateLabel(buffer.sampleRate));
    set('[data-out-channels]', channelLabel(buffer.numberOfChannels));

    const outBytes = estimateSize(buffer, targetId, { bitrate: targetKbps });
    const delta = file.size > 0 ? Math.round(((outBytes - file.size) / file.size) * 100) : 0;
    const change =
      Math.abs(delta) < 3
        ? 'about the same'
        : delta > 0
          ? `${delta}% larger`
          : `${Math.abs(delta)}% smaller`;
    set('[data-out-size]', `${filesize(outBytes)} · ${change}`);

    const verdict = verdictFor(sourceExt, kbps, targetId, targetKbps);
    const slot = panel.querySelector<HTMLElement>('[data-convert-verdict]');
    if (!slot) return;

    if (!verdict) {
      slot.innerHTML = '';
      return;
    }

    slot.innerHTML = `<div class="note note--${verdict.kind}">
        <div class="note__body">
          <div class="note__title" data-t></div><div data-b></div>
        </div>
      </div>`;
    const title = slot.querySelector('[data-t]');
    const body = slot.querySelector('[data-b]');
    if (title) title.textContent = verdict.title;
    if (body) body.textContent = verdict.body;
  };

  render();
  root.addEventListener('formatchange', render);
  // Quality lives in the shared export bar, which does not re-dispatch.
  root.querySelector('[data-quality]')?.addEventListener('change', render);
}
