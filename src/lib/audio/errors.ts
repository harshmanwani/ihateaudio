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

export class AudioError extends Error {
  readonly code: AudioErrorCode;
  /** What the user should actually do next. Rendered under the message. */
  readonly fix: string;

  constructor(code: AudioErrorCode, message: string, fix: string) {
    super(message);
    this.name = 'AudioError';
    this.code = code;
    this.fix = fix;
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
export function audioError(code: AudioErrorCode, fix?: string): AudioError {
  const copy = COPY[code];
  return new AudioError(code, copy.message, fix ?? copy.fix);
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
  return audioError('unknown-error');
}
