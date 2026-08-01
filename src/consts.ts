import { TOOLS } from './data/tools';

/**
 * How many tools a visitor can actually reach, counted rather than typed.
 *
 * The number used to be written by hand into the site description, the README
 * and the launch copy, and it had drifted seven behind the registry before
 * anyone noticed. Deriving it means adding a tool updates every place that
 * quotes it, and the number can never be wrong again.
 */
export const TOOL_COUNT = TOOLS.filter((tool) => !tool.secondary).length;

export const SITE = {
  name: 'ihateaudio',
  url: 'https://ihateaudio.com',
  tagline: 'Audio tools that just work',
  description: `${TOOL_COUNT} free audio tools that run right in your browser. Trim, convert, merge, boost, whatever you need. Nothing is uploaded and there is no signup.`,
  locale: 'en',
  email: 'support@ihateaudio.com',
} as const;

/**
 * Analytics, all optional and all read from the environment at build time.
 *
 * Nothing is emitted when a value is missing, which is what keeps local dev and
 * the test suite free of third-party network calls. Set these in the Cloudflare
 * Pages dashboard; the PUBLIC_ prefix is what makes Astro inline them.
 */
export const ANALYTICS = {
  /** GA4 measurement id, e.g. G-XXXXXXXXXX. */
  ga: import.meta.env.PUBLIC_GA_ID ?? '',
  /** PostHog project key, the phc_... one. Safe to ship publicly. */
  posthogKey: import.meta.env.PUBLIC_POSTHOG_KEY ?? '',
  /** Reverse proxy on our own domain, so ad blockers do not eat every event. */
  posthogHost: import.meta.env.PUBLIC_POSTHOG_HOST ?? 'https://a.tenmiracle.com',
  /** The token from Search Console's HTML-tag verification method. */
  googleVerification: import.meta.env.PUBLIC_GOOGLE_VERIFICATION ?? '',
} as const;

/** Repeated verbatim across the site because it is the actual differentiator. */
export const PRIVACY_LINE = 'Your file stays on your device. Always.';
