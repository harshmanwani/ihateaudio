/**
 * Product events.
 *
 * Deliberately narrow. Everything sent from here is either the tool's own slug
 * or a value the user picked from a fixed list of options, plus one coarse
 * duration bucket. Never a filename, never a file size, never anything typed.
 * A file is content, and the whole product is built on not touching it.
 *
 * The one thing this has to answer, six months from now, is "which tools do
 * people actually finish, and where do they give up".
 */

type Props = Record<string, string | number | boolean>;

interface Analytics {
  posthog?: { capture?: (event: string, props?: Props) => void };
  gtag?: (command: string, event: string, props?: Props) => void;
}

/**
 * Buckets, not values. A duration in seconds is a weak fingerprint; "2 to 10
 * minutes" answers the same product question and is not.
 */
export function durationBucket(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'unknown';
  if (seconds < 30) return 'under 30s';
  if (seconds < 120) return '30s to 2m';
  if (seconds < 600) return '2m to 10m';
  if (seconds < 3600) return '10m to 1h';
  return 'over 1h';
}

export function track(event: string, props: Props = {}): void {
  if (typeof window === 'undefined') return;

  const slug = document
    .querySelector('[data-tool]')
    ?.getAttribute('data-slug');

  const payload: Props = slug ? { tool: slug, ...props } : { ...props };

  const w = window as unknown as Analytics;
  try {
    w.posthog?.capture?.(event, payload);
    // GA4 event names allow letters, digits and underscores only.
    w.gtag?.('event', event.replace(/[^a-z0-9_]/gi, '_'), payload);
  } catch {
    /* Measurement must never be able to break a tool. */
  }
}
