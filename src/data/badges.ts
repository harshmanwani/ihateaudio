/**
 * Directory badges: the "Featured on" strip at the bottom of the homepage.
 *
 * Most free launch directories grant the listing (and the dofollow link back)
 * only while their badge sits on our homepage, and they verify it by fetching
 * the page and looking for their own URLs. So the strip is server-rendered
 * HTML, never injected by script: a verifier that does not run JavaScript has
 * to find the anchor and the image in the raw response.
 *
 * Learned on Supercut and SuperMailOS, worth knowing before changing this:
 *
 *  1. Keep `href` and the image URL exactly as the directory hands them out.
 *     ScrollLaunch, LaunchPact and Startup Fame grep for their own image URL, so
 *     a proxied or self-hosted copy fails the check even though it is visible.
 *  2. Some directories require rel to be exactly "noopener": "noreferrer" hides
 *     the Referer they attribute with. Never add nofollow, sponsored or ugc; the
 *     dofollow link is the whole point of the trade.
 *  3. Every badge image host must be in img-src in public/_headers, or the CSP
 *     blocks it and the strip shows broken images. scripts/check-csp.mjs fails
 *     the build when one is missing.
 *  4. A platform that publishes an exact snippet (an anchor with inline styles,
 *     or specific attributes) goes in `exactHtml`, rendered byte for byte.
 *
 * Only add a badge once the listing is live. An empty list renders nothing, so
 * the homepage never shows a "Featured on" heading with no proof under it.
 *
 * TO ADD ONE: append here, add the image host to img-src, rebuild.
 */

interface BadgeBase {
  /** Short id, also used as a stable key. */
  id: string;
  /** Display name, used for the alt text and the title. */
  platform: string;
  /** Day the listing went live, YYYY-MM-DD. */
  since: string;
}

export interface ImageBadge extends BadgeBase {
  kind: 'image';
  /** The listing page the badge links to, exactly as the directory gives it. */
  href: string;
  /** The directory's own badge image URL, exactly as given. */
  src: string;
  alt: string;
  width: number;
  height: number;
  /** Override the default rel of "noopener" when a directory asks for another. */
  rel?: string;
}

export interface HtmlBadge extends BadgeBase {
  kind: 'html';
  /** The directory's snippet, rendered verbatim. */
  exactHtml: string;
}

export type DirectoryBadge = ImageBadge | HtmlBadge;

export const DIRECTORY_BADGES: DirectoryBadge[] = [
  {
    // Free listing in exchange for this link on the homepage; "Verify" on their
    // side fetches the page and looks for it. Their snippet, byte for byte.
    kind: 'html',
    id: 'twelvetools',
    platform: 'Twelve Tools',
    since: '2026-10-13',
    exactHtml:
      '<a href="https://twelve.tools" target="_blank"><img src="https://twelve.tools/badge1-light.svg" alt="Featured on Twelve Tools" width="148" height="40"></a>',
  },
];
