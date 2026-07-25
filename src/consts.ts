export const SITE = {
  name: 'ihateaudio',
  url: 'https://ihateaudio.com',
  tagline: 'Audio tools that just work',
  description:
    "39 free audio tools that run right in your browser. Trim, convert, merge, boost, whatever you need. Nothing is uploaded and there is no signup.",
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
