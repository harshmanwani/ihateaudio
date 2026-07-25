/**
 * MDX-Net separation: the arithmetic around the network, with no reference to
 * ONNX Runtime.
 *
 * The network itself is a black box that maps one spectrogram to another. What
 * decides whether separation works is everything on either side of it — the
 * chunking, the overlap trimming, the tensor layout, the level compensation — and
 * every one of those is a place to be quietly, inaudibly wrong. So they live here,
 * behind a plain callback, and are checked against a PyTorch reference
 * implementation in tests rather than against the browser.
 *
 * The shape of the algorithm, which is UVR's:
 *
 *   - The model sees fixed-size chunks of `hop * (dimT - 1)` samples, chosen so a
 *     centred STFT yields exactly `dimT` frames.
 *   - Consecutive chunks overlap by `nFft / 2` at each end. That overlap is
 *     discarded from the output, because the frames at a chunk's edge have seen
 *     reflect-padded fiction rather than real audio and are unreliable. What is
 *     kept is the middle, and the kept regions tile the track exactly.
 *   - The network predicts one stem. The other is the residual, `mix - primary`,
 *     which is how UVR produces a second stem and why one download serves both
 *     the vocal remover and the acapella extractor.
 */
import { frameCount, istft, stft, stftPlan } from '../audio/stft';
import type { MdxModel, Stem } from './models';

/** Runs the network on one [1, 4, dimF, dimT] tensor and returns the same shape. */
export type MdxRunner = (input: Float32Array) => Promise<Float32Array>;

export interface MdxProgress {
  /** Chunks finished. */
  done: number;
  /** Chunks in total, known before the first one starts. */
  total: number;
}

export interface MdxGeometry {
  /** Samples the network consumes at once. */
  chunkSize: number;
  /** Samples discarded from each end of a chunk's output. */
  trim: number;
  /** Samples of usable output per chunk. */
  genSize: number;
  /** Frames per chunk, which must equal dimT or the tensor is the wrong shape. */
  frames: number;
}

/**
 * Chunk geometry for a model.
 *
 * Exported because it is worth asserting against the model's declared `dimT` in
 * tests: if `frames` and `dimT` ever disagree, inference fails outright, which is
 * the only loud failure in this whole pipeline and therefore the one to lean on.
 */
export function geometry(model: MdxModel): MdxGeometry {
  const chunkSize = model.hop * (model.dimT - 1);
  const trim = model.nFft >> 1;
  const genSize = chunkSize - 2 * trim;
  if (genSize <= 0) {
    throw new Error(
      `model ${model.id}: nFft ${model.nFft} leaves no usable output in a ${chunkSize}-sample chunk`
    );
  }
  return { chunkSize, trim, genSize, frames: frameCount(chunkSize, model.hop) };
}

/** The stem a model does not predict, which is therefore the residual. */
export function complementOf(primary: Stem): Stem {
  return primary === 'instrumental' ? 'vocals' : 'instrumental';
}

/**
 * Lays one chunk out as the network's input tensor.
 *
 * Channel order is [left real, left imaginary, right real, right imaginary], and
 * within each channel the layout is frequency-major. This ordering is not a
 * convention anyone chose for elegance — it is what falls out of the reshape
 * sequence in the training code, and a plausible-looking alternative (interleaving
 * real and imaginary, say) produces confident nonsense rather than an error.
 */
function pack(
  left: Float64Array,
  right: Float64Array,
  frames: number,
  dimF: number,
  out: Float32Array
): void {
  const perChannel = dimF * frames;
  for (let f = 0; f < frames; f += 1) {
    const base = 2 * f * dimF;
    for (let b = 0; b < dimF; b += 1) {
      const at = b * frames + f;
      out[at] = left[base + 2 * b]!;
      out[perChannel + at] = left[base + 2 * b + 1]!;
      out[2 * perChannel + at] = right[base + 2 * b]!;
      out[3 * perChannel + at] = right[base + 2 * b + 1]!;
    }
  }
}

/** The inverse of `pack`, back into the [frame][bin] order the ISTFT wants. */
function unpack(
  tensor: Float32Array,
  frames: number,
  dimF: number,
  left: Float64Array,
  right: Float64Array
): void {
  const perChannel = dimF * frames;
  for (let f = 0; f < frames; f += 1) {
    const base = 2 * f * dimF;
    for (let b = 0; b < dimF; b += 1) {
      const at = b * frames + f;
      left[base + 2 * b] = tensor[at]!;
      left[base + 2 * b + 1] = tensor[perChannel + at]!;
      right[base + 2 * b] = tensor[2 * perChannel + at]!;
      right[base + 2 * b + 1] = tensor[3 * perChannel + at]!;
    }
  }
}

export interface DemixOptions {
  onProgress?: (progress: MdxProgress) => void;
  signal?: AbortSignal;
}

/**
 * Separates the primary stem out of a stereo signal at 44.1 kHz.
 *
 * Returns the primary stem. The complement is the caller's subtraction, because
 * both tools want to keep the original around anyway and copying it here would
 * double the peak memory on a track that is already large.
 */
export async function demix(
  channels: readonly [Float32Array, Float32Array],
  model: MdxModel,
  run: MdxRunner,
  options: DemixOptions = {}
): Promise<[Float32Array, Float32Array]> {
  const { chunkSize, trim, genSize, frames } = geometry(model);
  if (frames !== model.dimT) {
    throw new Error(
      `model ${model.id}: chunk of ${chunkSize} gives ${frames} frames, not dimT ${model.dimT}`
    );
  }

  const length = channels[0].length;
  if (channels[1].length !== length) {
    throw new Error('channels must be the same length');
  }

  // Pad so the kept regions tile the track exactly: `trim` of lead-in that gets
  // discarded, then whole multiples of genSize, then enough tail for the final
  // chunk to be full width.
  const remainder = length % genSize;
  const tailPad = remainder === 0 ? 0 : genSize - remainder;
  const padded = length + tailPad;
  const total = padded / genSize;

  const plan = stftPlan(model.nFft, model.hop, model.dimF);
  const specLeft = new Float64Array(2 * frames * model.dimF);
  const specRight = new Float64Array(2 * frames * model.dimF);
  const tensor = new Float32Array(4 * model.dimF * frames);

  const out: [Float32Array, Float32Array] = [
    new Float32Array(length),
    new Float32Array(length),
  ];
  const window = [new Float32Array(chunkSize), new Float32Array(chunkSize)] as const;

  options.onProgress?.({ done: 0, total });

  for (let index = 0; index < total; index += 1) {
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    // Copy this chunk out of the source with the virtual padding applied, rather
    // than materialising a padded copy of the whole track. On a ten-minute file
    // that padded copy would be another 200 MB for no reason.
    const start = index * genSize - trim;
    for (let c = 0; c < 2; c += 1) {
      const src = channels[c]!;
      const dst = window[c]!;
      for (let i = 0; i < chunkSize; i += 1) {
        const at = start + i;
        dst[i] = at >= 0 && at < length ? src[at]! : 0;
      }
    }

    stft(window[0]!, plan, specLeft);
    stft(window[1]!, plan, specRight);
    pack(specLeft, specRight, frames, model.dimF, tensor);

    const predicted = await run(tensor);
    if (predicted.length !== tensor.length) {
      throw new Error(
        `model ${model.id} returned ${predicted.length} values, expected ${tensor.length}`
      );
    }
    unpack(predicted, frames, model.dimF, specLeft, specRight);

    const leftChunk = istft(specLeft, frames, plan, chunkSize);
    const rightChunk = istft(specRight, frames, plan, chunkSize);

    // Keep only the middle. The edges saw reflect-padded fiction.
    const keepFrom = index * genSize;
    const keepCount = Math.min(genSize, length - keepFrom);
    for (let i = 0; i < keepCount; i += 1) {
      out[0][keepFrom + i] = leftChunk[trim + i]! * model.compensate;
      out[1][keepFrom + i] = rightChunk[trim + i]! * model.compensate;
    }

    options.onProgress?.({ done: index + 1, total });
  }

  return out;
}

/**
 * `mix - primary`, the derived stem.
 *
 * Kept separate and honest about what it is: subtracting the compensated primary
 * can push samples past full scale where the model over-predicted, so the result
 * is peak-limited only if it actually clips, which leaves the common case
 * untouched.
 */
export function residual(
  channels: readonly [Float32Array, Float32Array],
  primary: readonly [Float32Array, Float32Array]
): [Float32Array, Float32Array] {
  const out: [Float32Array, Float32Array] = [
    new Float32Array(channels[0].length),
    new Float32Array(channels[1].length),
  ];
  let peak = 0;
  for (let c = 0; c < 2; c += 1) {
    const src = channels[c]!;
    const cut = primary[c]!;
    const dst = out[c]!;
    for (let i = 0; i < dst.length; i += 1) {
      const v = src[i]! - cut[i]!;
      dst[i] = v;
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
  }
  if (peak > 1) {
    const scale = 1 / peak;
    for (let c = 0; c < 2; c += 1) {
      const dst = out[c]!;
      for (let i = 0; i < dst.length; i += 1) dst[i] = dst[i]! * scale;
    }
  }
  return out;
}
