/**
 * The only server-side code on the site, and it exists to serve large binaries
 * that cannot ship as static assets.
 *
 * Two things live in R2 rather than in `dist`:
 *
 *   - the ffmpeg core, 30.7 MB, because Cloudflare caps a single static asset at
 *     25 MiB and the deploy fails outright above it,
 *   - the AI models, 64 MB for the separation network and 43 MB for Whisper,
 *     which are far past that cap and which most visitors will never ask for.
 *
 * Everything else — every page and every other asset — is served straight off the
 * edge without invoking this Worker at all. That is what `run_worker_first` in
 * wrangler.jsonc pins down.
 *
 * Serving these from our own origin rather than a public CDN or huggingface.co is
 * the whole point. The privacy page says your audio never leaves the device and
 * that no third party learns which tool you opened, and that has to stay true of
 * the model download too, not only of the audio.
 */

interface Env {
  FFMPEG: R2Bucket;
  MODELS: R2Bucket;
  ASSETS: Fetcher;
}

/** Path prefix to the bucket that backs it. */
const ROUTES: { prefix: string; bucket: 'FFMPEG' | 'MODELS' }[] = [
  { prefix: '/ffmpeg/', bucket: 'FFMPEG' },
  { prefix: '/models/', bucket: 'MODELS' },
];

/**
 * Content types are set here rather than trusted from R2's stored metadata.
 *
 * `application/wasm` is not cosmetic: `WebAssembly.instantiateStreaming` rejects
 * any other type outright, and the resulting failure looks nothing like its cause.
 * The JSON types matter less, but a wrong one on tokenizer.json makes
 * transformers.js fail in its own equally opaque way.
 */
function contentTypeFor(key: string): string {
  if (key.endsWith('.wasm')) return 'application/wasm';
  if (key.endsWith('.js') || key.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (key.endsWith('.json')) return 'application/json; charset=utf-8';
  if (key.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/**
 * True when the client is revalidating or asking for a slice.
 *
 * These skip the edge cache and go to R2 deliberately. R2 answers a conditional
 * request without reading the body at all, so revalidating a 64 MB object costs
 * one cheap operation and returns an empty 304 — there is nothing the edge cache
 * could usefully add. Handing such a request to `cache.match` would instead find
 * the cached 200 and re-send all 64 MB, turning a free revalidation into a full
 * download.
 */
function isConditionalOrPartial(request: Request): boolean {
  const h = request.headers;
  return (
    h.has('range') || h.has('if-none-match') || h.has('if-modified-since') || h.has('if-range')
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const route = ROUTES.find((r) => url.pathname.startsWith(r.prefix));

    // Anything else should never reach here, but if the routing config is ever
    // changed the site must keep working rather than 404 every page.
    if (!route) return env.ASSETS.fetch(request);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { Allow: 'GET, HEAD' },
      });
    }

    // Worker responses bypass Cloudflare's normal cache, so without this every
    // cold load of the 30 MB core or the 64 MB model reads from R2 in whichever
    // region the bucket lives. Egress from R2 is free, so this is about latency
    // rather than cost: a visitor in Sydney should not be pulling 64 MB across
    // the Pacific because the bucket happens to sit in North America.
    const cache = caches.default;
    const cacheable = request.method === 'GET' && !isConditionalOrPartial(request);
    if (cacheable) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }

    const key = decodeURIComponent(url.pathname.slice(route.prefix.length));
    // No traversal, and no empty key listing the bucket.
    if (!key || key.includes('..')) {
      return new Response('Not found', { status: 404 });
    }

    // `onlyIf` lets R2 answer a revalidation without reading the body, which on a
    // 64 MB object is the difference between a 304 and a re-download. `range` is
    // what makes a resumable or partial fetch work.
    const object = await env[route.bucket].get(key, {
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
    // Every path under here carries a version, so this can never go stale.
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

    const response = new Response(request.method === 'HEAD' ? null : object.body, {
      status: ranged ? 206 : 200,
      headers,
    });

    if (cacheable && response.status === 200) {
      // Clone before the client consumes the body, and let the put finish after
      // the response has gone out rather than delaying it.
      ctx.waitUntil(cache.put(request, response.clone()));
    }

    return response;
  },
} satisfies ExportedHandler<Env>;
