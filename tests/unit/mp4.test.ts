import { describe, expect, it } from 'vitest';
import { isMp4, mp4AudioTrack } from '../../src/lib/audio/mp4';
import { detectSampleRate } from '../../src/lib/audio/decode';

/*
 * Files are built box by box, so each test states exactly the headers it
 * relies on. The codec configs (esds, alac, dfLa payloads) are copied from
 * real files: ffmpeg 8 for the ffmpeg cases, macOS afconvert for the Apple
 * ones.
 */

const hex = (text: string): number[] => (text.match(/../g) ?? []).map((pair) => parseInt(pair, 16));
const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const u16 = (n: number): number[] => [(n >>> 8) & 0xff, n & 0xff];
const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const f64 = (n: number): number[] => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, n);
  return [...new Uint8Array(view.buffer)];
};

function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(8 + body.length), ...ascii(type), ...body];
}

interface EntryOptions {
  /** The 16.16 rate field's integer part. */
  fixedRate: number;
  channels?: number;
  /** QuickTime sound description version: 0, 1 (16 more bytes) or 2 (a double rate). */
  version?: 0 | 1 | 2;
  v2Rate?: number;
  children?: number[][];
}

function sampleEntry(codec: string, options: EntryOptions): number[] {
  const { fixedRate, channels = 2, version = 0, v2Rate = 0, children = [] } = options;
  const head = [
    ...new Array(6).fill(0), ...u16(1), // reserved, data reference index
    ...u16(version), ...u16(0), ...u32(0), // version, revision, vendor
  ];
  if (version === 2) {
    return box(codec, head, u16(3), u16(16), u16(0xfffe), u16(0), u32(0x10000), u32(72),
      f64(v2Rate), u32(channels), u32(0x7f000000), u32(16), u32(12), u32(4), u32(1), ...children);
  }
  return box(codec, head, u16(channels), u16(16), u16(0), u16(0), u32(fixedRate * 0x10000),
    version === 1 ? new Array(16).fill(0) : [], ...children);
}

function track(handler: string, timescale: number, entry: number[], seconds = 2): number[] {
  const mdhd = box('mdhd', u32(0), u32(0), u32(0), u32(timescale), u32(timescale * seconds), u32(0));
  const hdlr = box('hdlr', u32(0), u32(0), ascii(handler), new Array(12).fill(0), [0]);
  const stsd = box('stsd', u32(0), u32(1), entry);
  const stsz = box('stsz', u32(0), u32(1000), u32(4));
  const stbl = box('stbl', stsd, stsz);
  return box('trak', box('mdia', mdhd, hdlr, box('minf', stbl)));
}

function mp4(...traks: number[][]): ArrayBuffer {
  const ftyp = box('ftyp', ascii('M4A '), u32(0), ascii('isom'));
  return new Uint8Array([...ftyp, ...box('moov', ...traks), ...box('mdat', new Array(32).fill(0))])
    .buffer;
}

function audio(codec: string, timescale: number, options: EntryOptions): ArrayBuffer {
  return mp4(track('soun', timescale, sampleEntry(codec, options)));
}

const esds = (payload: string): number[] => box('esds', hex(payload));
/** An MPEG-4 descriptor, with its length in four bytes as ffmpeg writes it. */
function descriptor(tag: number, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [tag, 0x80, 0x80, 0x80, body.length, ...body];
}
/** The ES descriptor around an AudioSpecificConfig. */
const aacEsds = (config: string): number[] =>
  box(
    'esds',
    u32(0),
    descriptor(
      0x03,
      u16(1),
      [0],
      // MPEG-4 audio, an audio stream, buffer size, max and average bitrate.
      descriptor(0x04, [0x40, 0x15, 0, 0, 0], u32(128000), u32(128000), descriptor(0x05, hex(config))),
      descriptor(0x06, [2])
    )
  );

describe('mp4AudioTrack rate', () => {
  it('reads Apple Lossless from its cookie, past the 16-bit rate field', () => {
    // ffmpeg -ar 96000 -c:a alac: the entry's fixed-point field says 48000.
    const cookie = box('alac', hex('00000000000010000018280a0e0200ff000000000000000000017700'));
    const file = audio('alac', 96000, { fixedRate: 48000, children: [cookie] });
    expect(mp4AudioTrack(file)).toMatchObject({ codec: 'alac', rate: 96000, channels: 2 });
  });

  it('reads 44.1 kHz Apple Lossless at 44.1 kHz', () => {
    const cookie = box('alac', hex('00000000000010000010280a0e0200ff00000000000000000000ac44'));
    expect(mp4AudioTrack(audio('alac', 44100, { fixedRate: 44100, children: [cookie] }))?.rate).toBe(
      44100
    );
  });

  it('finds the cookie in a QuickTime wave box', () => {
    const cookie = box('alac', hex('00000000000010000010280a0e0200ff00000000000000000000ac44'));
    const wave = box('wave', box('frma', ascii('alac')), cookie, u32(0));
    const file = audio('alac', 44100, { fixedRate: 44100, version: 1, children: [wave] });
    expect(mp4AudioTrack(file)?.rate).toBe(44100);
  });

  it('reads AAC-LC from its config', () => {
    // ffmpeg -c:a aac at 44.1 kHz: LC, index 4, with SBR signalled absent.
    // The headers around it say nothing usable, so only the config can answer.
    const file = audio('mp4a', 1000, { fixedRate: 0, children: [aacEsds('121056e500')] });
    expect(mp4AudioTrack(file)).toMatchObject({ codec: 'mp4a', rate: 44100 });
  });

  it('reads 96 kHz AAC past the 16-bit rate field', () => {
    const file = audio('mp4a', 96000, { fixedRate: 48000, children: [aacEsds('101056e500')] });
    expect(mp4AudioTrack(file)?.rate).toBe(96000);
  });

  it('doubles HE-AAC whose headers all state the core rate', () => {
    // afconvert -d aach: timescale, entry and core config all say 22050.
    const file = audio('mp4a', 22050, {
      fixedRate: 22050,
      children: [
        esds(
          '00000000038080802500000004808080174014001800000152e80000fa000580808005139056e5a0068080800102'
        ),
      ],
    });
    expect(mp4AudioTrack(file)?.rate).toBe(44100);
  });

  it('doubles HE-AAC v2, whose core is mono', () => {
    // afconvert -d aacp.
    const file = audio('mp4a', 22050, {
      fixedRate: 22050,
      children: [
        esds(
          '000000000380808027000000048080801940140018000000a7c000007d000580808007138856e5a54880068080800102'
        ),
      ],
    });
    expect(mp4AudioTrack(file)?.rate).toBe(44100);
  });

  it('reads the extension rate of explicitly signalled SBR', () => {
    // Object type 5, core 22050, extension 44100, then the LC core.
    const file = audio('mp4a', 22050, { fixedRate: 22050, children: [aacEsds('2b920800')] });
    expect(mp4AudioTrack(file)?.rate).toBe(44100);
  });

  it('keeps a low AAC rate the config says has no SBR', () => {
    const file = audio('mp4a', 22050, { fixedRate: 22050, children: [aacEsds('139056e500')] });
    expect(mp4AudioTrack(file)?.rate).toBe(22050);
  });

  it('will not guess a low AAC rate that a decoder may double', () => {
    // No sync extension: a decoder can still find SBR in the stream itself.
    const file = audio('mp4a', 22050, { fixedRate: 22050, children: [aacEsds('1390')] });
    expect(mp4AudioTrack(file)?.rate).toBeNull();
    expect(mp4AudioTrack(audio('mp4a', 22050, { fixedRate: 22050 }))?.rate).toBeNull();
  });

  it('keeps a high AAC rate with no extension', () => {
    // afconvert -d aac at 44.1 kHz writes a two-byte config.
    const file = audio('mp4a', 1000, { fixedRate: 0, children: [aacEsds('1210')] });
    expect(mp4AudioTrack(file)?.rate).toBe(44100);
  });

  it('takes MP3 in an MP4 at its header rate', () => {
    const mp3 = esds('00000000038080801b000100048080800d6b150000000001f5490001f549068080800102');
    expect(mp4AudioTrack(audio('mp4a', 44100, { fixedRate: 44100, children: [mp3] }))?.rate).toBe(
      44100
    );
  });

  it('reads FLAC from its STREAMINFO', () => {
    const dfla = box('dfLa', hex('00000000800000221000100000000e0034f0158885888b80'), new Array(22).fill(0));
    expect(mp4AudioTrack(audio('fLaC', 88200, { fixedRate: 44100, children: [dfla] }))?.rate).toBe(
      88200
    );
  });

  it('decodes Opus at 48 kHz whatever the headers say', () => {
    expect(mp4AudioTrack(audio('Opus', 16000, { fixedRate: 16000 }))?.rate).toBe(48000);
  });

  it('reads the double rate of a QuickTime version 2 entry', () => {
    const file = audio('lpcm', 96000, { fixedRate: 1, version: 2, v2Rate: 96000 });
    expect(mp4AudioTrack(file)).toMatchObject({ codec: 'lpcm', rate: 96000, channels: 2 });
  });

  it('takes the higher of the timescale and the fixed-point rate', () => {
    expect(mp4AudioTrack(audio('sowt', 96000, { fixedRate: 48000 }))?.rate).toBe(96000);
  });

  it('ignores a timescale that is not an audio rate', () => {
    expect(mp4AudioTrack(audio('twos', 600, { fixedRate: 44100 }))?.rate).toBe(44100);
    expect(mp4AudioTrack(audio('twos', 600, { fixedRate: 0 }))?.rate).toBeNull();
  });

  it('skips a video track to reach the sound', () => {
    const video = track('vide', 90000, box('avc1', new Array(78).fill(0)));
    const sound = track('soun', 48000, sampleEntry('mp4a', { fixedRate: 48000, children: [aacEsds('119056e500')] }));
    expect(mp4AudioTrack(mp4(video, sound))).toMatchObject({ codec: 'mp4a', rate: 48000 });
  });

  it('finds a moov that comes after the media data', () => {
    const ftyp = box('ftyp', ascii('M4A '), u32(0));
    const mdat = box('mdat', new Array(4096).fill(0x55));
    const moov = box('moov', track('soun', 44100, sampleEntry('sowt', { fixedRate: 44100 })));
    const file = new Uint8Array([...ftyp, ...mdat, ...moov]).buffer;
    expect(mp4AudioTrack(file)?.rate).toBe(44100);
  });

  it('reports the length, the bytes and an encrypted codec', () => {
    const track = mp4AudioTrack(audio('drms', 44100, { fixedRate: 44100 }));
    expect(track).toMatchObject({ codec: 'drms', seconds: 2, bytes: 4000 });
  });

  it('answers null for what is not an MP4 or is cut short', () => {
    expect(mp4AudioTrack(new Uint8Array(64).buffer)).toBeNull();
    const wav = new Uint8Array([...ascii('RIFF'), ...u32(36), ...ascii('WAVEfmt ')]).buffer;
    expect(isMp4(wav)).toBe(false);
    const whole = new Uint8Array(audio('alac', 44100, { fixedRate: 44100 }));
    expect(() => mp4AudioTrack(whole.slice(0, 120).buffer)).not.toThrow();
  });
});

describe('detectSampleRate', () => {
  it('reads an MP4 from its audio track instead of scanning it for MP3 frames', () => {
    const cookie = box('alac', hex('00000000000010000010280a0e0200ff00000000000000000000ac44'));
    expect(detectSampleRate(audio('alac', 44100, { fixedRate: 44100, children: [cookie] }))).toBe(
      44100
    );
  });

  it('answers null for an MP4 whose rate is uncertain', () => {
    expect(detectSampleRate(audio('mp4a', 22050, { fixedRate: 22050 }))).toBeNull();
  });

  it('still reads WAV', () => {
    const wav = new Uint8Array([
      ...ascii('RIFF'), ...[36, 0, 0, 0], ...ascii('WAVEfmt '), ...[16, 0, 0, 0, 1, 0, 2, 0],
      ...[0x44, 0xac, 0, 0], ...new Array(8).fill(0),
    ]).buffer;
    expect(detectSampleRate(wav)).toBe(44100);
  });
});
