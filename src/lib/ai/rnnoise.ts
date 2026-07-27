/**
 * RNNoise, driven directly rather than through an AudioWorklet.
 *
 * The obvious way to run this is the packaged `RnnoiseWorkletNode`, and that is what
 * this tool used to do. It does not work offline, and the reason is worth writing
 * down because nothing about it announces itself.
 *
 * The packaged processor loads its WebAssembly in an async IIFE from its
 * constructor, and its `process()` begins:
 *
 *     process(inputs, outputs) {
 *       return ... || !this.processor || this.processor.process(...), true
 *     }
 *
 * Until the WASM finishes instantiating, `this.processor` is undefined, the
 * expression short-circuits, and the output array is never written — so it stays
 * zeros. On a live AudioContext that is a few milliseconds of silence at the top
 * that nobody hears. Inside an OfflineAudioContext, `startRendering()` runs the
 * whole file as fast as the machine allows and finishes long before the WASM is
 * ready, so *every* frame takes the short-circuit and the entire result is silence.
 * It is a race the offline renderer wins every time, which is why the failure looked
 * deterministic rather than flaky.
 *
 * There is no readiness signal to wait on, so the fix is to stop using the worklet.
 * The compiled module exports `malloc`, `free` and the four `rnnoise_*` entry points
 * directly and imports only three trivial `env` functions, so it can be instantiated
 * and called straight from ordinary JavaScript with no Emscripten glue and no audio
 * graph at all. RNNoise is a pure frame function; it never needed to be a node.
 *
 * Keeping this file free of `?url` imports is deliberate: it takes bytes, not a URL,
 * so the numeric core can be tested in Node against real fixtures. The fetching
 * lives in denoise.ts.
 */

/** RNNoise is built for 48 kHz and its band layout is defined in terms of that rate. */
export const RNNOISE_RATE = 48000;

/** Samples per call. Confirmed against `rnnoise_get_frame_size()` at load. */
export const RNNOISE_FRAME = 480;

/**
 * Input-to-output delay, in samples, measured rather than assumed.
 *
 * Cross-correlating real speech against its denoised self puts the peak at exactly
 * one frame (0.99 correlation). It comes from the overlap-add window inside RNNoise.
 * This matters for two reasons: the result has to be shifted back by this much or the
 * cleaned file sits 10 ms late against the original, and a dry/wet blend that ignores
 * it is mixing a signal with a delayed copy of itself, which is a comb filter rather
 * than a blend.
 */
export const RNNOISE_DELAY = 480;

interface RnnoiseExports {
  memory: WebAssembly.Memory;
  __wasm_call_ctors?: () => void;
  rnnoise_get_frame_size: () => number;
  rnnoise_create: (model: number) => number;
  rnnoise_destroy: (state: number) => void;
  rnnoise_process_frame: (state: number, output: number, input: number) => number;
  malloc: (bytes: number) => number;
  free: (pointer: number) => void;
}

/**
 * One independent denoiser.
 *
 * RNNoise is mono and carries state between frames — it is a recurrent network, so
 * what it heard a moment ago is part of how it judges now. A stereo file therefore
 * needs two of these, never one used twice, or the two channels contaminate each
 * other's noise estimate.
 */
export interface RnnoiseState {
  /**
   * Denoises 480 samples in place, in ordinary -1..1 float units.
   *
   * Returns the model's own voice probability for the frame, which is a genuinely
   * useful thing to have: it is how the tool can report whether it found speech at
   * all rather than only how much quieter the file got.
   */
  process(frame: Float32Array): number;
  destroy(): void;
}

export interface RnnoiseModule {
  createState(): RnnoiseState;
}

/**
 * The three functions the module imports.
 *
 * All of them are Emscripten's, and all three are a few lines when the module owns
 * its own memory (this one exports `memory` rather than importing it, so there is no
 * heap to hand in).
 */
function imports(getExports: () => RnnoiseExports): WebAssembly.Imports {
  return {
    env: {
      // Both pointers are offsets into the module's own heap, so this is a move
      // within one buffer rather than a copy between two.
      emscripten_memcpy_big: (dest: number, src: number, count: number): number => {
        new Uint8Array(getExports().memory.buffer).copyWithin(dest, src, src + count);
        return dest;
      },
      // Grow to at least `requested` bytes: 1 for grew, 0 for refused. In practice
      // this is never called — the denoise state and two frame buffers fit the
      // initial heap — but a module that cannot grow at all fails obscurely later.
      emscripten_resize_heap: (requested: number): number => {
        const memory = getExports().memory;
        const short = requested - memory.buffer.byteLength;
        if (short <= 0) return 1;
        try {
          memory.grow(Math.ceil(short / 65536));
          return 1;
        } catch {
          return 0;
        }
      },
      __assert_fail: (): never => {
        throw new Error('RNNoise hit an internal assertion.');
      },
    },
  };
}

/**
 * Instantiates the module from bytes already in hand.
 *
 * Async only because WebAssembly instantiation is — everything after this point is
 * synchronous, which is the entire point of the exercise.
 */
export async function loadRnnoise(binary: BufferSource): Promise<RnnoiseModule> {
  let exports: RnnoiseExports | null = null;

  // Typed as BufferSource rather than a union of ArrayBuffer and Uint8Array, which
  // sends TypeScript to the `instantiate(Module)` overload and loses `.instance`.
  const { instance } = await WebAssembly.instantiate(
    binary,
    imports(() => {
      if (!exports) throw new Error('RNNoise called out before it finished loading.');
      return exports;
    })
  );

  exports = instance.exports as unknown as RnnoiseExports;
  // Emscripten's static constructors. Skipping this leaves the module's globals
  // uninitialised and it fails in ways that look like corrupt audio.
  exports.__wasm_call_ctors?.();

  const frameSize = exports.rnnoise_get_frame_size();
  if (frameSize !== RNNOISE_FRAME) {
    throw new Error(`RNNoise reported a frame size of ${frameSize}, expected ${RNNOISE_FRAME}.`);
  }

  return { createState: () => createState(exports!) };
}

function createState(exports: RnnoiseExports): RnnoiseState {
  const state = exports.rnnoise_create(0);
  if (!state) throw new Error('RNNoise could not allocate a denoise state.');

  const inputPtr = exports.malloc(RNNOISE_FRAME * 4);
  const outputPtr = exports.malloc(RNNOISE_FRAME * 4);
  if (!inputPtr || !outputPtr) {
    exports.rnnoise_destroy(state);
    throw new Error('RNNoise could not allocate its frame buffers.');
  }

  const inputIndex = inputPtr >> 2;
  const outputIndex = outputPtr >> 2;

  /**
   * Cached heap view, revalidated by identity.
   *
   * `memory.grow()` detaches every existing view, so a view held across a call that
   * might grow the heap becomes a zero-length array and silently writes nothing.
   * Comparing the backing buffer is a pointer check per frame and removes the whole
   * class of bug.
   */
  let heap: Float32Array | null = null;
  const floats = (): Float32Array => {
    if (!heap || heap.buffer !== exports.memory.buffer) {
      heap = new Float32Array(exports.memory.buffer);
    }
    return heap;
  };

  let alive = true;

  return {
    process(frame: Float32Array): number {
      if (!alive) throw new Error('This denoise state has already been destroyed.');
      if (frame.length !== RNNOISE_FRAME) {
        throw new Error(`Expected ${RNNOISE_FRAME} samples, got ${frame.length}.`);
      }

      const view = floats();
      // RNNoise works in int16 units held as floats — a quirk of the original C
      // library that every binding has to honour. Scaling up on the way in and back
      // down on the way out keeps callers in ordinary -1..1 audio.
      for (let i = 0; i < RNNOISE_FRAME; i += 1) {
        view[inputIndex + i] = frame[i]! * 32767;
      }

      const voice = exports.rnnoise_process_frame(state, outputPtr, inputPtr);

      const after = floats();
      for (let i = 0; i < RNNOISE_FRAME; i += 1) {
        frame[i] = after[outputIndex + i]! / 32767;
      }
      return voice;
    },

    destroy(): void {
      if (!alive) return;
      alive = false;
      exports.rnnoise_destroy(state);
      exports.free(inputPtr);
      exports.free(outputPtr);
    },
  };
}
