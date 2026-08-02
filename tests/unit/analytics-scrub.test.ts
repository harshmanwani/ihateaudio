import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The exception scrubber, tested as it actually ships.
 *
 * public/analytics.js is a plain IIFE served to the browser, so there is nothing
 * to import. Rather than keep a second copy here and watch the two drift, this
 * slices the marked block straight out of the real file and runs that. If the
 * markers move, this throws rather than quietly testing nothing.
 *
 * What it protects: replay and autocapture are off on this site because a
 * filename is content, and an exception message is the one remaining route a
 * filename could take to PostHog.
 */
type CaptureResult = {
  event: string;
  properties?: Record<string, unknown>;
};

const REDACTED = '<redacted: possible filename>';

function loadScrubber(): (event: unknown) => CaptureResult | null {
  const path = fileURLToPath(new URL('../../public/analytics.js', import.meta.url));
  const src = readFileSync(path, 'utf8');

  const start = src.indexOf('/* scrub:start */');
  const end = src.indexOf('/* scrub:end */');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('scrub:start / scrub:end markers missing from public/analytics.js');
  }

  return new Function(`${src.slice(start, end)}\nreturn scrubException;`)();
}

const scrubException = loadScrubber();

const exception = (value: string, message?: string): CaptureResult => ({
  event: '$exception',
  properties: {
    $exception_list: [{ type: 'TypeError', value }],
    ...(message === undefined ? {} : { $exception_message: message }),
  },
});

const valueOf = (event: CaptureResult | null): unknown =>
  (event?.properties?.$exception_list as { value: unknown }[] | undefined)?.[0]?.value;

describe('exception scrubbing: what must never reach the wire', () => {
  it('redacts a filename in the message', () => {
    expect(valueOf(scrubException(exception('Could not read holiday-recording.mp3')))).toBe(
      REDACTED
    );
  });

  it('redacts filenames containing spaces, which is the common phone case', () => {
    // The reason the whole message goes rather than a matched substring: there
    // is no boundary telling a regex where "Voice Memo 3" starts, so redacting
    // only the token nearest the extension leaves the front of the name behind.
    for (const value of [
      'failed on Voice Memo 3.M4A',
      'WhatsApp Audio 2026-07-31 at 22.05.10.opus is broken',
      'New Recording 12.m4a could not be read',
    ]) {
      expect(valueOf(scrubException(exception(value))), value).toBe(REDACTED);
    }
  });

  it('redacts blob, data and file URLs, which can carry the audio itself', () => {
    expect(valueOf(scrubException(exception('fetch failed for blob:https://x.com/9f2c')))).toBe(
      'fetch failed for <url>'
    );
    expect(valueOf(scrubException(exception('bad src data:audio/mpeg;base64,AAAAB')))).toBe(
      'bad src <url>'
    );
  });

  it('scrubs $exception_message as well as $exception_list', () => {
    const scrubbed = scrubException(exception('fine', 'reading trip.wav'));
    expect(scrubbed?.properties?.$exception_message).toBe(REDACTED);
  });

  it('is not sticky across calls', () => {
    // A /g regex would carry lastIndex and let every second filename through.
    for (let i = 0; i < 4; i++) {
      expect(valueOf(scrubException(exception('holiday.mp3 broke'))), `call ${i}`).toBe(REDACTED);
    }
  });

  it('fails closed when it cannot read the event', () => {
    const hostile = {
      event: '$exception',
      get properties(): never {
        throw new Error('nope');
      },
    };
    expect(scrubException(hostile)).toBeNull();
  });
});

describe('exception scrubbing: what must survive, or capture is pointless', () => {
  it('leaves ordinary bug messages intact', () => {
    for (const value of [
      "Cannot read properties of undefined (reading 'length')",
      "undefined is not an object (evaluating 'r.length')",
      'Maximum call stack size exceeded',
      'EncodingError: Unable to decode audio data',
      'Unknown output format "mp3".',
    ]) {
      expect(valueOf(scrubException(exception(value))), value).toBe(value);
    }
  });

  it('leaves our own bundle URLs intact, since those are the useful part', () => {
    const value = 'boom at https://ihateaudio.com/_astro/tool.a1b2.js:4:19';
    expect(valueOf(scrubException(exception(value)))).toBe(value);
  });

  it('keeps the exception type even when the message is redacted', () => {
    const scrubbed = scrubException(exception('holiday.mp3 broke'));
    const list = scrubbed?.properties?.$exception_list as { type: string }[];
    expect(list[0].type).toBe('TypeError');
  });

  it('does not touch the product events', () => {
    const event = { event: 'tool_error', properties: { code: 'unknown-error', tool: 'equalizer' } };
    expect(scrubException(event)).toBe(event);
    expect(event.properties.code).toBe('unknown-error');
  });
});
