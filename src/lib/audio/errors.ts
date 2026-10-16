/**
 * Every failure a tool can surface, with copy attached.
 *
 * Real audio files break in strange ways — variable-bitrate MP3s with bad
 * headers, DRM'd M4A from iTunes, four-hour Zoom recordings, WhatsApp Opus in
 * exotic configurations. A tool that says exactly what went wrong beats a tool
 * that spins forever, so every throw site uses one of these.
 */
export type AudioErrorCode =
  | 'unsupported-format'
  | 'decode-failed'
  | 'drm-protected'
  | 'empty-file'
  | 'too-large'
  | 'too-long'
  | 'out-of-memory'
  | 'no-audio-track'
  | 'encode-failed'
  | 'ffmpeg-load-failed'
  | 'model-load-failed'
  | 'cancelled'
  | 'unknown-error';

/**
 * Coarse facts about a failure, sent alongside the code with `tool_error`.
 *
 * The code alone says *that* something failed, which is not enough to act on:
 * 'ffmpeg-load-failed' and 'unknown-error' each stand for several unrelated
 * causes. Every value here is a token chosen by our own code (a stage name, an
 * allow-listed error name, a flag) and never text lifted from a message, because
 * a message can contain a filename.
 */
export type AudioErrorDetail = Record<string, string | number | boolean>;

export class AudioError extends Error {
  readonly code: AudioErrorCode;
  /** What the user should actually do next. Rendered under the message. */
  readonly fix: string;
  /** Diagnostic tokens for analytics. Never shown to the user. */
  readonly detail: AudioErrorDetail;

  constructor(code: AudioErrorCode, message: string, fix: string, detail: AudioErrorDetail = {}) {
    super(message);
    this.name = 'AudioError';
    this.code = code;
    this.fix = fix;
    this.detail = detail;
  }
}

const COPY: Record<AudioErrorCode, { message: string; fix: string }> = {
  'unsupported-format': {
    message: "This browser can't read that file type.",
    fix: 'Try converting it to MP3 or WAV first, or open this page in Chrome or Firefox.',
  },
  'decode-failed': {
    message: "The file couldn't be decoded.",
    fix: 'It may be corrupted or only partly downloaded. Try re-exporting or re-downloading the original.',
  },
  'drm-protected': {
    message: 'This file is copy-protected.',
    fix: 'Purchased iTunes and Apple Music tracks are encrypted and cannot be edited by any browser tool.',
  },
  'empty-file': {
    message: 'That file is empty.',
    fix: 'Check the file transferred completely, then drop it again.',
  },
  'too-large': {
    message: 'That file is too large for this device.',
    fix: 'Phones run out of memory faster than laptops. Try a shorter file, or the same file on a desktop.',
  },
  'too-long': {
    message: 'That recording is too long to hold in memory.',
    fix: 'Split it into shorter parts first, then process each part.',
  },
  'out-of-memory': {
    message: 'The browser ran out of memory.',
    fix: 'Close other tabs and try again, or use a shorter file.',
  },
  'no-audio-track': {
    message: "That file doesn't contain any audio.",
    fix: 'If it is a video, check it actually has a soundtrack.',
  },
  'encode-failed': {
    message: 'Something went wrong while writing the output file.',
    fix: 'Try a different output format — WAV is the most reliable.',
  },
  'ffmpeg-load-failed': {
    message: "The converter couldn't load.",
    fix: 'Check your connection and reload the page. Nothing is uploaded — only the converter code is downloaded.',
  },
  'model-load-failed': {
    message: "The AI model couldn't load.",
    fix: 'Check your connection and reload the page. Nothing is uploaded — only the model is downloaded.',
  },
  cancelled: {
    message: 'Cancelled.',
    fix: 'Nothing was changed.',
  },
  'unknown-error': {
    message: 'Something went wrong processing that file.',
    fix: 'Try a different file, or reload the page and try once more.',
  },
};

/** Builds a known error with its standard copy, optionally overriding the fix. */
export function audioError(
  code: AudioErrorCode,
  fix?: string,
  detail?: AudioErrorDetail
): AudioError {
  const copy = COPY[code];
  return new AudioError(code, copy.message, fix ?? copy.fix, detail);
}

/**
 * Error names that are safe to report. An allow-list rather than "whatever
 * `name` says", so nothing a page or a library invents can reach analytics.
 */
const CAUSE_NAMES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  // WebAssembly.
  'RuntimeError',
  'CompileError',
  'LinkError',
  // DOMException names that show up around fetch, workers and storage.
  'NetworkError',
  'AbortError',
  'SecurityError',
  'NotSupportedError',
  'NotAllowedError',
  'InvalidStateError',
  'QuotaExceededError',
  'DataCloneError',
  'EncodingError',
]);

function knownName(text: string): string | null {
  const found = /\b([A-Za-z]+Error)\b/.exec(text)?.[1];
  return found && CAUSE_NAMES.has(found) ? found : null;
}

/**
 * Names what a thrown value was, without keeping what it said.
 *
 * ffmpeg.wasm rejects with the *string* its worker produced from
 * `error.toString()`, so the useful part ("RuntimeError", "CompileError") is the
 * front of a message rather than a `name`. Both shapes are handled, and the
 * result is always one of a fixed set of tokens: an allow-listed error name, or
 * one of the ffmpeg.wasm / emscripten failures recognised below. A message is
 * matched against, never copied.
 */
export function causeOf(err: unknown): string {
  let name = '';
  let text = '';
  if (typeof err === 'string') {
    text = err;
  } else if (err && typeof err === 'object') {
    const shape = err as { name?: unknown; message?: unknown };
    if (typeof shape.name === 'string') name = shape.name;
    if (typeof shape.message === 'string') text = shape.message;
  }
  text = text.slice(0, 300);

  // The ffmpeg.wasm worker could not import the core script at all.
  if (/failed to import ffmpeg-core/i.test(text)) return 'import-failure';
  if (/terminate\(\)/.test(text)) return 'terminated';
  if (/ffmpeg is not loaded/i.test(text)) return 'not-loaded';
  // emscripten wraps a fatal error as Aborted(<what happened>); the name worth
  // keeping is the one inside the brackets.
  const aborted = /\babort(?:ed)?\(([\s\S]*)/i.exec(text);
  if (aborted) {
    const inner = knownName(aborted[1]);
    return inner ? `wasm-abort:${inner}` : 'wasm-abort';
  }

  if (CAUSE_NAMES.has(name) && name !== 'Error') return name;
  // A bare Error, or a string: the real name is at the front of the text.
  const leading = /^(?:Uncaught\s+)?([A-Za-z]+Error)\b/.exec(text)?.[1];
  if (leading && CAUSE_NAMES.has(leading)) return leading;
  return name === 'Error' ? 'Error' : 'other';
}

/** Normalises anything thrown into an AudioError so the UI can always render it. */
export function toAudioError(err: unknown): AudioError {
  if (err instanceof AudioError) return err;

  const text = err instanceof Error ? err.message : String(err);

  // Browsers report OOM inconsistently; these are the observed shapes.
  if (/allocation|out of memory|Array buffer allocation/i.test(text)) {
    return audioError('out-of-memory');
  }
  if (/EncodingError|Unable to decode|decodeAudioData/i.test(text)) {
    return audioError('decode-failed');
  }

  // The AI tools fetch their runtime the first time they are used, and a failure
  // there says nothing about the file. Left unrecognised it became
  // 'unknown-error', whose copy tells the visitor to try a different file — advice
  // that cannot work, because every file fails identically until the runtime
  // loads. The three engine wordings for a failed dynamic import, transformers.js
  // reporting a weight it could not find, and our own worker fallback.
  if (
    /dynamically imported module|Importing a module script failed|Could not locate file|failed to start/i.test(
      text
    )
  ) {
    return audioError('model-load-failed');
  }

  // Anything that reaches here is unrecognised, which in practice means one of
  // our own bugs. It must not borrow 'decode-failed': that code is the signal
  // for "the file is broken", and folding crashes into it made the two
  // indistinguishable in analytics, where the code is all we send.
  //
  // The name of what was thrown does travel with it: it is the one part of an
  // unrecognised failure that is both safe to send and enough to start a diagnosis.
  return audioError('unknown-error', undefined, { cause: causeOf(err) });
}
