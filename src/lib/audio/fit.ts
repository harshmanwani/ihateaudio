/**
 * The destination engine.
 *
 * One question, asked three times: this file is too big to send, now what?
 * Given a decoded buffer, the source file and somewhere to send it, this
 * returns every honest answer with the arithmetic already done.
 *
 * The judgement lives here rather than on the pages because the pages differ
 * only in their limits and their prose. It is also the one part worth testing
 * hard: a tool that promises a fit and hands back a file that bounces is worse
 * than no tool at all, so `partBytes <= budget` is the invariant everything
 * else is arranged around.
 */
import { bitratesFor, formatById, isInstant } from './export';

export type ContentKind = 'speech' | 'music';

/** A limit the user might actually be under. */
export interface Ceiling {
  id: string;
  label: string;
  bytes: number;
  /** Shown under the picker when this one is chosen. */
  note?: string;
}

/** The no-compression exit, where the destination has one. */
export interface Escape {
  title: string;
  reason: string;
  bytes: number;
}

export interface Destination {
  id: string;
  label: string;
  /** The one fact worth stating before a file exists. Stays true afterwards. */
  hint: string;
  ceilings: Ceiling[];
  /**
   * Codecs this destination will actually play, best-per-byte first. Kept to
   * two — the best one and the instant one — because a route list longer than
   * about four stops being a decision and starts being a form.
   */
  codecs: string[];
  /** Extensions that arrive playable, for deciding whether a file can go as-is. */
  plays: string[];
  /**
   * Byte-budget multiplier. Email's base64 inflation lives here rather than in
   * a special case, so 25 MB becomes an 18 MB budget through the same
   * arithmetic every other destination uses.
   */
  overhead: number;
  escape?: Escape;
}

const MB = 1024 * 1024;

const PLAYS_EVERYWHERE = ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'flac'];

export const DESTINATIONS: Record<string, Destination> = {
  whatsapp: {
    id: 'whatsapp',
    label: 'WhatsApp',
    hint: 'WhatsApp caps audio at 16 MB. Past that it has to get smaller, or arrive in pieces.',
    ceilings: [
      {
        id: 'media',
        label: 'Sent as audio, 16 MB',
        bytes: 16 * MB,
        note: 'The cap on anything that arrives as a message you can tap to play.',
      },
    ],
    codecs: ['opus', 'mp3'],
    plays: [...PLAYS_EVERYWHERE, 'amr', 'wma'],
    overhead: 1,
    escape: {
      title: 'Send it as a document',
      reason: 'Untouched, but arrives as a file card rather than a playable message.',
      bytes: 2 * 1024 * MB,
    },
  },

  discord: {
    id: 'discord',
    label: 'Discord',
    hint: "Your cap depends on your Nitro tier and on the server's boost level, so set it first.",
    // Ordered by how likely someone is to be on it, not by size: the free tier
    // is the default because it is what most people arriving here are stuck on.
    ceilings: [
      { id: 'free', label: 'Free, 10 MB', bytes: 10 * MB },
      {
        id: 'boost2',
        label: 'Server at boost level 2, 50 MB',
        bytes: 50 * MB,
        note: 'A boosted server raises the cap for everyone in it, whether or not they pay.',
      },
      { id: 'basic', label: 'Nitro Basic, 50 MB', bytes: 50 * MB },
      {
        id: 'boost3',
        label: 'Server at boost level 3, 100 MB',
        bytes: 100 * MB,
        note: 'A boosted server raises the cap for everyone in it, whether or not they pay.',
      },
      { id: 'nitro', label: 'Nitro, 500 MB', bytes: 500 * MB },
    ],
    codecs: ['opus', 'mp3'],
    plays: PLAYS_EVERYWHERE,
    overhead: 1,
  },

  email: {
    id: 'email',
    label: 'email',
    hint: 'Attachments are encoded on the way out, so the real ceiling is about a quarter below the advertised one.',
    ceilings: [
      { id: 'gmail', label: 'Gmail, 25 MB', bytes: 25 * MB },
      { id: 'outlook', label: 'Outlook, 20 MB', bytes: 20 * MB },
      {
        id: 'work',
        label: 'A work address, assume 10 MB',
        bytes: 10 * MB,
        note: 'Company mail servers are usually stricter than the big providers, and they rarely say so.',
      },
    ],
    // No Opus. It is the better codec, but a mail attachment gets opened by
    // whatever the recipient happens to have, and .opus is still the format
    // most likely to produce a shrug on a work laptop.
    codecs: ['m4a', 'mp3'],
    plays: PLAYS_EVERYWHERE,
    overhead: 1.37,
  },
};

/**
 * The bitrate below which a codec stops being worth sending.
 *
 * Speech figures assume mono. Folding to mono does not make a lossy file any
 * smaller — bitrate times duration is the whole story — but it lets the
 * encoder spend every bit on one channel, which is why speech survives so much
 * further down than music.
 */
const FLOOR: Record<string, Record<ContentKind, number>> = {
  opus: { speech: 32, music: 96 },
  m4a: { speech: 64, music: 96 },
  mp3: { speech: 64, music: 128 },
};

/** One step up from the floor: what a part gets encoded at when splitting. */
const COMFORTABLE: Record<string, Record<ContentKind, number>> = {
  opus: { speech: 48, music: 128 },
  m4a: { speech: 96, music: 128 },
  mp3: { speech: 96, music: 160 },
};

export type Quality = 'clean' | 'fine' | 'rough';

export interface Route {
  id: string;
  kind: 'asis' | 'single' | 'parts' | 'escape';
  /** Left-hand label, e.g. "One file · Opus 32k mono". */
  title: string;
  /** Right-hand column. Says *why* this is the pick, not what size it is. */
  reason: string;
  format: string;
  bitrate: number;
  mono: boolean;
  parts: number;
  totalBytes: number;
  partBytes: number;
  /** True when nothing has to be downloaded before this can run. */
  instant: boolean;
  quality: Quality;
}

export interface FitInput {
  seconds: number;
  sourceBytes: number;
  sourceExt: string;
  destination: Destination;
  ceiling: Ceiling;
  kind: ContentKind;
}

export interface Plan {
  budget: number;
  routes: Route[];
  /** Index into `routes`, or -1 when nothing honest fits. */
  recommended: number;
}

/**
 * Bytes a lossy encode of this length takes.
 *
 * Mirrors `estimateSize`'s lossy branch but takes a duration rather than a
 * buffer, so a part can be costed before the audio is sliced. The constant is
 * the larger of the two the encoders use (2048 rather than MP3's 512), because
 * every rounding decision in this file should err towards the file being
 * smaller than predicted rather than larger.
 */
export function bytesFor(seconds: number, bitrate: number): number {
  return Math.round((bitrate * 1000 * seconds) / 8) + 2048;
}

/**
 * The byte budget one file has to come in under.
 *
 * The 5% is headroom for container overhead, tags and the gap between our
 * estimate and what the encoder actually writes. Losing 5% of a limit is
 * invisible; exceeding it by 1% means the send fails.
 */
export function budgetFor(destination: Destination, ceiling: Ceiling): number {
  return Math.floor((ceiling.bytes / destination.overhead) * 0.95);
}

function qualityOf(format: string, bitrate: number, kind: ContentKind): Quality {
  const floor = FLOOR[format]?.[kind] ?? 96;
  const comfortable = COMFORTABLE[format]?.[kind] ?? 128;
  if (bitrate >= comfortable) return 'clean';
  if (bitrate >= floor) return 'fine';
  return 'rough';
}

function describe(format: string, bitrate: number, mono: boolean, parts: number): string {
  const label = formatById(format).label.replace(' (AAC)', '');
  const channels = mono ? ' mono' : '';
  const head = parts === 1 ? 'One file' : `${parts} parts`;
  return `${head} · ${label} ${bitrate}k${channels}`;
}

/**
 * Every honest answer, ranked, with the recommendation already picked.
 *
 * Routes are generated per codec rather than globally so that the list always
 * contains at least one thing that needs no download, however much better the
 * other one is.
 */
export function planFor(input: FitInput): Plan {
  const { seconds, sourceBytes, sourceExt, destination, ceiling, kind } = input;
  const budget = budgetFor(destination, ceiling);
  const mono = kind === 'speech';
  const routes: Route[] = [];

  // Nobody builds this case and everybody hits it.
  if (sourceBytes <= budget && destination.plays.includes(sourceExt.toLowerCase())) {
    routes.push({
      id: 'asis',
      kind: 'asis',
      title: 'Send it as it is',
      reason: 'Already small enough. Nothing needs doing.',
      format: sourceExt,
      bitrate: 0,
      mono: false,
      parts: 1,
      totalBytes: sourceBytes,
      partBytes: sourceBytes,
      instant: true,
      quality: 'clean',
    });
  }

  for (const format of destination.codecs) {
    const ladder = bitratesFor(format);
    const instant = isInstant(format);
    const comfortable = COMFORTABLE[format]?.[kind] ?? 128;

    /*
     * Having room to spare is not a reason to use it. Past the comfortable
     * bitrate the extra bits buy nothing audible on this kind of material, so
     * a short voice memo that would technically fit at 320 kbps gets 128
     * instead — one step of headroom above comfortable, then stop. Without
     * this the tool hands someone a 7 MB file for three minutes of speech and
     * calls it the best option.
     */
    const at = ladder.findIndex((rate) => rate >= comfortable);
    const cap = at === -1 ? ladder.length - 1 : Math.min(ladder.length - 1, at + 1);

    // Highest sensible bitrate that still fits in one file. Walked downward so
    // the first hit is the best one rather than merely a working one.
    let single: number | null = null;
    for (let i = cap; i >= 0; i -= 1) {
      const bitrate = ladder[i]!;
      if (bytesFor(seconds, bitrate) <= budget) {
        single = bitrate;
        break;
      }
    }

    if (single !== null) {
      const bytes = bytesFor(seconds, single);
      routes.push({
        id: `${format}-single`,
        kind: 'single',
        title: describe(format, single, mono, 1),
        reason: '',
        format,
        bitrate: single,
        mono,
        parts: 1,
        totalBytes: bytes,
        partBytes: bytes,
        instant,
        quality: qualityOf(format, single, kind),
      });
    }

    // Splitting is the "I refuse to sacrifice quality" answer, so it is always
    // costed at the comfortable bitrate and takes however many files that needs.
    const total = bytesFor(seconds, comfortable);
    const parts = Math.max(1, Math.ceil(total / budget));
    if (parts > 1) {
      routes.push({
        id: `${format}-parts`,
        kind: 'parts',
        title: describe(format, comfortable, mono, parts),
        reason: '',
        format,
        bitrate: comfortable,
        mono,
        parts,
        totalBytes: total,
        partBytes: Math.ceil(total / parts),
        instant,
        quality: 'clean',
      });
    }
  }

  if (destination.escape && sourceBytes <= destination.escape.bytes) {
    routes.push({
      id: 'escape',
      kind: 'escape',
      title: destination.escape.title,
      reason: destination.escape.reason,
      format: sourceExt,
      bitrate: 0,
      mono: false,
      parts: 1,
      totalBytes: sourceBytes,
      partBytes: sourceBytes,
      instant: true,
      quality: 'clean',
    });
  }

  const recommended = pick(routes);
  explain(routes, recommended);
  return { budget, routes, recommended };
}

/**
 * Fewest files wins.
 *
 * Ties break towards whatever needs no download, which is what makes the
 * default vary sensibly with length: a short file fits MP3 in one go and stays
 * instant, while a long one only earns the 31 MB converter because it is the
 * only way to avoid arriving in pieces.
 */
function pick(routes: Route[]): number {
  const asis = routes.findIndex((route) => route.kind === 'asis');
  if (asis !== -1) return asis;

  const rank = { clean: 2, fine: 1, rough: 0 } as const;
  let best = -1;

  routes.forEach((route, index) => {
    if (route.kind !== 'single' && route.kind !== 'parts') return;
    if (route.quality === 'rough') return;
    if (best === -1) {
      best = index;
      return;
    }
    const champion = routes[best]!;
    if (route.parts !== champion.parts) {
      if (route.parts < champion.parts) best = index;
      return;
    }
    if (route.instant !== champion.instant) {
      if (route.instant) best = index;
      return;
    }
    if (rank[route.quality] > rank[champion.quality]) best = index;
  });

  return best;
}

/**
 * Fills in the reason column.
 *
 * Done after ranking because the honest reason for a route depends on what it
 * beat. "The only way this fits in one file" is only true if nothing else
 * managed one, and claiming it otherwise would be the kind of small lie that
 * makes the whole verdict untrustworthy.
 */
function explain(routes: Route[], recommended: number): void {
  const processed = routes.filter((r) => r.kind === 'single' || r.kind === 'parts');
  const singles = processed.filter((r) => r.parts === 1 && r.quality !== 'rough');
  const instantSingleExists = singles.some((r) => r.instant);
  // The smallest thing available without a download, to compare a paid-for
  // codec against. Often the two land on the same bitrate and therefore the
  // same byte count, in which case the better codec buys quality, not size —
  // and saying "smaller" there would be a plain untruth.
  const instantSingle = singles
    .filter((route) => route.instant)
    .sort((a, b) => a.totalBytes - b.totalBytes)[0];

  for (const route of routes) {
    if (route.reason) continue;

    if (route.quality === 'rough') {
      route.reason = 'Fits, but this low it will sound rough.';
      continue;
    }

    if (route.parts === 1) {
      if (!route.instant && !instantSingleExists) {
        route.reason = 'The only way this fits in one file.';
      } else if (route.instant) {
        route.reason = 'Fits in one file, nothing to download.';
      } else if (instantSingle && route.totalBytes < instantSingle.totalBytes * 0.9) {
        route.reason = 'Smaller, but downloads a converter first.';
      } else {
        route.reason = 'Sounds better at the same size, after a one-time download.';
      }
      continue;
    }

    route.reason = route.instant
      ? `Nothing to download, but arrives as ${route.parts} files.`
      : `Sounds better, but arrives as ${route.parts} files.`;
  }

  const winner = routes[recommended];
  if (winner && winner.kind === 'parts') {
    winner.reason = `Nothing fits in one file. ${winner.parts} parts, cut at pauses.`;
  }
}

/**
 * Where to cut, in seconds, so that no part exceeds the budget.
 *
 * Boundaries start out evenly spaced and then slide to the nearest real pause,
 * which is the difference between a tool that splits a file and a tool that
 * solves the problem — nobody wants part two to open mid-word. A boundary only
 * moves if a pause is close enough that the parts stay roughly even.
 */
export function cutPoints(
  seconds: number,
  parts: number,
  silences: { start: number; end: number }[]
): { points: number[]; snapped: number } {
  if (parts <= 1) return { points: [0, seconds], snapped: 0 };

  const span = seconds / parts;
  const reach = Math.min(span * 0.08, 45);
  const points = [0];
  let snapped = 0;

  for (let i = 1; i < parts; i += 1) {
    const nominal = (seconds * i) / parts;
    let best: number | null = null;
    let bestLength = 0;

    for (const region of silences) {
      const middle = (region.start + region.end) / 2;
      if (Math.abs(middle - nominal) > reach) continue;
      const length = region.end - region.start;
      if (length > bestLength) {
        bestLength = length;
        best = middle;
      }
    }

    // Never let a snap cross its neighbour; an out-of-order cut list would
    // produce a negative-length part.
    const previous = points[points.length - 1]!;
    const chosen = best !== null && best > previous + 0.5 ? best : nominal;
    if (best !== null && chosen === best) snapped += 1;
    points.push(chosen);
  }

  points.push(seconds);
  return { points, snapped };
}

/**
 * Cut points that are guaranteed to fit, rather than merely likely to.
 *
 * Snapping to a pause moves a boundary by up to 8% of a part's length, so two
 * boundaries drifting apart can leave the part between them over budget even
 * though the even split was comfortably under. Bumping the count and trying
 * again is cheaper than being clever, and it keeps the one promise this tool
 * makes: every file it hands back is small enough to send.
 */
export function verifiedCuts(
  seconds: number,
  parts: number,
  silences: { start: number; end: number }[],
  bitrate: number,
  budget: number
): { points: number[]; snapped: number; parts: number } {
  let count = Math.max(1, parts);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { points, snapped } = cutPoints(seconds, count, silences);
    const fits = points
      .slice(1)
      .every((end, index) => bytesFor(end - points[index]!, bitrate) <= budget);
    if (fits) return { points, snapped, parts: count };
    count += 1;
  }

  // Even cuts at this count fit by construction, having only grown from a
  // count that already did.
  const even = [];
  for (let i = 0; i <= count; i += 1) even.push((seconds * i) / count);
  return { points: even, snapped: 0, parts: count };
}
