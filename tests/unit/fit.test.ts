import { describe, expect, it } from 'vitest';
import {
  DESTINATIONS,
  budgetFor,
  bytesFor,
  cutPoints,
  planFor,
  verifiedCuts,
  type ContentKind,
  type Destination,
} from '../../src/lib/audio/fit';

const MB = 1024 * 1024;

function plan(
  destinationId: string,
  minutes: number,
  kind: ContentKind,
  options: { sourceBytes?: number; ceiling?: string; ext?: string } = {}
) {
  const destination = DESTINATIONS[destinationId] as Destination;
  const ceiling =
    destination.ceilings.find((c) => c.id === options.ceiling) ?? destination.ceilings[0]!;
  return planFor({
    seconds: minutes * 60,
    // Default well over any ceiling, so "as is" only appears when asked for.
    sourceBytes: options.sourceBytes ?? 500 * MB,
    sourceExt: options.ext ?? 'mp3',
    destination,
    ceiling,
    kind,
  });
}

describe('budget', () => {
  it('keeps 5% headroom under the stated ceiling', () => {
    const whatsapp = DESTINATIONS.whatsapp!;
    expect(budgetFor(whatsapp, whatsapp.ceilings[0]!)).toBeLessThan(16 * MB);
    expect(budgetFor(whatsapp, whatsapp.ceilings[0]!)).toBeGreaterThan(15 * MB);
  });

  it("charges email's base64 inflation, turning 25 MB into roughly 18", () => {
    const email = DESTINATIONS.email!;
    const budget = budgetFor(email, email.ceilings[0]!);
    expect(budget / MB).toBeGreaterThan(16.5);
    expect(budget / MB).toBeLessThan(18.5);
  });

  it('leaves destinations without an overhead untaxed', () => {
    const discord = DESTINATIONS.discord!;
    expect(budgetFor(discord, discord.ceilings[0]!)).toBeCloseTo(10 * MB * 0.95, -3);
  });
});

/*
 * The invariant everything else exists to protect. A tool that promises a fit
 * and hands back a file that bounces is worse than no tool at all, so this runs
 * across the whole matrix rather than on a couple of chosen examples.
 */
describe('every route fits its budget', () => {
  const lengths = [1, 5, 12, 20, 45, 90, 180, 360];
  const kinds: ContentKind[] = ['speech', 'music'];

  for (const id of Object.keys(DESTINATIONS)) {
    for (const ceiling of DESTINATIONS[id]!.ceilings) {
      for (const kind of kinds) {
        it(`${id}/${ceiling.id}/${kind}`, () => {
          for (const minutes of lengths) {
            const result = plan(id, minutes, kind, { ceiling: ceiling.id });
            for (const route of result.routes) {
              if (route.kind === 'asis' || route.kind === 'escape') continue;
              expect(
                route.partBytes,
                `${id} ${ceiling.id} ${kind} ${minutes}min via ${route.id}`
              ).toBeLessThanOrEqual(result.budget);
            }
          }
        });
      }
    }
  }
});

describe('the recommendation', () => {
  it('says nothing needs doing when the file already fits', () => {
    const result = plan('whatsapp', 3, 'music', { sourceBytes: 4 * MB });
    expect(result.routes[result.recommended]!.kind).toBe('asis');
  });

  it('does not offer as-is for a format the destination will not play', () => {
    const result = plan('whatsapp', 3, 'music', { sourceBytes: 4 * MB, ext: 'aiff' });
    expect(result.routes.some((route) => route.kind === 'asis')).toBe(false);
  });

  it('stays instant for a short file, where MP3 already manages one file', () => {
    const result = plan('whatsapp', 12, 'speech');
    const winner = result.routes[result.recommended]!;
    expect(winner.parts).toBe(1);
    expect(winner.instant).toBe(true);
  });

  it('earns Opus on a long lecture, because it is the only single-file answer', () => {
    const result = plan('whatsapp', 45, 'speech');
    const winner = result.routes[result.recommended]!;
    expect(winner.format).toBe('opus');
    expect(winner.parts).toBe(1);
    // And the claim the UI makes about it is the true one.
    expect(winner.reason).toMatch(/only way/i);
  });

  it('prefers fewer files over a better codec when both need splitting', () => {
    const result = plan('whatsapp', 180, 'speech');
    const winner = result.routes[result.recommended]!;
    const others = result.routes.filter(
      (route) => route.kind === 'parts' || route.kind === 'single'
    );
    for (const route of others) {
      if (route.quality === 'rough') continue;
      expect(winner.parts).toBeLessThanOrEqual(route.parts);
    }
  });

  it('does not spend a bitrate it has no use for', () => {
    // Three minutes of speech would technically fit Gmail at 320 kbps. Nobody
    // wants a 7 MB file for that, and it is indistinguishable from 128.
    const result = plan('email', 3, 'speech');
    const single = result.routes.find((route) => route.format === 'mp3' && route.parts === 1);
    expect(single).toBeDefined();
    expect(single!.bitrate).toBeLessThanOrEqual(128);
  });

  it('still walks down to the floor when the budget is genuinely tight', () => {
    const result = plan('discord', 30, 'speech');
    const single = result.routes.find((route) => route.parts === 1);
    expect(single).toBeDefined();
    expect(single!.bitrate).toBeLessThan(96);
  });

  it('never recommends a route it has called rough', () => {
    for (const id of Object.keys(DESTINATIONS)) {
      for (const minutes of [30, 60, 120, 240]) {
        for (const kind of ['speech', 'music'] as ContentKind[]) {
          const result = plan(id, minutes, kind);
          const winner = result.routes[result.recommended];
          if (winner) expect(winner.quality).not.toBe('rough');
        }
      }
    }
  });

  it('always leaves an instant route available, however good Opus is', () => {
    const result = plan('whatsapp', 45, 'speech');
    expect(result.routes.some((route) => route.instant && route.kind !== 'escape')).toBe(true);
  });

  it('offers the document escape on WhatsApp and nowhere else', () => {
    expect(plan('whatsapp', 45, 'music').routes.some((r) => r.kind === 'escape')).toBe(true);
    expect(plan('discord', 45, 'music').routes.some((r) => r.kind === 'escape')).toBe(false);
    expect(plan('email', 45, 'music').routes.some((r) => r.kind === 'escape')).toBe(false);
  });

  it('keeps Opus away from email, where the recipient opens it with anything', () => {
    for (const minutes of [5, 45, 180]) {
      const result = plan('email', minutes, 'speech');
      expect(result.routes.every((route) => route.format !== 'opus')).toBe(true);
    }
  });

  it('needs more parts for music than for speech at the same length', () => {
    const speech = plan('discord', 60, 'speech');
    const music = plan('discord', 60, 'music');
    const fewest = (p: ReturnType<typeof plan>) =>
      Math.min(
        ...p.routes
          .filter((r) => r.kind === 'single' || r.kind === 'parts')
          .filter((r) => r.quality !== 'rough')
          .map((r) => r.parts)
      );
    expect(fewest(music)).toBeGreaterThan(fewest(speech));
  });
});

describe('cut points', () => {
  const silences = [
    { start: 590, end: 592 },
    { start: 1210, end: 1210.6 },
    { start: 1800, end: 1804 },
  ];

  it('returns the whole file when there is nothing to split', () => {
    expect(cutPoints(600, 1, []).points).toEqual([0, 600]);
  });

  it('spans exactly the file, with one more point than parts', () => {
    const { points } = cutPoints(1800, 3, []);
    expect(points).toHaveLength(4);
    expect(points[0]).toBe(0);
    expect(points[points.length - 1]).toBe(1800);
  });

  it('slides a boundary onto a nearby pause', () => {
    const { points, snapped } = cutPoints(1200, 2, silences);
    expect(snapped).toBe(1);
    // The midpoint of the 590–592 gap, not the nominal 600.
    expect(points[1]).toBeCloseTo(591, 5);
  });

  it('leaves a boundary alone when the nearest pause is out of reach', () => {
    const { points, snapped } = cutPoints(1200, 2, [{ start: 100, end: 140 }]);
    expect(snapped).toBe(0);
    expect(points[1]).toBe(600);
  });

  it('keeps points in order', () => {
    const { points } = cutPoints(3600, 6, silences);
    for (let i = 1; i < points.length; i += 1) {
      expect(points[i]!).toBeGreaterThan(points[i - 1]!);
    }
  });

  it('adds a part rather than letting a snapped one overflow', () => {
    // A budget with no slack, so any drift from an even split must overflow.
    const seconds = 1200;
    const bitrate = 128;
    const exact = bytesFor(seconds / 2, bitrate);
    const drifting = [{ start: 640, end: 660 }];
    const result = verifiedCuts(seconds, 2, drifting, bitrate, exact);

    for (let i = 1; i < result.points.length; i += 1) {
      const span = result.points[i]! - result.points[i - 1]!;
      expect(bytesFor(span, bitrate)).toBeLessThanOrEqual(exact);
    }
  });

  it('produces parts that reconstruct the original length', () => {
    const { points } = verifiedCuts(2700, 3, silences, 96, 20 * MB);
    const total = points.slice(1).reduce((sum, end, i) => sum + (end - points[i]!), 0);
    expect(total).toBeCloseTo(2700, 5);
  });
});
