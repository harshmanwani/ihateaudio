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
  | 'cancelled';

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
  cancelled: {
    message: 'Cancelled.',
    fix: 'Nothing was changed.',
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

  return new AudioError(
    'decode-failed',
    'Something went wrong processing that file.',
    'Try a different file, or reload the page and try once more.'
  );
}
