/**
 * What an error report may say about a failure, beyond its code.
 *
 * The code alone could not tell a phone that cannot compile the converter
 * from a connection that dropped halfway, and both sent `ffmpeg-load-failed`
 * eight times from the same person. These are the facts that tell them apart,
 * and none of them is content: an error's type, its message with anything
 * that looks like a file name dropped, how far a download got, and what class
 * of device it was.
 */

export type DiagnosticProps = Record<string, string | number | boolean>;

/** The same rule as the exception scrubber in public/analytics.js. */
const FILEISH =
  /\.(?:mp3|wav|m4a|m4p|m4b|aac|ogg|oga|opus|flac|weba|webm|mp4|m4v|mov|avi|mkv|wma|aif|aiff|amr|ape|ac3|dts|3gp|caf|aax|aa|m4r)\b/i;
const URLISH = /\b(?:blob|data|file):[^\s)"']+/gi;

/** Long enough for an engine's compile error, short enough to stay a label. */
const MESSAGE_LIMIT = 160;

/**
 * The error's type: `name` for an Error or DOMException, or the prefix of a
 * string such as the "RuntimeError: Aborted(...)" ffmpeg's worker posts.
 */
export function errorName(err: unknown): string {
  if (err === null || err === undefined) return String(err);
  const name = (err as { name?: unknown }).name;
  if (typeof name === 'string' && name) return name;
  if (typeof err === 'string') return /^([A-Za-z]*Error|[A-Za-z]*Exception)\b/.exec(err)?.[1] ?? 'string';
  return typeof err;
}

/**
 * The error's message with URLs to local data blanked, dropped whole when it
 * mentions a media file, and cut to a label's length.
 */
export function errorMessage(err: unknown): string {
  const raw =
    typeof err === 'string'
      ? err
      : typeof (err as { message?: unknown } | null)?.message === 'string'
        ? (err as { message: string }).message
        : '';
  const cleaned = raw.replace(URLISH, '<url>').replace(/\s+/g, ' ').trim();
  // A real filename has spaces in it, so no boundary marks where it starts;
  // the whole message goes, as the exception scrubber does.
  if (FILEISH.test(cleaned)) return '<redacted: possible filename>';
  return cleaned.length > MESSAGE_LIMIT ? `${cleaned.slice(0, MESSAGE_LIMIT - 1)}…` : cleaned;
}

/**
 * Coarse browser class. PostHog records the exact browser and OS already;
 * this is the bucket the converter's behaviour actually splits on, and it
 * survives a user agent PostHog fails to parse.
 */
export function browserClass(ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): string {
  const touchMac = /Macintosh/.test(ua) && typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 1;
  if (/iPhone|iPad|iPod/.test(ua) || touchMac) {
    // Every browser on iOS is WebKit underneath, whatever it calls itself.
    if (/CriOS/.test(ua)) return 'ios-chrome';
    if (/FxiOS/.test(ua)) return 'ios-firefox';
    if (/EdgiOS/.test(ua)) return 'ios-edge';
    return 'ios-safari';
  }
  if (/Android/.test(ua)) {
    if (/SamsungBrowser/.test(ua)) return 'android-samsung';
    if (/Firefox/.test(ua)) return 'android-firefox';
    if (/Chrome/.test(ua)) return 'android-chrome';
    return 'android-other';
  }
  if (/Edg\//.test(ua)) return 'desktop-edge';
  if (/Firefox\//.test(ua)) return 'desktop-firefox';
  if (/Chrome\//.test(ua)) return 'desktop-chrome';
  if (/Safari\//.test(ua)) return 'desktop-safari';
  return 'other';
}

/** The device facts every diagnostic carries. */
export function environment(): DiagnosticProps {
  const memory =
    typeof navigator === 'undefined'
      ? undefined
      : (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return {
    // Chromium only, in coarse steps of 0.25 to 8 GB; Safari never says.
    device_memory: typeof memory === 'number' ? memory : 'unknown',
    ua_class: browserClass(),
  };
}

/** Name and scrubbed message, plus the device facts. */
export function describeError(err: unknown): DiagnosticProps {
  return {
    error_name: errorName(err),
    error_message: errorMessage(err),
    ...environment(),
  };
}
