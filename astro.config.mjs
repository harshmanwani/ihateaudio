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
