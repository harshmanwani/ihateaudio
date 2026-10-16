/**
 * The audio track of an MP4-family file (.m4a, .mp4, .mov, .3gp): which codec
 * it holds, the rate it decodes to, how long it is and how many bytes of audio
 * it carries.
 *
 * The decoder wants the rate, so it can decode at the file's own rate instead
 * of the device's. The converter panel wants the codec and the bitrate. Both
 * read the same boxes, so both read them here.
 */

export interface Mp4AudioTrack {
  /** The sample entry's four-character code: 'mp4a' for AAC, 'alac' for Apple Lossless. */
  codec: string | null;
  /** The rate a decoder puts out, or null when the file cannot say for certain. */
  rate: number | null;
  /** Channels the sample entry declares. */
  channels: number | null;
  /** The track's length from its media header, or null when it has none. */
  seconds: number | null;
  /** Bytes of audio in the sample table, or null when it does not list them (fragmented files). */
  bytes: number | null;
}

/** The boxes a file in this family can open with. */
const TOP_LEVEL = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'uuid']);

export function fourcc(view: DataView, at: number): string {
  let out = '';
  for (let i = 0; i < 4; i += 1) out += String.fromCharCode(view.getUint8(at + i));
  return out;
}

interface Box {
  type: string;
  /** Where the payload starts. */
  at: number;
  /** Where the box ends. */
  end: number;
}

/** The direct children of a box payload spanning [start, end). */
export function boxes(view: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset);
    let header = 8;
    if (size === 1 && offset + 16 <= end) {
      size = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) break;
    out.push({ type: fourcc(view, offset + 4), at: offset + header, end: offset + size });
    offset += size;
  }
  return out;
}

/** True when the bytes open the way an MP4-family file does. */
export function isMp4(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 8) return false;
  const view = new DataView(bytes);
  return view.getUint32(0) >= 8 && TOP_LEVEL.has(fourcc(view, 4));
}

/**
 * The audio track of a file already in memory. Null when the bytes are not an
 * MP4-family file or carry no sound track.
 */
export function mp4AudioTrack(bytes: ArrayBuffer): Mp4AudioTrack | null {
  if (!isMp4(bytes)) return null;
  try {
    const view = new DataView(bytes);
    // The moov can sit after the media data, so walk to it rather than assume.
    const moov = boxes(view, 0, view.byteLength).find((box) => box.type === 'moov');
    return moov ? audioTrack(view, moov.at, moov.end) : null;
  } catch {
    /* A box that points past its parent is a damaged file, not an answer. */
    return null;
  }
}

/**
 * The first sound track in a moov payload spanning [start, end). A video can
 * hold several tracks; the handler says which one is sound.
 */
export function audioTrack(view: DataView, start: number, end: number): Mp4AudioTrack | null {
  const child = (box: Box | undefined, type: string) =>
    box ? boxes(view, box.at, box.end).find((inner) => inner.type === type) : undefined;

  for (const trak of boxes(view, start, end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(trak, 'mdia');
    const hdlr = child(mdia, 'hdlr');
    if (!hdlr || hdlr.at + 12 > hdlr.end || fourcc(view, hdlr.at + 8) !== 'soun') continue;

    const mdhd = child(mdia, 'mdhd');
    const stbl = child(child(mdia, 'minf'), 'stbl');
    const stsd = child(stbl, 'stsd');
    const stsz = child(stbl, 'stsz');

    // mdhd: version and flags, two dates (64-bit in version 1), then the
    // timescale and the length in those units.
    let timescale = 0;
    let seconds: number | null = null;
    const v1 = mdhd ? view.getUint8(mdhd.at) === 1 : false;
    if (mdhd && mdhd.at + (v1 ? 32 : 20) <= mdhd.end) {
      timescale = view.getUint32(mdhd.at + (v1 ? 20 : 12));
      const length = v1
        ? view.getUint32(mdhd.at + 24) * 2 ** 32 + view.getUint32(mdhd.at + 28)
        : view.getUint32(mdhd.at + 16);
      if (timescale > 0 && length > 0) seconds = length / timescale;
    }

    // stsd: version and flags and an entry count, then the first sample
    // entry, whose type names the codec.
    const entry = stsd ? boxes(view, stsd.at + 8, stsd.end)[0] : undefined;
    const codec = entry?.type ?? null;
    const described = entry ? sampleEntry(view, entry, timescale) : null;

    return {
      codec,
      rate: described?.rate ?? null,
      channels: described?.channels ?? null,
      seconds,
      bytes: stsz ? sampleBytes(view, stsz) : null,
    };
  }
  return null;
}

/** stsz: one size for every sample, or a table of them. Null when there are none. */
function sampleBytes(view: DataView, stsz: Box): number | null {
  if (stsz.at + 12 > stsz.end) return null;
  const fixed = view.getUint32(stsz.at + 4);
  const count = view.getUint32(stsz.at + 8);
  if (count === 0) return null;
  if (fixed !== 0) return fixed * count;
  if (stsz.at + 12 + count * 4 > stsz.end) return null;
  let bytes = 0;
  for (let i = 0; i < count; i += 1) bytes += view.getUint32(stsz.at + 12 + i * 4);
  return bytes;
}

/** Rates a header field may plausibly hold when nothing codec-specific backs it up. */
const COMMON_RATES = new Set([
  8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 64000, 88200, 96000, 176400,
  192000, 352800, 384000,
]);

const inRange = (rate: number): number | null => (rate >= 3000 && rate <= 768000 ? rate : null);

/**
 * The rate and channel count of an audio sample entry.
 *
 * The entry's own rate field is a 16.16 fixed-point number, so it cannot hold
 * anything past 65535: a 96 kHz file says 48000 there, an 88.2 kHz one 44100.
 * The codec's own configuration is the record that holds, so it is read first.
 */
function sampleEntry(
  view: DataView,
  entry: Box,
  timescale: number
): { rate: number | null; channels: number | null } {
  // The general entry: six reserved bytes and a reference index, then the
  // sound description's version, revision and vendor.
  const at = entry.at;
  if (at + 28 > entry.end) return { rate: null, channels: null };
  const version = view.getUint16(at + 8);
  let channels: number | null = view.getUint16(at + 16) || null;
  const fixedRate = view.getUint32(at + 24) >>> 16;

  // QuickTime version 2 replaces the fixed-point rate with a double, which
  // is how a .mov says 96 kHz.
  let v2Rate: number | null = null;
  if (version === 2 && at + 44 <= entry.end) {
    v2Rate = Math.round(view.getFloat64(at + 32));
    channels = view.getUint32(at + 40) || channels;
  }

  const kids = entryChildren(view, entry, version);
  const find = (type: string): Box | undefined => {
    const direct = kids.find((box) => box.type === type);
    if (direct) return direct;
    // QuickTime nests the codec's configuration in a 'wave' box.
    const wave = kids.find((box) => box.type === 'wave');
    return wave ? boxes(view, wave.at, wave.end).find((box) => box.type === type) : undefined;
  };

  const codec = entry.type;
  if (codec === 'alac') {
    // The Apple Lossless cookie: version and flags, then 24 bytes of config
    // whose last field is the rate as a plain 32-bit integer.
    const cookie = find('alac');
    if (cookie && cookie.at + 28 <= cookie.end) {
      return {
        rate: inRange(view.getUint32(cookie.at + 24)),
        channels: view.getUint8(cookie.at + 13) || channels,
      };
    }
  } else if (codec === 'fLaC') {
    // dfLa: version and flags, a metadata block header, then STREAMINFO,
    // whose rate is 20 bits at byte 10.
    const dfla = find('dfLa');
    if (dfla && dfla.at + 21 <= dfla.end) {
      const b = dfla.at + 8;
      const rate =
        (view.getUint8(b + 10) << 12) | (view.getUint8(b + 11) << 4) | (view.getUint8(b + 12) >> 4);
      return { rate: inRange(rate), channels };
    }
  } else if (codec === 'Opus') {
    // Opus always decodes to 48 kHz, whatever rate the encoder was fed.
    return { rate: 48000, channels };
  } else if (codec === 'mp4a') {
    const esds = find('esds');
    const config = esds ? aacConfig(view, esds) : null;
    if (config) return { rate: config.rate, channels };
    // MP3 in an MP4 carries no AAC config, and its header rate is the real one.
  }

  // Everything else (PCM in all its spellings, MP3 in an MP4): the version 2
  // double, the ISO 'srat' box, or the media timescale against the
  // fixed-point field. An audio track's timescale is its rate in practice,
  // and it has room past 65535. Where the two disagree the higher wins:
  // decoding above the true rate costs memory, below it loses the top of the
  // spectrum.
  const srat = find('srat');
  let rate: number | null;
  if (v2Rate !== null) rate = inRange(v2Rate);
  else if (srat && srat.at + 8 <= srat.end) rate = inRange(view.getUint32(srat.at + 4));
  else {
    const candidates = [timescale, fixedRate].filter((value) => COMMON_RATES.has(value));
    rate = candidates.length ? Math.max(...candidates) : null;
  }
  // An AAC track with no readable config may be HE-AAC; see aacConfig.
  if (codec === 'mp4a' && rate !== null && rate <= 24000) rate = null;
  return { rate, channels };
}

/**
 * Where a sample entry's child boxes start, 28 bytes into its payload.
 * QuickTime's version 1 adds 16 bytes of packet sizes and version 2 adds 36;
 * an ISO version 1 entry adds nothing, so for version 1 both are tried.
 */
function entryChildren(view: DataView, entry: Box, version: number): Box[] {
  const starts = version === 2 ? [64] : version === 1 ? [44, 28] : [28];
  for (const start of starts) {
    const kids = boxes(view, entry.at + start, entry.end);
    if (kids.length && kids.every((box) => /^[\x20-\x7e]{4}$/.test(box.type))) return kids;
  }
  return [];
}

const AAC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/**
 * The rate an AAC track decodes to, from the AudioSpecificConfig in its esds.
 *
 * HE-AAC is the trap. Its core runs at half the output rate, and Apple's
 * encoder writes that half rate into every header: the sample entry and the
 * media timescale of a 44.1 kHz HE-AAC file both say 22050. Decoding it at
 * 22.05 kHz would throw away everything above 11 kHz. The config says where
 * SBR doubles the rate, either up front (object type 5 or 29) or in an
 * extension after the core config. When it says neither and the core rate is
 * 24 kHz or under, a decoder may still find SBR in the stream itself and
 * double it, so the answer is null and the file decodes at the device rate.
 */
function aacConfig(view: DataView, esds: Box): { rate: number | null } | null {
  let at = esds.at + 4; // version and flags
  const end = esds.end;

  // MPEG-4 descriptors: a tag, then a length of one to four bytes, seven bits each.
  const descriptor = (tag: number): { at: number; end: number } | null => {
    if (at >= end || view.getUint8(at) !== tag) return null;
    at += 1;
    let length = 0;
    for (let i = 0; i < 4 && at < end; i += 1) {
      const byte = view.getUint8(at);
      at += 1;
      length = (length << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    return at + length <= end ? { at, end: at + length } : null;
  };

  const es = descriptor(0x03);
  if (!es) return null;
  at = es.at + 2; // ES_ID
  const flags = view.getUint8(at);
  at += 1;
  if (flags & 0x80) at += 2; // depends on another stream
  if (flags & 0x40) at += 1 + view.getUint8(at); // URL
  if (flags & 0x20) at += 2; // OCR stream

  const decoder = descriptor(0x04);
  if (!decoder) return null;
  const objectType = view.getUint8(decoder.at);
  // 0x40 is MPEG-4 audio, 0x66 to 0x68 MPEG-2 AAC. Anything else (MP3 is
  // 0x6b) has no AudioSpecificConfig to read.
  if (objectType !== 0x40 && (objectType < 0x66 || objectType > 0x68)) return null;
  at = decoder.at + 13;
  const specific = descriptor(0x05);
  if (!specific) return null;

  let bit = specific.at * 8;
  const limit = specific.end * 8;
  const read = (count: number): number => {
    if (bit + count > limit) throw new RangeError('config ends early');
    let out = 0;
    for (let i = 0; i < count; i += 1, bit += 1) {
      out = out * 2 + ((view.getUint8(bit >> 3) >> (7 - (bit & 7))) & 1);
    }
    return out;
  };
  const objectTypeOf = (): number => {
    const type = read(5);
    return type === 31 ? 32 + read(6) : type;
  };
  const rateOf = (): number => {
    const index = read(4);
    return index === 15 ? read(24) : (AAC_RATES[index] ?? 0);
  };

  // A core rate over 24 kHz is never doubled. At or under it, only the
  // config's word that SBR is absent makes the core rate the output.
  let core = 0;
  try {
    let type = objectTypeOf();
    core = rateOf();
    const channelConfig = read(4);

    // Explicit SBR (5) or parametric stereo (29): the extension rate is the output.
    if (type === 5 || type === 29) return { rate: inRange(rateOf()) };

    // Backward-compatible signalling puts a sync extension after the core's
    // config. Walk the general config for the object types that have one. A
    // program config element in place of a channel layout is too rare to walk.
    if ([1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23].includes(type) && channelConfig !== 0) {
      read(1); // frame length
      if (read(1)) read(14); // core coder delay
      const extension = read(1);
      if (type === 6 || type === 20) read(3);
      if (extension) {
        if (type === 22) read(16);
        if ([17, 19, 20, 23].includes(type)) read(3);
        read(1);
      }
      if (limit - bit >= 16 && read(11) === 0x2b7) {
        type = objectTypeOf();
        if (type === 5) return { rate: inRange(read(1) ? rateOf() : core) };
      }
    }
  } catch {
    /* A config shorter than its fields says no more than its core rate. */
  }
  if (core === 0) return null;
  return { rate: core > 24000 ? inRange(core) : null };
}
