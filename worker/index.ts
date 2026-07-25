/**
 * The only server-side code on the site, and it exists for exactly one reason.
 *
 * The ffmpeg core is 30.7 MB and Cloudflare caps a single static asset at
 * 25 MiB, so it cannot ship with the other 250 files. It lives in R2 instead,
 * which has no egress charge at all, and this Worker serves it back under the
 * same `/ffmpeg/` path the browser already expects.
 *
 * Everything else, all 44 pages and every other asset, is served straight off
 * the edge by the asset layer without invoking this Worker. That is what
 * `run_worker_first` in wrangler.jsonc pins down: only `/ffmpeg/*` comes here.
 *
 * Serving it from our own origin rather than a public CDN is the point. The
 * privacy page says the converter is hosted here and no third party sees that
 * you asked for it, and that has to stay true.
 */

interface Env {
  FFMPEG: R2Bucket;
  ASSETS: Fetcher;
}

const PREFIX = '/ffmpeg/';

/**
 * Set explicitly rather than trusting what R2 stored.
 *
 * `application/wasm` is not cosmetic: `WebAssembly.instantiateStreaming` rejects
 * any other content type outright, so a wrong or missing one breaks every Tier 2
 * conversion with an error that looks nothing like its cause.
 */
function contentTypeFor(key: string): string {
  if (key.endsWith('.wasm')) return 'application/wasm';
  if (key.endsWith('.js') || key.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  return 'application/octet-stream';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Anything not under /ffmpeg/ should never reach here, but if the routing
    // config is ever changed the site must keep working rather than 404.
    if (!url.pathname.startsWith(PREFIX)) {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD' },
      });
    }

    const key = decodeURIComponent(url.pathname.slice(PREFIX.length));
    // No traversal, and no empty key listing the bucket.
    if (!key || key.includes('..')) {
      return new Response('Not found', { status: 404 });
    }

    // `onlyIf` lets R2 answer a revalidation without reading the body, which on
    // a 31 MB object is the difference between a 304 and a re-download.
    // `range` is what makes a resumable or partial fetch work.
    const object = await env.FFMPEG.get(key, {
      onlyIf: request.headers,
      range: request.headers,
    });

    if (!object) {
      return new Response('Not found', { status: 404 });
    }

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('content-type', contentTypeFor(key));
    // The path carries the core's version, so this can never go stale.
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    headers.set('cross-origin-resource-policy', 'same-origin');
    headers.set('x-content-type-options', 'nosniff');

    // A conditional request that matched has no body attached.
    if (!('body' in object) || object.body === null) {
      return new Response(null, { status: 304, headers });
    }

    // Only a request that actually asked for a range gets a 206. R2 fills in
    // `object.range` regardless, so trusting it alone answered every plain
    // download with 206 Partial Content, which is both wrong and the kind of
    // thing intermediate caches and instantiateStreaming refuse.
    const asked = request.headers.has('range');
    const ranged = asked && 'range' in object && object.range !== undefined;
    if (ranged) {
      const range = object.range as { offset?: number; length?: number };
      const offset = range.offset ?? 0;
      const length = range.length ?? object.size - offset;
      headers.set(
        'content-range',
        `bytes ${offset}-${offset + length - 1}/${object.size}`
      );
    } else {
      headers.set('content-length', String(object.size));
      headers.set('accept-ranges', 'bytes');
    }

    return new Response(request.method === 'HEAD' ? null : object.body, {
      status: ranged ? 206 : 200,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;
