/**
 * Drives SendPanel.astro for the three destination tools.
 *
 * The interesting judgement is in fit.ts; this is the part that keeps the
 * screen honest about it. Two rules shape the whole file:
 *
 * 1. The export bar stays the single source of truth for format and bitrate.
 *    Choosing a route *sets* those controls rather than bypassing them, so a
 *    user who overrides the format afterwards gets a part count recomputed
 *    around their choice instead of a plan that quietly no longer applies.
 * 2. Nothing claims a fit it has not costed. Every number on screen comes from
 *    the same `bytesFor` the slicing uses.
 */
import { createTool, type NamedOutput, type ToolContext, type ToolRuntime } from './tool';
import {
  DESTINATIONS,
  budgetFor,
  bytesFor,
  planFor,
  verifiedCuts,
  type ContentKind,
  type Plan,
  type Route,
} from './audio/fit';
import { classify } from './audio/classify';
import { findSilence, setChannels, slice } from './audio/dsp';
import { exportAudio } from './audio/export';
import { getAudioContext } from './audio/decode';
import { baseName, duration as fmtDuration, extensionOf, filesize } from './format';
import { panelColors, panelContext } from './canvas';

const AUDITION_SECONDS = 15;

export function createSendTool(destinationId: string): ToolRuntime | null {
  const destination = DESTINATIONS[destinationId];
  if (!destination) return null;

  let kind: ContentKind = 'music';
  let kindReasons: string[] = [];
  let kindConfident = false;
  /** Set once the user overrides the guess, which then stops being re-guessed. */
  let kindPinned = false;
  /** The route the user actually clicked, so a re-render does not yank it away. */
  let chosen: string | null = null;
  let plan: Plan | null = null;
  let silences: { start: number; end: number }[] | null = null;
  let auditioning = false;

  const ceilingFor = (root: HTMLElement) => {
    const select = root.querySelector<HTMLSelectElement>('[data-control="ceiling"]');
    const id = select?.value;
    return destination.ceilings.find((c) => c.id === id) ?? destination.ceilings[0]!;
  };

  const selectedRoute = (): Route | null => {
    if (!plan) return null;
    const byId = plan.routes.find((route) => route.id === chosen);
    return byId ?? plan.routes[plan.recommended] ?? null;
  };

  /** findSilence walks every sample, so it runs once per file and is cached. */
  const getSilences = (buffer: AudioBuffer) => {
    if (!silences) silences = findSilence(buffer, -45, 0.35);
    return silences;
  };

  const tool = createTool({
    suffix: 'send',
    defaultFormat: 'mp3',

    onReady(ctx, runtime) {
      const root = runtime.root;
      chosen = null;
      silences = null;

      if (!kindPinned) {
        const guess = classify(ctx.buffer);
        kind = guess.kind;
        kindReasons = guess.reasons;
        kindConfident = guess.confident;
      }

      const ceilingNote = root.querySelector<HTMLElement>('[data-ceiling-note]');
      const verdict = root.querySelector<HTMLElement>('[data-verdict]');
      const verdictHead = root.querySelector<HTMLElement>('[data-verdict-head]');
      const verdictWhy = root.querySelector<HTMLElement>('[data-verdict-why]');
      const flip = root.querySelector<HTMLButtonElement>('[data-kind-flip]');
      const list = root.querySelector<HTMLElement>('[data-routes]');
      const panel = root.querySelector<HTMLElement>('[data-fit-panel]');
      const canvas = root.querySelector<HTMLCanvasElement>('[data-fit-plot]');
      const caption = root.querySelector<HTMLElement>('[data-fit-caption]');
      const audition = root.querySelector<HTMLButtonElement>('[data-audition]');

      const file = ctx.files[0];
      const sourceBytes = file?.size ?? 0;
      const sourceExt = extensionOf(file?.name ?? '') || 'mp3';

      /** Pushes a route's settings into the export bar, which owns them. */
      const applyToExportBar = (route: Route): void => {
        if (route.kind === 'asis' || route.kind === 'escape') return;
        const format = root.querySelector<HTMLSelectElement>('[data-format]');
        const quality = root.querySelector<HTMLSelectElement>('[data-quality]');
        if (!format || !quality) return;

        if (format.value !== route.format) {
          format.value = route.format;
          // The runtime repopulates the quality list off this event, so the
          // bitrate can only be set once it has fired.
          format.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const target = String(route.bitrate);
        const exact = Array.from(quality.options).some((option) => option.value === target);
        if (exact) {
          quality.value = target;
        } else {
          // Fall back to the nearest offered rate rather than leaving the bar
          // showing something the plan never proposed.
          let best = quality.options[0]?.value ?? target;
          let distance = Infinity;
          for (const option of Array.from(quality.options)) {
            const gap = Math.abs(Number(option.value) - route.bitrate);
            if (gap < distance) {
              distance = gap;
              best = option.value;
            }
          }
          quality.value = best;
        }
        quality.dispatchEvent(new Event('change', { bubbles: true }));
      };

      const renderRoutes = (): void => {
        if (!list || !plan) return;
        // Pinned to a local so the narrowing survives into the callback; `plan`
        // itself is reassigned on every re-plan.
        const current = plan;
        list.textContent = '';
        const active = selectedRoute();

        current.routes.forEach((route, index) => {
          const row = document.createElement('label');
          row.className = route.quality === 'rough' ? 'route route--rough' : 'route';

          const radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'send-route';
          radio.className = 'route__radio';
          radio.value = route.id;
          radio.checked = route.id === active?.id;
          radio.addEventListener('change', () => {
            chosen = route.id;
            applyToExportBar(route);
            paint();
            describe();
          });

          const title = document.createElement('span');
          title.className = 'route__title';
          const name = document.createElement('span');
          name.textContent = route.title;
          title.append(name);

          /*
           * The badge marks what the engine picked, not what is currently
           * selected. Those come apart the moment someone clicks a different
           * route, and that is exactly when it earns its place: you can still
           * see what was suggested after choosing to ignore it.
           */
          if (index === current.recommended) {
            const badge = document.createElement('span');
            badge.className = 'chip chip--brand route__badge';
            badge.textContent = 'Recommended';
            title.append(badge);
          }

          const size = document.createElement('span');
          size.className = 'route__size tnum';
          size.textContent =
            route.parts > 1
              ? `${route.parts} × ${filesize(route.partBytes)}`
              : filesize(route.totalBytes);

          const reason = document.createElement('span');
          reason.className = 'route__reason';
          reason.textContent = route.reason;

          row.append(radio, title, size, reason);
          list.append(row);
        });
      };

      /** The budget bar. Widths come from bytes, never from a guess. */
      const paint = (): void => {
        if (!panel || !canvas || !plan) return;
        const cssWidth = canvas.clientWidth;
        const cssHeight = canvas.clientHeight;
        if (cssWidth < 1 || cssHeight < 1) return;

        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const width = Math.round(cssWidth * dpr);
        const height = Math.round(cssHeight * dpr);
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }

        const context = panelContext(canvas);
        if (!context) return;
        context.clearRect(0, 0, width, height);

        const { ink, hue, danger } = panelColors(panel);

        const route = selectedRoute();
        const budget = plan.budget;
        const padL = 8 * dpr;
        const padR = 8 * dpr;
        const usable = width - padL - padR;

        /*
         * The scale adapts rather than pinning the limit to a fixed column.
         * A fixed line left a third of the panel permanently empty whenever
         * the file already fitted, which reads as broken rather than as
         * headroom. Now whichever is larger — the file or the limit — sets the
         * scale, so the bars always use the width and the dashed line lands
         * wherever the truth puts it.
         */
        const span = Math.max(sourceBytes, budget * 1.06);
        const scale = usable / span;
        const limitX = padL + budget * scale;

        context.font = `${10 * dpr}px system-ui, sans-serif`;
        context.textBaseline = 'middle';

        const rowH = 24 * dpr;
        const gap = 10 * dpr;
        const labelH = 14 * dpr;
        const topY = 18 * dpr;
        const bottomY = topY + rowH + gap + labelH;

        const bar = (
          y: number,
          bytes: number,
          fill: string,
          overflowing: boolean
        ): void => {
          const full = bytes * scale;
          const drawn = Math.min(full, usable);
          context.fillStyle = fill;
          roundRect(context, padL, y, Math.max(drawn, 2 * dpr), rowH, 4 * dpr);
          context.fill();

          if (overflowing) {
            // Tint only the part past the line, so the eye lands on the excess.
            context.save();
            context.beginPath();
            context.rect(limitX, y, Math.max(drawn - limitX, 0), rowH);
            context.clip();
            context.fillStyle = `color-mix(in oklch, ${danger} 70%, transparent)`;
            roundRect(context, padL, y, Math.max(drawn, 2 * dpr), rowH, 4 * dpr);
            context.fill();
            context.restore();
          }
        };

        const label = (y: number, text: string, strong: boolean): void => {
          context.fillStyle = `color-mix(in oklch, ${ink} ${strong ? 78 : 52}%, transparent)`;
          context.textAlign = 'left';
          context.fillText(text, padL, y);
        };

        // What you have.
        label(topY - 8 * dpr, 'What you have', false);
        bar(
          topY,
          sourceBytes,
          `color-mix(in oklch, ${ink} 22%, transparent)`,
          sourceBytes > budget
        );

        // What you would send.
        label(bottomY - 8 * dpr, 'What you would send', false);
        if (route) {
          if (route.kind === 'escape') {
            bar(bottomY, sourceBytes, `color-mix(in oklch, ${ink} 30%, transparent)`, false);
          } else {
            let x = padL;
            for (let i = 0; i < route.parts; i += 1) {
              const w = Math.max(route.partBytes * scale, 3 * dpr);
              context.fillStyle = `color-mix(in oklch, ${hue} 85%, transparent)`;
              roundRect(context, x, bottomY, w, rowH, 4 * dpr);
              context.fill();
              x += w + 3 * dpr;
              if (x > padL + usable) break;
            }
          }
        }

        // The limit itself, drawn last so nothing covers it.
        context.strokeStyle = `color-mix(in oklch, ${ink} 55%, transparent)`;
        context.lineWidth = 1.5 * dpr;
        context.setLineDash([4 * dpr, 4 * dpr]);
        context.beginPath();
        context.moveTo(limitX, 6 * dpr);
        context.lineTo(limitX, bottomY + rowH + 4 * dpr);
        context.stroke();
        context.setLineDash([]);

        context.fillStyle = `color-mix(in oklch, ${ink} 72%, transparent)`;
        context.textAlign = 'right';
        context.font = `600 ${10 * dpr}px system-ui, sans-serif`;
        context.fillText(filesize(budget), limitX - 5 * dpr, 8 * dpr);
      };

      const describe = (): void => {
        const route = selectedRoute();
        if (!caption || !plan) return;

        if (!route) {
          caption.textContent =
            `Nothing gets this under ${filesize(plan.budget)} without sounding bad. ` +
            'Trimming it first is the better move.';
          return;
        }

        const ceiling = ceilingFor(root);
        const tax =
          destination.overhead > 1
            ? ` ${ceiling.label.split(',')[0]?.trim() ?? 'The limit'} is ${filesize(ceiling.bytes)}, but attachments are encoded on the way out, so the real ceiling is ${filesize(plan.budget)}.`
            : '';

        if (route.kind === 'asis') {
          caption.textContent = `This is already under ${filesize(plan.budget)}.${tax}`;
        } else if (route.kind === 'escape') {
          caption.textContent = `${route.reason}${tax}`;
        } else if (route.parts > 1) {
          caption.textContent =
            `${route.parts} files, each under ${filesize(plan.budget)}, cut at pauses so ` +
            `none of them opens mid-word.${tax}`;
        } else {
          caption.textContent = `One file of about ${filesize(route.totalBytes)}, under the ${filesize(plan.budget)} that fits.${tax}`;
        }

        if (audition) audition.disabled = route.kind === 'asis' || route.kind === 'escape';
      };

      const render = (): void => {
        const ceiling = ceilingFor(root);
        plan = planFor({
          seconds: ctx.buffer.duration,
          sourceBytes,
          sourceExt,
          destination,
          ceiling,
          kind,
        });

        // Drop a pinned choice that the new settings no longer offer.
        if (chosen && !plan.routes.some((route) => route.id === chosen)) chosen = null;

        if (ceilingNote) {
          ceilingNote.textContent = ceiling.note ?? '';
          ceilingNote.hidden = !ceiling.note;
        }

        if (verdict && verdictHead && verdictWhy && flip) {
          verdict.hidden = false;
          verdictHead.textContent =
            `${fmtDuration(ctx.buffer.duration)} · ${filesize(sourceBytes)} · ` +
            (sourceBytes > plan.budget
              ? `over the ${filesize(plan.budget)} that fits`
              : 'already small enough');
          const evidence = kindConfident
            ? `Sounds like ${kind}: ${kindReasons.join(', ')}.`
            : `Not sure whether this is speech or music, so it is being treated as ${kind}.`;
          verdictWhy.textContent = evidence;
          flip.textContent = kind === 'speech' ? "It's music" : "It's speech";
        }

        renderRoutes();
        const active = selectedRoute();
        if (active) applyToExportBar(active);
        paint();
        describe();
      };

      flip?.addEventListener('click', () => {
        kind = kind === 'speech' ? 'music' : 'speech';
        kindPinned = true;
        kindConfident = true;
        kindReasons = ['you said so'];
        chosen = null;
        render();
      });

      root
        .querySelector<HTMLSelectElement>('[data-control="ceiling"]')
        ?.addEventListener('change', () => {
          chosen = null;
          render();
        });

      // A manual format or quality change is an override, not a mistake: the
      // part count is recomputed around it so the two never disagree.
      root.addEventListener('formatchange', () => {
        paint();
        describe();
      });
      root.querySelector('[data-quality]')?.addEventListener('change', () => {
        paint();
        describe();
      });

      audition?.addEventListener('click', () => {
        void runAudition(ctx, runtime, root);
      });

      // The canvas has no width until the workspace stops being hidden.
      requestAnimationFrame(paint);
      if (panel) new ResizeObserver(() => paint()).observe(panel);

      render();
    },

    async process(ctx) {
      const runtime = tool;
      const route = selectedRoute();
      const file = ctx.files[0];

      // Nothing to do: hand back exactly what they already have, so the page
      // is never a dead end even when the answer is "you were already fine".
      if (!route || route.kind === 'asis' || route.kind === 'escape') {
        if (!file) return ctx.buffer;
        return [{ name: file.name, blob: file }] satisfies NamedOutput[];
      }

      // Bitrate only: the format is read straight off the export bar by the
      // runtime when it encodes each part, so reading it here too would just
      // be a second copy of the same truth.
      const bitrate = runtime?.getBitrate() ?? route.bitrate;
      const ceiling = ceilingFor(runtime?.root ?? document.body);
      const budget = budgetFor(destination, ceiling);

      let buffer = ctx.buffer;
      if (route.mono && buffer.numberOfChannels > 1) buffer = setChannels(buffer, 1);

      const total = bytesFor(buffer.duration, bitrate);
      const wanted = Math.max(1, Math.ceil(total / budget));
      const stem = (baseName(file?.name ?? 'audio') || 'audio').replace(/\./g, '-');

      if (wanted === 1) return buffer;

      ctx.progress(0, 'Finding the pauses');
      const { points, parts } = verifiedCuts(
        buffer.duration,
        wanted,
        getSilences(ctx.buffer),
        bitrate,
        budget
      );

      const outputs: NamedOutput[] = [];
      for (let i = 0; i < points.length - 1; i += 1) {
        outputs.push({
          // "1 of 3" rather than the splitter's "01", because the person
          // receiving these reads the filename in a chat thread and needs to
          // know when they have them all.
          name: `${stem}-part-${i + 1}-of-${parts}`,
          buffer: slice(buffer, points[i]!, points[i + 1]!),
        });
      }
      return outputs;
    },
  });

  /**
   * Fifteen seconds from the middle, encoded at the settings on screen and
   * decoded back, mounted on the result strip.
   *
   * The main transport keeps the original throughout — comparing is the entire
   * point, and swapping the source out from under the play button would make
   * it impossible.
   */
  async function runAudition(
    ctx: ToolContext,
    runtime: ToolRuntime,
    root: HTMLElement
  ): Promise<void> {
    const button = root.querySelector<HTMLButtonElement>('[data-audition]');
    const route = selectedRoute();
    if (auditioning || !route || route.kind === 'asis' || route.kind === 'escape') return;

    auditioning = true;
    if (button) {
      button.disabled = true;
      button.textContent = 'Encoding…';
    }

    try {
      const span = Math.min(AUDITION_SECONDS, ctx.buffer.duration);
      const start = Math.max(0, (ctx.buffer.duration - span) / 2);
      let probe = slice(ctx.buffer, start, start + span);
      if (route.mono && probe.numberOfChannels > 1) probe = setChannels(probe, 1);

      const blob = await exportAudio(probe, runtime.getFormat(), {
        bitrate: runtime.getBitrate(),
      });
      const decoded = await getAudioContext().decodeAudioData(await blob.arrayBuffer());
      runtime.showResult(decoded, `${runtime.getBitrate()}k preview`);
    } catch {
      runtime.showNote(
        'That preview could not be decoded back for playback, which does not stop the download from working.',
        'warn'
      );
    } finally {
      auditioning = false;
      if (button) {
        button.disabled = false;
        button.textContent = 'Hear it first';
      }
    }
  }

  return tool;
}

function roundRect(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}
