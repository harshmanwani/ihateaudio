/**
 * The model catalogue: what each network is, how it must be fed, and where it
 * lives.
 *
 * Every number in the MDX entries below was measured rather than copied. The
 * ONNX graphs give `dimF` and `dimT` authoritatively, but `nFft` is a
 * training-time convention that appears nowhere in the file, and the usual
 * lookup — UVR keys its parameter table by the model's MD5 — does not resolve,
 * because the ONNX exports in circulation are not byte-identical to the files
 * that table was built from.
 *
 * So they were settled experimentally, with a mix built from a known instrumental
 * plus known speech so that ground truth existed:
 *
 *   - Inst_HQ_3 at nFft 6144 scored 14.22 dB SDR against the true instrumental
 *     versus 12.54 dB at 7680, and 29.54 dB versus 20.28 dB on a passthrough
 *     test (feed it an already-instrumental signal and see how intact it comes
 *     back). The passthrough gap is the decisive one: a wrong transform size
 *     cannot reconstruct cleanly no matter what the network does.
 *   - The four-stem set's per-stem sizes beat a deliberately swapped control by
 *     7.03 dB on whether the four estimated stems sum back to the mix.
 *
 * The procedure is kept in scripts/verify-ai.mjs so the numbers can be
 * reproduced rather than trusted.
 */

/** Bump when any object under the prefix changes. The path is cached forever. */
export const MODELS_VERSION = 'v1';

export type Stem = 'vocals' | 'instrumental' | 'drums' | 'bass' | 'other';

export interface MdxModel {
  kind: 'mdx';
  id: string;
  /** Object name under `/models/<version>/`. */
  file: string;
  bytes: number;
  /** SHA-256 of the object, checked after download. */
  sha256: string;
  /** Frequency bins fed to the network, from the ONNX graph. */
  dimF: number;
  /** Time frames per chunk, from the ONNX graph. */
  dimT: number;
  /** Transform size. Measured — see the note above. */
  nFft: number;
  /** Fixed across every MDX-Net model. */
  hop: 1024;
  /**
   * Output gain the model was trained to expect.
   *
   * MDX-Net systematically under-predicts its stem's level, and UVR applies a
   * per-model correction on the way out. 1.035 is the value shared by this whole
   * family.
   */
  compensate: number;
  /** The stem the network predicts directly. Its complement is derived. */
  primary: Stem;
}

/**
 * The instrumental model, used by the vocal remover and the acapella extractor.
 *
 * One model serves both because MDX predicts one stem and the other is the
 * residual, `mix - primary`. That is how UVR itself produces the second stem, and
 * it means a visitor who has used either tool already has what the other needs —
 * which matters a great deal when the alternative is a second 64 MB download.
 *
 * Predicting the instrumental directly rather than the vocals is deliberate: the
 * karaoke case is the far more common one, and the directly-predicted stem is
 * always the cleaner of the two.
 *
 * dimF 3072 with nFft 6144 keeps every bin except Nyquist, so this model is
 * full-band. That is what the HQ in its name refers to, and why it is worth four
 * times the download of the smaller ones.
 */
export const INST_HQ3: MdxModel = {
  kind: 'mdx',
  id: 'inst-hq3',
  file: 'inst-hq3.onnx',
  bytes: 66_759_214,
  sha256: '317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc',
  dimF: 3072,
  dimT: 256,
  nFft: 6144,
  hop: 1024,
  compensate: 1.035,
  primary: 'instrumental',
};

/**
 * The four-stem set. Each stem is a separate network with its own transform
 * size, which is why they are listed individually rather than derived.
 *
 * These are a quarter the size of the instrumental model each, but four of them
 * is four passes over the audio. The splitter therefore lets people pick the
 * stems they want instead of always running all four.
 */
export const KUIELAB: Record<'vocals' | 'drums' | 'bass' | 'other', MdxModel> = {
  vocals: {
    kind: 'mdx',
    id: 'kuielab-vocals',
    file: 'kuielab-vocals.onnx',
    bytes: 29_703_204,
    sha256: 'daba83c2ee1afee9139766ad64c9b6808d6b6f092fff04bed3338be50baac721',
    dimF: 2048,
    dimT: 512,
    nFft: 6144,
    hop: 1024,
    compensate: 1.035,
    primary: 'vocals',
  },
  drums: {
    kind: 'mdx',
    id: 'kuielab-drums',
    file: 'kuielab-drums.onnx',
    bytes: 29_703_204,
    sha256: '40f586b7091934dd6f5563f0cba8f14bad57ce88440da1098bf388ea716c2901',
    dimF: 2048,
    dimT: 512,
    nFft: 4096,
    hop: 1024,
    compensate: 1.035,
    primary: 'drums',
  },
  bass: {
    kind: 'mdx',
    id: 'kuielab-bass',
    file: 'kuielab-bass.onnx',
    bytes: 29_703_204,
    sha256: '0c3e77b9963185b1ea6bb46a4b8924137d9370fc1ccdefec7b1b416ef550dcaa',
    dimF: 2048,
    dimT: 512,
    // The largest transform in the set, and the reason the mixed-radix FFT had
    // to handle 16384 as well as the awkward sizes: bass needs the frequency
    // resolution far more than it needs the time resolution.
    nFft: 16384,
    hop: 1024,
    compensate: 1.035,
    primary: 'bass',
  },
  other: {
    kind: 'mdx',
    id: 'kuielab-other',
    file: 'kuielab-other.onnx',
    bytes: 29_703_204,
    sha256: '7b67a1dcb5f232153528c59960b4c7bf8dc736b8114de360af0e719633f53358',
    dimF: 2048,
    dimT: 512,
    nFft: 8192,
    hop: 1024,
    compensate: 1.035,
    primary: 'other',
  },
};

/** Every MDX network, for the setup panel's size arithmetic. */
export const MDX_MODELS: MdxModel[] = [INST_HQ3, ...Object.values(KUIELAB)];

/**
 * MDX-Net is a 44.1 kHz model family. Feeding it anything else does not fail, it
 * simply shifts every frequency the network learned, so the input is resampled
 * before separation and the result is resampled back.
 */
export const MDX_RATE = 44100;

/**
 * Whisper, for transcription and subtitles.
 *
 * `tiny.en` rather than a larger or multilingual variant: at 41 MB across its
 * two graphs it is the only one small enough to sit behind a one-time download
 * without the download itself becoming the reason nobody uses the tool. The
 * quantized graphs are what the size figure refers to; the float32 pair is four
 * times larger for a difference that does not survive contact with a phone
 * recording.
 */
export const WHISPER = {
  kind: 'whisper' as const,
  id: 'whisper-tiny-en',
  /** Directory under `/models/<version>/`, laid out as transformers.js expects. */
  dir: 'whisper-tiny-en',
  /** Whisper's fixed input rate. Not negotiable — the mel filterbank assumes it. */
  rate: 16000,
  /** Whisper reasons over 30-second windows, padded if the audio is shorter. */
  windowSeconds: 30,
};

/** Total bytes a tool needs before it can run, for the setup panel. */
export function downloadSize(models: { bytes: number }[]): number {
  return models.reduce((total, model) => total + model.bytes, 0);
}
