import { describe, it, expect } from 'vitest';
import { AudioError, audioError, toAudioError } from '../../src/lib/audio/errors';

describe('audioError', () => {
  it('attaches the standard copy for a code', () => {
    const err = audioError('too-long');
    expect(err).toBeInstanceOf(AudioError);
    expect(err.code).toBe('too-long');
    expect(err.message).toMatch(/too long/i);
    expect(err.fix).toBeTruthy();
  });

  it('takes an override fix and keeps the standard message', () => {
    const err = audioError('unsupported-format', 'Use the converter.');
    expect(err.fix).toBe('Use the converter.');
    expect(err.message).toMatch(/can't read that file type/i);
  });

  it('has copy for every code, so no throw site renders undefined', () => {
    const codes = [
      'unsupported-format',
      'decode-failed',
      'drm-protected',
      'empty-file',
      'too-large',
      'too-long',
      'out-of-memory',
      'no-audio-track',
      'encode-failed',
      'ffmpeg-load-failed',
      'model-load-failed',
      'cancelled',
      'unknown-error',
    ] as const;

    for (const code of codes) {
      const err = audioError(code);
      expect(err.message, code).toBeTruthy();
      expect(err.fix, code).toBeTruthy();
    }
  });
});

describe('toAudioError', () => {
  it('passes an AudioError through untouched', () => {
    const original = audioError('drm-protected');
    expect(toAudioError(original)).toBe(original);
  });

  it('recognises the shapes browsers use to report running out of memory', () => {
    for (const text of [
      'Array buffer allocation failed',
      'Out of memory',
      'RangeError: Array buffer allocation failed',
    ]) {
      expect(toAudioError(new Error(text)).code, text).toBe('out-of-memory');
    }
  });

  it('recognises a genuine decode failure', () => {
    for (const text of [
      'EncodingError: Unable to decode audio data',
      'Unable to decode audio data',
      'decodeAudioData failed',
    ]) {
      expect(toAudioError(new Error(text)).code, text).toBe('decode-failed');
    }
  });

  /**
   * The AI tools fetch their runtime — the library, its WebAssembly, and the
   * weights — from our own origin at the moment they are first used. When any of
   * that 404s or the connection drops, what reaches here is a load failure, and
   * it used to land in 'unknown-error': the tool told the visitor their file was
   * the problem and suggested trying a different one, which never helped because
   * every file failed the same way.
   *
   * That is not hypothetical. A deploy shipped without public/lib/, and the
   * transcriber answered "Something went wrong processing that file" for every
   * file until someone read the network tab.
   */
  it('recognises a runtime that failed to load, rather than blaming the file', () => {
    for (const text of [
      // Chrome, Firefox and Safari each word a failed dynamic import differently.
      'Failed to fetch dynamically imported module: https://ihateaudio.com/lib/transformers/4.2.0/transformers.min.js',
      'error loading dynamically imported module',
      'Importing a module script failed.',
      // transformers.js, when a weight file is not where it was told to look.
      'Could not locate file: "https://ihateaudio.com/models/v1/whisper-tiny-en/config.json"',
      // Our own fallback when the worker itself will not start.
      'The transcriber failed to start.',
    ]) {
      expect(toAudioError(new Error(text)).code, text).toBe('model-load-failed');
    }
  });

  /**
   * The regression this file exists for. An unrecognised throw is one of our own
   * bugs, and it used to be relabelled 'decode-failed' — the same code a corrupt
   * file produces. Since tool_error sends the code and nothing else, that made a
   * crash and a broken upload indistinguishable in analytics, and a real bug
   * looked exactly like a user with a bad file.
   */
  it('does not disguise an unrecognised error as a decode failure', () => {
    for (const thrown of [
      new TypeError("Cannot read properties of undefined (reading 'length')"),
      new Error("undefined is not an object (evaluating 'r.length')"),
      new RangeError('Maximum call stack size exceeded'),
      'a bare string',
      null,
      undefined,
    ]) {
      const err = toAudioError(thrown);
      expect(err.code, String(thrown)).toBe('unknown-error');
      expect(err.code, String(thrown)).not.toBe('decode-failed');
    }
  });

  it('always returns something renderable, whatever it was handed', () => {
    for (const thrown of [null, undefined, 0, {}, [], new Error('')]) {
      const err = toAudioError(thrown);
      expect(err, String(thrown)).toBeInstanceOf(AudioError);
      expect(err.message, String(thrown)).toBeTruthy();
      expect(err.fix, String(thrown)).toBeTruthy();
    }
  });
});
