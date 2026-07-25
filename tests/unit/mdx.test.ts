/**
 * The separation pipeline without the network.
 *
 * The trick that makes this testable at all: replace the model with an identity
 * function. A network that returns its input unchanged means the whole pipeline
 * reduces to STFT then ISTFT, so the output must be the input back again. That one
 * assertion covers the chunk geometry, the padding, the overlap trimming, the
 * tensor packing and unpacking, and the tiling of kept regions — every part where
 * a mistake would otherwise show up only as slightly disappointing audio.
 *
 * The real models were checked separately against a PyTorch and onnxruntime
 * reference implementation, which agreed to 126 dB, and the parameters they need
 * were settled by measured SDR. Both of those need a 64 MB download, so they live
 * in scripts/verify-ai.mjs rather than here.
 */
import { describe, expect, it } from 'vitest';
import { complementOf, demix, geometry, residual } from '../../src/lib/ai/mdx';
import { INST_HQ3, KUIELAB, MDX_MODELS, type MdxModel } from '../../src/lib/ai/models';

/** Returns its input, so the pipeline should reconstruct the original audio. */
const identity = async (input: Float32Array): Promise<Float32Array> => input.slice();

function noise(length: number, seed: number): Float32Array {
  const out = new Float32Array(length);
  // Deterministic, so a failure is reproducible.
  let state = seed;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = (state / 0xffffffff) * 1.6 - 0.8;
  }
  return out;
}

/**
 * Band-limited test signal, which is what the reconstruction tests need.
 *
 * The pipeline keeps only the lowest `dimF` bins because that is what the models
 * read — MDX-Net's spectrogram input is cropped, which is why separated stems have
 * a characteristic high-frequency ceiling. So an identity model cannot return
 * broadband input unchanged, and should not: white noise reconstructs to about
 * 33 dB purely because 1/2049 of its energy sits in the discarded Nyquist bin.
 * Testing reconstruction therefore means testing it on content the models would
 * actually preserve.
 */
function lowTones(length: number, seed: number): Float32Array {
  const out = new Float32Array(length);
  const partials = [0.0031, 0.0117, 0.0263, 0.0519];
  for (let i = 0; i < length; i += 1) {
    let v = 0;
    for (let p = 0; p < partials.length; p += 1) {
      v += Math.sin(2 * Math.PI * partials[p]! * i + seed + p) / (p + 2);
    }
    out[i] = v * 0.5;
  }
  return out;
}

function snrDb(got: Float32Array, want: Float32Array, gain: number): number {
  let signal = 0;
  let error = 0;
  for (let i = 0; i < want.length; i += 1) {
    const target = want[i]! * gain;
    signal += target * target;
    const d = got[i]! - target;
    error += d * d;
  }
  return 10 * Math.log10(signal / (error || 1e-30));
}

describe('geometry', () => {
  it.each(MDX_MODELS.map((m) => [m.id, m] as const))(
    '%s produces exactly dimT frames per chunk',
    (_id, model) => {
      const g = geometry(model as MdxModel);
      // If these disagree the tensor is the wrong shape and inference throws,
      // which is the single loud failure mode in this pipeline.
      expect(g.frames).toBe((model as MdxModel).dimT);
      expect(g.genSize).toBeGreaterThan(0);
      expect(g.chunkSize).toBe(g.genSize + 2 * g.trim);
    }
  );

  it('matches the reference arithmetic for the instrumental model', () => {
    const g = geometry(INST_HQ3);
    expect(g.chunkSize).toBe(261_120);
    expect(g.trim).toBe(3072);
    expect(g.genSize).toBe(254_976);
  });

  it('rejects a model whose transform would swallow the whole chunk', () => {
    const broken: MdxModel = { ...KUIELAB.drums, nFft: 1_048_576 };
    expect(() => geometry(broken)).toThrow(/no usable output/);
  });
});

describe('complementOf', () => {
  it('pairs vocals and instrumental both ways', () => {
    expect(complementOf('instrumental')).toBe('vocals');
    expect(complementOf('vocals')).toBe('instrumental');
  });

  it('treats a four-stem model as leaving the instrumental behind', () => {
    // Removing drums from a mix leaves everything else, which the UI describes
    // as the backing rather than as "vocals".
    expect(complementOf('drums')).toBe('instrumental');
    expect(complementOf('bass')).toBe('instrumental');
  });
});

describe('demix', () => {
  /**
   * The central test. Reconstruction has to hold for a length that is not a
   * whole number of chunks, because that is the normal case and the tail is where
   * off-by-one padding errors live.
   */
  it('reconstructs the input when the model is the identity', async () => {
    const model = KUIELAB.drums;
    const { genSize } = geometry(model);
    const length = genSize * 2 + 12_345;
    const input: [Float32Array, Float32Array] = [lowTones(length, 1), lowTones(length, 2)];

    const out = await demix(input, model, identity);

    expect(out[0].length).toBe(length);
    expect(snrDb(out[0], input[0], model.compensate)).toBeGreaterThan(100);
    expect(snrDb(out[1], input[1], model.compensate)).toBeGreaterThan(100);
  }, 120_000);

  /**
   * The two cases below reconstruct to 80-100 dB rather than the 100+ dB a full
   * multi-chunk track manages, and that is expected rather than a shortfall. Both
   * are one chunk or less, so almost all of the chunk is padding, and the error
   * from the one discarded bin is spread over the whole chunk while only the real
   * samples are measured. 70 dB is four orders of magnitude below anything
   * audible; the bar is here to catch a structural mistake, not to chase digits.
   */
  it('reconstructs audio shorter than a single chunk', async () => {
    const model = KUIELAB.drums;
    const input: [Float32Array, Float32Array] = [lowTones(5_000, 3), lowTones(5_000, 4)];
    const out = await demix(input, model, identity);
    expect(out[0].length).toBe(5_000);
    expect(snrDb(out[0], input[0], model.compensate)).toBeGreaterThan(70);
  }, 60_000);

  it('reconstructs a length that is an exact multiple of the kept region', async () => {
    // The padding arithmetic has a special case here, and getting it wrong adds
    // a whole spurious chunk or drops the last one.
    const model = KUIELAB.drums;
    const { genSize } = geometry(model);
    const input: [Float32Array, Float32Array] = [lowTones(genSize, 5), lowTones(genSize, 6)];
    const out = await demix(input, model, identity);
    expect(out[0].length).toBe(genSize);
    expect(snrDb(out[0], input[0], model.compensate)).toBeGreaterThan(70);
  }, 60_000);

  it('reports progress that ends at the total it promised', async () => {
    const model = KUIELAB.drums;
    const { genSize } = geometry(model);
    const length = genSize * 3 - 100;
    const input: [Float32Array, Float32Array] = [noise(length, 7), noise(length, 8)];

    const seen: number[] = [];
    let total = -1;
    await demix(input, model, identity, {
      onProgress: (p) => {
        seen.push(p.done);
        total = p.total;
      },
    });
    expect(total).toBe(3);
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(3);
  }, 120_000);

  it('stops when aborted rather than running to completion', async () => {
    const model = KUIELAB.drums;
    const { genSize } = geometry(model);
    const length = genSize * 3;
    const input: [Float32Array, Float32Array] = [noise(length, 9), noise(length, 10)];
    const controller = new AbortController();

    await expect(
      demix(input, model, identity, {
        signal: controller.signal,
        onProgress: ({ done }) => {
          if (done === 1) controller.abort();
        },
      })
    ).rejects.toThrow(/abort/i);
  }, 120_000);

  it('refuses mismatched channel lengths instead of reading past the end', async () => {
    await expect(
      demix([new Float32Array(1000), new Float32Array(900)], KUIELAB.drums, identity)
    ).rejects.toThrow(/same length/);
  });

  it('surfaces a model that returns the wrong number of values', async () => {
    const short = async (input: Float32Array) => input.slice(0, input.length - 1);
    await expect(
      demix([new Float32Array(4000), new Float32Array(4000)], KUIELAB.drums, short)
    ).rejects.toThrow(/expected/);
  }, 60_000);
});

describe('residual', () => {
  it('is the difference between the mix and the extracted stem', () => {
    const mix: [Float32Array, Float32Array] = [
      Float32Array.from([0.5, 0.25, -0.5]),
      Float32Array.from([0.1, 0.2, 0.3]),
    ];
    const stem: [Float32Array, Float32Array] = [
      Float32Array.from([0.2, 0.25, -0.1]),
      Float32Array.from([0.1, 0.0, 0.3]),
    ];
    const out = residual(mix, stem);
    expect(Array.from(out[0])).toEqual([0.3, 0, -0.4].map((v) => Math.fround(v)));
    expect(Array.from(out[1])).toEqual([0, 0.2, 0].map((v) => Math.fround(v)));
  });

  it('scales down only when subtraction actually clips', () => {
    // The model over-predicting its stem can push the residual past full scale.
    // Clipping it would be worse than a small global attenuation, but attenuating
    // audio that never clipped would quietly make every result quieter.
    const mix: [Float32Array, Float32Array] = [
      Float32Array.from([0.9, -0.9]),
      Float32Array.from([0, 0]),
    ];
    const stem: [Float32Array, Float32Array] = [
      Float32Array.from([-0.9, 0.9]),
      Float32Array.from([0, 0]),
    ];
    const clipped = residual(mix, stem);
    expect(Math.max(...Array.from(clipped[0]).map(Math.abs))).toBeCloseTo(1, 6);

    const quiet = residual(
      [Float32Array.from([0.2, -0.2]), Float32Array.from([0, 0])],
      [Float32Array.from([0.1, -0.1]), Float32Array.from([0, 0])]
    );
    expect(Array.from(quiet[0])).toEqual([0.1, -0.1].map((v) => Math.fround(v)));
  });
});
