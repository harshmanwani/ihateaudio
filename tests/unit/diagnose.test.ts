import { describe, expect, it } from 'vitest';
import { browserClass, errorMessage, errorName } from '../../src/lib/audio/diagnose';

describe('errorName', () => {
  it('reads the name of an Error or a DOMException', () => {
    expect(errorName(new RangeError('x'))).toBe('RangeError');
    expect(errorName(new DOMException('x', 'EncodingError'))).toBe('EncodingError');
  });

  it("reads the type off the front of the string ffmpeg's worker posts", () => {
    expect(errorName('RuntimeError: Aborted(CompileError: WebAssembly.instantiate(): invalid opcode)')).toBe(
      'RuntimeError'
    );
    expect(errorName('something odd')).toBe('string');
    expect(errorName(null)).toBe('null');
  });
});

describe('errorMessage', () => {
  it('keeps an engine message, which names no file', () => {
    expect(errorMessage(new Error('WebAssembly.Module(): Compiling function #41 failed'))).toBe(
      'WebAssembly.Module(): Compiling function #41 failed'
    );
  });

  it('drops the whole message when it mentions a media file, spaces and all', () => {
    for (const text of [
      'Failed to read WhatsApp Audio 2026-07-31 at 22.05.10.opus',
      'cannot open Voice Memo 3.m4a',
      'bad header in ringtone.M4R',
    ]) {
      expect(errorMessage(new Error(text)), text).toBe('<redacted: possible filename>');
    }
  });

  it('blanks a URL to local data and keeps the rest', () => {
    expect(errorMessage('fetch blob:https://ihateaudio.com/4c1a-77 failed')).toBe('fetch <url> failed');
  });

  it('stays short', () => {
    expect(errorMessage(new Error('x'.repeat(1000))).length).toBeLessThanOrEqual(160);
  });
});

describe('browserClass', () => {
  it('splits iOS by the browser it wraps, since all of them are WebKit', () => {
    expect(
      browserClass('Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1')
    ).toBe('ios-chrome');
    expect(
      browserClass('Mozilla/5.0 (iPhone; CPU iPhone OS 15_8_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1')
    ).toBe('ios-safari');
  });

  it('names the desktop and Android browsers', () => {
    expect(browserClass('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36')).toBe('android-chrome');
    expect(browserClass('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0')).toBe('desktop-edge');
    expect(browserClass('Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0')).toBe('desktop-firefox');
    expect(browserClass('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Safari/605.1.15')).toBe('desktop-safari');
  });
});
