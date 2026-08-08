// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://ihateaudio.com',

  // Static output: every tool page is a real HTML document Google can read,
  // and the whole site drops onto any CDN with no server behind it.
  output: 'static',

  build: {
    // Inlines small stylesheets, avoiding an extra round trip on first paint.
    inlineStylesheets: 'auto',
  },

  vite: {
    css: {
      // Every colour token is authored in `oklch()`, and `oklch()` landed in
      // Chrome 111. Without a target list nothing is down-levelled, so on an
      // older browser each token holds text the parser cannot read, every
      // `color: var(--ink)` is invalid at computed-value time, and the whole
      // palette falls back to initial values — black text, transparent
      // backgrounds, no buttons. Verified on a real Chromium 109: the layout
      // was intact and every colour was gone.
      //
      // Naming the browsers makes Lightning CSS emit an sRGB fallback ahead of
      // each modern declaration and wrap the wide-gamut custom properties in
      // `@supports`, so current browsers still get the authored colour. The
      // floor is set from what actually visits: Chrome 102 and 109 both appear
      // in analytics, and Chrome 109 is the terminal version for Windows 7, 8
      // and 8.1, so that tail does not age out on its own.
      transformer: 'lightningcss',
      lightningcss: {
        // Lightning CSS encodes a version as major << 16 | minor << 8.
        targets: {
          chrome: 102 << 16,
          edge: 102 << 16,
          firefox: 102 << 16,
          safari: (15 << 16) | (0 << 8),
        },
      },
    },

    // @ffmpeg/ffmpeg must NOT be excluded from dep optimization. It creates its
    // worker with `new Worker(new URL('./worker.js', import.meta.url))`, and
    // Vite can only rewrite that to a real emitted chunk if it processes the
    // dependency. Excluding it yields a blob worker that is aborted on load,
    // and every Tier 2 conversion fails with "the converter couldn't load".
    build: {
      // The audio engine is the only real JS on the site. Keeping chunks
      // separate lets a tool page load just the modules it uses.
      chunkSizeWarningLimit: 700,

      // Never inline a script into the HTML.
      //
      // Astro inlines small hoisted scripts by default, and the Content Security
      // Policy in public/_headers has no 'unsafe-inline' for script-src, so the
      // browser blocked every one of them. On the live site that silently killed
      // the dropzone's "Choose file" button, the service worker registration,
      // the all-tools menu and the install card. `astro dev` does not apply
      // _headers, which is why it only showed up when served through wrangler.
      //
      // The alternative would be loosening the CSP, which is the wrong trade on
      // a site whose whole promise is that your file never leaves the device.
      assetsInlineLimit: 0,
    },

    // Worker format is left at Vite's default. @ffmpeg/ffmpeg spawns its own
    // worker with { type: 'module' } regardless, which is why the ESM ffmpeg
    // core is the one that gets shipped — see scripts/sync-ffmpeg-core.mjs.
  },
});
