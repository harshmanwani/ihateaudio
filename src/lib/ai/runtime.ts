/**
 * ONNX Runtime setup.
 *
 * Small file, but every line in it is load-bearing, and all of them were arrived
 * at by something going wrong first.
 */
import * as ort from 'onnxruntime-web/wasm';
import { ORT_VERSION } from './ort-version';

let configured = false;

/**
 * Points the runtime at our own copy of its WebAssembly and decides how many
 * threads it may use.
 *
 * The import is `onnxruntime-web/wasm` rather than `onnxruntime-web`, which drops
 * the WebGPU and WebGL execution providers. That takes the JavaScript from 390 KB
 * to 70 KB, and neither provider would be used: MDX-Net on WebGPU needs the .jsep
 * WebAssembly build, which is 25.6 MB and therefore over Cloudflare's 25 MiB
 * per-asset ceiling, so shipping it would break the deploy.
 */
export function configureRuntime(): void {
  if (configured) return;
  configured = true;

  // Vite bundles the loader into /_astro/<hash>.js, after which the runtime's own
  // relative resolution looks for /_astro/ort-wasm-simd-threaded.wasm and finds
  // nothing. Naming the real path is the only reliable fix, and the default it
  // replaces is a jsDelivr URL — a third-party request this site should never make.
  ort.env.wasm.wasmPaths = `/ort/${ORT_VERSION}/`;

  /**
   * Threads need SharedArrayBuffer, which needs the page to be cross-origin
   * isolated. The AI pages send COOP and COEP for exactly this reason, and it is
   * worth a great deal: separation is compute-bound and close to real time on one
   * thread, so a four-minute song takes four minutes single-threaded and closer to
   * one on four threads.
   *
   * Capped at four rather than using every core. Beyond that the gain flattens —
   * these are memory-bandwidth-bound convolutions — while the cost of leaving a
   * phone with no spare core is a page that stops scrolling smoothly.
   */
  const isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
  const cores = navigator.hardwareConcurrency || 1;
  ort.env.wasm.numThreads = isolated ? Math.max(1, Math.min(4, cores - 1)) : 1;

  // SIMD is a decade old at this point and the fallback path is several times
  // slower; a browser without it cannot run these models usefully anyway.
  ort.env.wasm.simd = true;

  // The runtime is chatty at the default level and none of it is actionable.
  ort.env.logLevel = 'error';
}

/** True when the page can actually use threads, for the setup panel's estimate. */
export function threadsAvailable(): boolean {
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
}

export interface Session {
  run(input: Float32Array, dims: readonly number[]): Promise<Float32Array>;
  release(): Promise<void>;
}

/**
 * Creates an inference session from model bytes already in memory.
 *
 * Takes bytes rather than a URL on purpose: the download, its progress reporting,
 * its cache and its integrity check all live in store.ts, and handing the runtime
 * a URL would duplicate that badly — it has no progress events and no checksum.
 */
export async function createSession(bytes: ArrayBuffer): Promise<Session> {
  configureRuntime();

  const session = await ort.InferenceSession.create(bytes, {
    executionProviders: ['wasm'],
    // These models are a fixed graph run repeatedly on identically-shaped input,
    // which is the case extended optimisation is for.
    graphOptimizationLevel: 'all',
    // Sequential rather than parallel: the parallel executor spends its time on
    // synchronisation for a graph this shape, and intra-op threading is where the
    // actual gain is.
    executionMode: 'sequential',
  });

  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  if (!inputName || !outputName) {
    throw new Error('model has no input or output tensor');
  }

  return {
    async run(input: Float32Array, dims: readonly number[]): Promise<Float32Array> {
      const tensor = new ort.Tensor('float32', input, dims as number[]);
      const result = await session.run({ [inputName]: tensor });
      const output = result[outputName];
      if (!output) throw new Error(`model produced no ${outputName} tensor`);
      const data = output.data;
      if (!(data instanceof Float32Array)) {
        throw new Error(`model returned ${typeof data} rather than float32`);
      }
      return data;
    },
    async release(): Promise<void> {
      // Releasing matters more here than usual: a session holds its weights in
      // the WebAssembly heap, and 64 MB that is never freed is 64 MB a phone
      // notices.
      await session.release();
    },
  };
}
