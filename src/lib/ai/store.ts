/**
 * Fetching model weights once and keeping them.
 *
 * These files are 30 to 64 MB each, so "download it again" is not an acceptable
 * answer to anything. Three layers stop that happening:
 *
 *   - Cache Storage, keyed by the versioned URL, which survives reloads and
 *     browser restarts and is what makes the second visit instant.
 *   - The HTTP cache underneath it, since the Worker serves these immutable.
 *   - An in-memory map, so two tools on the same page share one ArrayBuffer
 *     rather than each holding 64 MB.
 *
 * Progress is reported from the response stream rather than from a spinner,
 * because a 64 MB download on a phone is a minute of someone's life and a
 * percentage is the difference between waiting and leaving.
 */
import { MODELS_VERSION } from './models';

/** Cache Storage bucket. Bumping this abandons every previously stored model. */
const CACHE_NAME = `ihateaudio-models-${MODELS_VERSION}`;

export interface FetchProgress {
  /** Bytes received so far. */
  loaded: number;
  /** Total bytes expected. Known up front from the catalogue. */
  total: number;
  /** True once the bytes are in hand and only verification remains. */
  verifying?: boolean;
}

export interface ModelAsset {
  /** Object name under `/models/<version>/`. */
  file: string;
  bytes: number;
  /** Expected SHA-256, lower-case hex. Omitted for the small Whisper metadata. */
  sha256?: string;
}

export interface FetchOptions {
  onProgress?: (progress: FetchProgress) => void;
  signal?: AbortSignal;
}

export function modelUrl(file: string): string {
  return `/models/${MODELS_VERSION}/${file}`;
}

/**
 * Shared per-URL results, so two tools asking for the same weights on one page
 * get one download and one copy in memory.
 *
 * Holding the promise rather than the buffer also collapses concurrent requests:
 * the stem splitter asking for four models at once must not start the same fetch
 * twice.
 */
const inFlight = new Map<string, Promise<ArrayBuffer>>();

async function openCache(): Promise<Cache | null> {
  // Cache Storage is unavailable in a few real situations — Firefox private
  // windows throw on open, and any non-secure context lacks it entirely. None of
  // those should stop the tool working; they just mean paying the download again.
  try {
    if (typeof caches === 'undefined') return null;
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Checks the bytes are the bytes we asked for.
 *
 * Worth the second or so it costs on 64 MB. A truncated or corrupted model does
 * not announce itself: ONNX Runtime fails somewhere inside its own protobuf
 * parser with a message that sends you looking for a bug in the audio code. This
 * turns that into one clear sentence, and it is also the only thing standing
 * between a visitor and a tampered model if the transport is ever compromised.
 */
async function verify(bytes: ArrayBuffer, expected: string, file: string): Promise<void> {
  if (typeof crypto?.subtle?.digest !== 'function') return;
  const actual = toHex(await crypto.subtle.digest('SHA-256', bytes));
  if (actual !== expected) {
    throw new Error(
      `${file} did not download correctly (checksum mismatch). ` +
        'Check your connection and try again.'
    );
  }
}

/**
 * Reads a response body while reporting progress.
 *
 * `content-length` is preferred when present but the catalogue's figure is the
 * fallback, because a compressed response reports the compressed length and these
 * are already-compressed binaries served without further encoding.
 */
async function readWithProgress(
  response: Response,
  expectedBytes: number,
  options: FetchOptions
): Promise<ArrayBuffer> {
  const body = response.body;
  const declared = Number(response.headers.get('content-length')) || expectedBytes;

  // No stream to read means no progress to report, which is fine — this is the
  // path a Cache Storage hit takes, and it returns immediately.
  if (!body) return response.arrayBuffer();

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;

  try {
    for (;;) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        loaded += value.byteLength;
        options.onProgress?.({ loaded, total: declared });
      }
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  }

  const out = new Uint8Array(loaded);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

/**
 * Returns the model's bytes, downloading them only if they are not already held.
 *
 * Resolves to the same ArrayBuffer for repeated calls within a page, so callers
 * must not transfer or mutate it. The separation worker receives a copy instead.
 */
export async function loadModel(
  asset: ModelAsset,
  options: FetchOptions = {}
): Promise<ArrayBuffer> {
  const url = modelUrl(asset.file);

  const existing = inFlight.get(url);
  if (existing) return existing;

  const work = (async (): Promise<ArrayBuffer> => {
    const cache = await openCache();

    if (cache) {
      const hit = await cache.match(url);
      if (hit) {
        const bytes = await hit.arrayBuffer();
        // A cached entry of the wrong size is a partial write from an interrupted
        // session. Drop it and fetch again rather than handing ORT a truncated
        // model.
        if (!asset.bytes || bytes.byteLength === asset.bytes) {
          options.onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength });
          return bytes;
        }
        await cache.delete(url).catch(() => {});
      }
    }

    const response = await fetch(url, { signal: options.signal });
    if (!response.ok) {
      throw new Error(`Could not download ${asset.file} (HTTP ${response.status}).`);
    }

    const bytes = await readWithProgress(response, asset.bytes, options);

    if (asset.sha256) {
      options.onProgress?.({ loaded: bytes.byteLength, total: bytes.byteLength, verifying: true });
      await verify(bytes, asset.sha256, asset.file);
    }

    if (cache) {
      // Storing can fail on a full disk or a tight quota. That is survivable —
      // the tool still works, it just pays the download again next time — so it
      // must not take the whole run down with it.
      await cache.put(url, new Response(bytes.slice(0))).catch(() => {});
    }

    return bytes;
  })();

  inFlight.set(url, work);
  try {
    return await work;
  } catch (error) {
    // A failed attempt must not be remembered, or a retry resolves to the same
    // rejection forever.
    inFlight.delete(url);
    throw error;
  }
}

/**
 * Whether every asset is already stored, so the UI can skip the setup panel
 * instead of flashing it for a tenth of a second.
 */
export async function isReady(assets: ModelAsset[]): Promise<boolean> {
  const cache = await openCache();
  if (!cache) return false;
  for (const asset of assets) {
    if (inFlight.has(modelUrl(asset.file))) continue;
    const hit = await cache.match(modelUrl(asset.file));
    if (!hit) return false;
  }
  return true;
}

/** Bytes still to fetch, for the setup panel's "this will download N MB". */
export async function outstandingBytes(assets: ModelAsset[]): Promise<number> {
  const cache = await openCache();
  let total = 0;
  for (const asset of assets) {
    if (cache && (await cache.match(modelUrl(asset.file)))) continue;
    total += asset.bytes;
  }
  return total;
}

/** Forgets every stored model. Offered on the privacy page. */
export async function clearStoredModels(): Promise<void> {
  inFlight.clear();
  if (typeof caches === 'undefined') return;
  await caches.delete(CACHE_NAME).catch(() => {});
}
