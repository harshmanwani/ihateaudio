/**
 * Containers for AAC from the light encoder: an MP4 for .m4a and .m4r, ADTS
 * for raw .aac.
 *
 * The MP4 follows what ffmpeg's own muxer writes for `-c:a aac -f mp4`, which
 * is what the site shipped as M4A and M4R before this existed: the same brands,
 * one sound track, an esds with the encoder's AudioSpecificConfig, and an
 * edit list that skips the encoder's priming. The moov goes before the media
 * data, so a player can start before it has the whole file.
 *
 * mp4.ts reads these boxes back; the unit tests hold the two to each other.
 */

export interface AacTrack {
  sampleRate: number;
  channels: number;
  /** The encoder's AudioSpecificConfig. */
  config: Uint8Array;
  /** Samples of encoder delay at the start, which the edit list skips. */
  priming: number;
  /** Samples of real audio, priming excluded. */
  frames: number;
  /** Samples each packet decodes to: 1024 for AAC-LC. */
  packetFrames: number;
  /** Size of each packet, in order. */
  sizes: ArrayLike<number>;
}

type Bytes = Uint8Array<ArrayBuffer>;

/** Packets per chunk: about a second and a half at 44.1 kHz. */
const CHUNK = 64;

/** The sound track's movie timescale, as ffmpeg writes it. */
const MOVIE_TIMESCALE = 1000;

/** An MP4 (.m4a, .m4r) around the packets in `payload`, which are the track's in order. */
export function aacMp4(track: AacTrack, payload: BlobPart[]): Blob {
  const data = sum(track.sizes);
  // A 32-bit chunk offset reaches 4 GB, which is over 30 hours at 256 kbps.
  if (data > 0xffffffff - 1_000_000) throw new RangeError('AAC payload too large for stco');
  const head = moovFor(track, 0);
  const ftyp = ftypBox();
  // The chunk offsets depend on the moov's size, which does not depend on them.
  const moov = moovFor(track, ftyp.length + head.length + 8);
  const mdat = header(8 + data, 'mdat');
  return new Blob([ftyp, moov, mdat, ...payload], { type: 'audio/mp4' });
}

/**
 * Raw AAC: each packet behind a 7-byte ADTS header, which is what ffmpeg
 * writes for a .aac file. There is no edit list in ADTS, so the priming plays,
 * as it does from ffmpeg.
 */
export function aacAdts(track: AacTrack, packets: Uint8Array): Blob {
  const { objectType, rateIndex, channelConfig } = readConfig(track.config);
  const out = new Uint8Array(packets.length + 7 * track.sizes.length);
  let read = 0;
  let write = 0;
  for (let i = 0; i < track.sizes.length; i += 1) {
    const size = track.sizes[i]!;
    const length = size + 7;
    out[write] = 0xff;
    // MPEG-4, layer 0, no CRC.
    out[write + 1] = 0xf1;
    out[write + 2] = ((objectType - 1) << 6) | (rateIndex << 2) | (channelConfig >> 2);
    out[write + 3] = ((channelConfig & 3) << 6) | (length >> 11);
    out[write + 4] = (length >> 3) & 0xff;
    // Buffer fullness 0x7ff: variable bitrate.
    out[write + 5] = ((length & 7) << 5) | 0x1f;
    out[write + 6] = 0xfc;
    out.set(packets.subarray(read, read + size), write + 7);
    read += size;
    write += length;
  }
  return new Blob([out], { type: 'audio/aac' });
}

/** Object type, rate index and channel configuration from an AudioSpecificConfig. */
export function readConfig(config: Uint8Array): {
  objectType: number;
  rateIndex: number;
  channelConfig: number;
} {
  if (config.length < 2) throw new RangeError('AudioSpecificConfig too short');
  const bits = (config[0]! << 8) | config[1]!;
  return {
    objectType: bits >> 11,
    rateIndex: (bits >> 7) & 0x0f,
    channelConfig: (bits >> 3) & 0x0f,
  };
}

function ftypBox(): Bytes {
  return box('ftyp', ascii('isom'), u32(0x200), ascii('isom'), ascii('iso2'), ascii('mp41'));
}

function moovFor(track: AacTrack, mdatStart: number): Bytes {
  const { sampleRate, priming, frames, packetFrames, sizes } = track;
  const count = sizes.length;
  if (count === 0) throw new RangeError('No AAC packets to write');
  // The media ends where the audio does, so the last packet's duration is only
  // the samples it really carries. That is how ffmpeg writes it, and Apple's
  // parser depends on it: with the last packet at its full 1024, macOS took
  // the default 2112 samples of priming instead of the edit list's 1024 and
  // cut 17 ms off the end.
  const padded = count * packetFrames;
  const mediaLength = Math.min(padded, Math.max(priming + frames, padded - packetFrames + 1));
  const lastDuration = mediaLength - (count - 1) * packetFrames;
  // What plays once the edit list has skipped the priming.
  const shown = Math.round(((mediaLength - priming) * MOVIE_TIMESCALE) / sampleRate);
  const stts =
    lastDuration === packetFrames
      ? [u32(1), u32(count), u32(packetFrames)]
      : count === 1
        ? [u32(1), u32(1), u32(lastDuration)]
        : [u32(2), u32(count - 1), u32(packetFrames), u32(1), u32(lastDuration)];

  const chunks = Math.ceil(count / CHUNK);
  const offsets: number[] = [];
  let offset = mdatStart;
  for (let c = 0; c < chunks; c += 1) {
    offsets.push(offset);
    const end = Math.min(count, (c + 1) * CHUNK);
    for (let i = c * CHUNK; i < end; i += 1) offset += sizes[i]!;
  }
  const last = count - (chunks - 1) * CHUNK;

  const stbl = box(
    'stbl',
    full('stsd', 0, u32(1), mp4a(track)),
    full('stts', 0, ...stts),
    full(
      'stsc',
      0,
      ...(last === CHUNK || chunks === 1
        ? [u32(1), u32(1), u32(Math.min(count, CHUNK)), u32(1)]
        : [u32(2), u32(1), u32(CHUNK), u32(1), u32(chunks), u32(last), u32(1)])
    ),
    full('stsz', 0, u32(0), u32(count), u32s(sizes)),
    full('stco', 0, u32(chunks), u32s(offsets)),
    // Every packet needs the one before it to decode cleanly, as ffmpeg
    // declares for AAC: a 'roll' group of distance -1 covering all of them.
    box('sgpd', u32(0x01000000), ascii('roll'), u32(2), u32(1), u16(0xffff)),
    full('sbgp', 0, ascii('roll'), u32(1), u32(count), u32(1))
  );

  const minf = box(
    'minf',
    full('smhd', 0, u16(0), u16(0)),
    box('dinf', full('dref', 0, u32(1), full('url ', 1))),
    stbl
  );

  const mdia = box(
    'mdia',
    // 'und' packed as three 5-bit letters.
    full('mdhd', 0, u32(0), u32(0), u32(sampleRate), u32(mediaLength), u16(0x55c4), u16(0)),
    full('hdlr', 0, u32(0), ascii('soun'), u32(0), u32(0), u32(0), ascii('SoundHandler\0')),
    minf
  );

  const trak = box(
    'trak',
    full(
      'tkhd',
      3, // enabled, in the movie
      u32(0), u32(0), u32(1), u32(0), u32(shown),
      u32(0), u32(0),
      u16(0), u16(0), u16(0x0100), u16(0),
      MATRIX,
      u32(0), u32(0)
    ),
    box(
      'edts',
      full('elst', 0, u32(1), u32(shown), u32(priming), u16(1), u16(0))
    ),
    mdia
  );

  return box(
    'moov',
    full(
      'mvhd',
      0,
      u32(0), u32(0), u32(MOVIE_TIMESCALE), u32(shown),
      u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0),
      MATRIX,
      new Uint8Array(24),
      u32(2)
    ),
    trak
  );
}

/**
 * The sample entry. The channel count is the real one rather than the 2
 * ffmpeg always writes, which is what Apple's encoder does and what mp4.ts
 * reads; a decoder takes the count from the config either way.
 */
function mp4a(track: AacTrack): Bytes {
  const { sampleRate, channels } = track;
  const rates = bitrates(track);
  return box(
    'mp4a',
    new Uint8Array(6), u16(1),
    u16(0), u16(0), u32(0),
    u16(channels), u16(16), u16(0), u16(0),
    // 16.16 fixed point, so a rate past 65535 cannot be written; the config holds it.
    u32(sampleRate <= 0xffff ? sampleRate << 16 >>> 0 : 0),
    esds(track.config, rates),
    box('btrt', u32(rates.largest), u32(rates.peak), u32(rates.average))
  );
}

interface Bitrates {
  /** The largest packet, in bytes. */
  largest: number;
  /** Bits per second over the busiest second. */
  peak: number;
  /** Bits per second over the whole track. */
  average: number;
}

function bitrates(track: AacTrack): Bitrates {
  const { sizes, sampleRate, packetFrames } = track;
  const seconds = (sizes.length * packetFrames) / sampleRate;
  const total = sum(sizes);
  const average = seconds > 0 ? Math.round((total * 8) / seconds) : 0;

  // The largest packet and the busiest second, which the decoder config states.
  let largest = 0;
  let peak = 0;
  const perSecond = Math.max(1, Math.round(sampleRate / packetFrames));
  let window = 0;
  for (let i = 0; i < sizes.length; i += 1) {
    largest = Math.max(largest, sizes[i]!);
    window += sizes[i]!;
    if (i >= perSecond) window -= sizes[i - perSecond]!;
    peak = Math.max(peak, window);
  }
  return {
    largest,
    peak: Math.max(average, Math.round((peak * 8 * sampleRate) / (perSecond * packetFrames))),
    average,
  };
}

function esds(config: Uint8Array, rates: Bitrates): Bytes {
  const decoderSpecific = descriptor(0x05, config);
  const decoderConfig = descriptor(
    0x04,
    // MPEG-4 audio; an audio stream, upstream 0, reserved 1.
    new Uint8Array([0x40, 0x15]),
    u24(rates.largest),
    u32(rates.peak),
    u32(rates.average),
    decoderSpecific
  );
  const slConfig = descriptor(0x06, new Uint8Array([0x02]));
  return full('esds', 0, descriptor(0x03, u16(1), new Uint8Array([0]), decoderConfig, slConfig));
}

/** An MPEG-4 descriptor, its length in the four-byte form ffmpeg writes. */
function descriptor(tag: number, ...parts: Uint8Array[]): Bytes {
  const body = concat(parts);
  const n = body.length;
  return concat([
    new Uint8Array([tag, 0x80 | ((n >> 21) & 0x7f), 0x80 | ((n >> 14) & 0x7f), 0x80 | ((n >> 7) & 0x7f), n & 0x7f]),
    body,
  ]);
}

const MATRIX = concat(
  [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map((value) => u32(value))
);

function box(type: string, ...parts: Uint8Array[]): Bytes {
  const body = concat(parts);
  return concat([header(8 + body.length, type), body]);
}

/** A full box: a version byte and 24 bits of flags ahead of the payload. */
function full(type: string, flags: number, ...parts: Uint8Array[]): Bytes {
  return box(type, u32(flags & 0xffffff), ...parts);
}

function header(size: number, type: string): Bytes {
  return concat([u32(size), ascii(type)]);
}

function concat(parts: Uint8Array[]): Bytes {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function sum(values: ArrayLike<number>): number {
  let total = 0;
  for (let i = 0; i < values.length; i += 1) total += values[i]!;
  return total;
}

function ascii(text: string): Bytes {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

function u16(value: number): Bytes {
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

function u24(value: number): Bytes {
  return new Uint8Array([(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function u32(value: number): Bytes {
  return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

function u32s(values: ArrayLike<number>): Bytes {
  const out = new Uint8Array(values.length * 4);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i += 1) view.setUint32(i * 4, values[i]!);
  return out;
}
