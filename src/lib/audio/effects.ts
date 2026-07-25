/**
 * Effects rendered through an OfflineAudioContext graph.
 *
 * Anything the browser's own DSP nodes already do well — filters, convolution,
 * HRTF panning, dynamics — is cheaper and better done here than reimplemented
 * in JS. Rendering is off the main thread inside the audio engine, so long
 * files don't lock the interface.
 */
import { createBuffer } from './dsp';

export interface EqBand {
  frequency: number;
  gain: number;
  q?: number;
  type?: BiquadFilterType;
}

/**
 * Builds a graph from source to destination and renders it. `build` returns
 * the last node in the chain; the helper connects it to the destination.
 */
export async function renderThrough(
  buffer: AudioBuffer,
  build: (ctx: OfflineAudioContext, source: AudioBufferSourceNode) => AudioNode,
  lengthScale = 1
): Promise<AudioBuffer> {
  const length = Math.max(1, Math.ceil(buffer.length * lengthScale));
  const ctx = new OfflineAudioContext(
    buffer.numberOfChannels,
    length,
    buffer.sampleRate
  );

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const tail = build(ctx, source);
  tail.connect(ctx.destination);
  source.start(0);

  return ctx.startRendering();
}

/** Filter types whose effect comes from gain — a 0 dB band is a no-op. */
const GAIN_TYPES = new Set<BiquadFilterType>(['peaking', 'lowshelf', 'highshelf']);

/** Multi-band parametric EQ. Bands run in series, as on a real console. */
export function applyEq(buffer: AudioBuffer, bands: EqBand[]): Promise<AudioBuffer> {
  // Drop flat gain bands, but keep lowpass/highpass/notch, which shape the
  // signal regardless of their gain value.
  const active = bands.filter((b) => {
    const type = b.type ?? 'peaking';
    return !GAIN_TYPES.has(type) || Math.abs(b.gain) > 0.01;
  });
  if (active.length === 0) return Promise.resolve(buffer);

  return renderThrough(buffer, (ctx, source) => {
    let node: AudioNode = source;
    for (const band of active) {
      const filter = ctx.createBiquadFilter();
      filter.type = band.type ?? 'peaking';
      filter.frequency.value = band.frequency;
      filter.gain.value = band.gain;
      filter.Q.value = band.q ?? 1;
      node.connect(filter);
      node = filter;
    }
    return node;
  });
}

/**
 * Low shelf at 100 Hz. A shelf rather than a peak because "more bass" means
 * everything below the corner, not a bump at one frequency.
 */
export function bassBoost(buffer: AudioBuffer, decibels: number): Promise<AudioBuffer> {
  return applyEq(buffer, [
    { frequency: 100, gain: decibels, q: 0.7, type: 'lowshelf' },
  ]);
}

export function trebleBoost(buffer: AudioBuffer, decibels: number): Promise<AudioBuffer> {
  return applyEq(buffer, [
    { frequency: 6000, gain: decibels, q: 0.7, type: 'highshelf' },
  ]);
}

/**
 * Generates a reverb impulse response: decaying noise, slightly darker on the
 * tail so it sounds like a room rather than a burst of static.
 */
export function makeImpulseResponse(
  sampleRate: number,
  seconds: number,
  decay = 2.2
): AudioBuffer {
  const length = Math.max(1, Math.floor(sampleRate * seconds));
  const ir = createBuffer(2, length, sampleRate);

  for (let c = 0; c < 2; c += 1) {
    const data = ir.getChannelData(c);
    let smoothed = 0;
    for (let i = 0; i < length; i += 1) {
      const t = i / length;
      const envelope = (1 - t) ** decay;
      const noise = Math.random() * 2 - 1;
      // One-pole lowpass rolls the tail off, which reads as air absorption.
      smoothed += (noise - smoothed) * 0.42;
      data[i] = smoothed * envelope;
    }
  }
  return ir;
}

export interface ReverbOptions {
  /** Tail length in seconds. */
  decay?: number;
  /** 0 = dry only, 1 = wet only. */
  mix?: number;
  preDelay?: number;
}

export function applyReverb(
  buffer: AudioBuffer,
  options: ReverbOptions = {}
): Promise<AudioBuffer> {
  const { decay = 2.5, mix = 0.35, preDelay = 0.02 } = options;
  const wet = Math.min(1, Math.max(0, mix));

  // Extend the render so the tail isn't cut off mid-decay.
  const scale = 1 + (decay + preDelay) / Math.max(0.001, buffer.duration);

  return renderThrough(
    buffer,
    (ctx, source) => {
      const merge = ctx.createGain();

      const dry = ctx.createGain();
      dry.gain.value = 1 - wet;
      source.connect(dry).connect(merge);

      const delay = ctx.createDelay(1);
      delay.delayTime.value = preDelay;

      const convolver = ctx.createConvolver();
      convolver.buffer = makeImpulseResponse(ctx.sampleRate, decay);

      const wetGain = ctx.createGain();
      wetGain.gain.value = wet;

      source.connect(delay).connect(convolver).connect(wetGain).connect(merge);
      return merge;
    },
    scale
  );
}

export interface EchoOptions {
  delay?: number;
  feedback?: number;
  mix?: number;
}

export function applyEcho(
  buffer: AudioBuffer,
  options: EchoOptions = {}
): Promise<AudioBuffer> {
  const { delay = 0.3, feedback = 0.35, mix = 0.4 } = options;
  const fb = Math.min(0.85, Math.max(0, feedback));
  const wet = Math.min(1, Math.max(0, mix));

  // Repeats decay by `fb` each pass; stop extending once they're inaudible.
  const repeats = fb > 0.01 ? Math.log(0.001) / Math.log(fb) : 1;
  const tail = delay * Math.min(24, repeats);
  const scale = 1 + tail / Math.max(0.001, buffer.duration);

  return renderThrough(
    buffer,
    (ctx, source) => {
      const merge = ctx.createGain();

      const dry = ctx.createGain();
      dry.gain.value = 1 - wet * 0.5;
      source.connect(dry).connect(merge);

      const delayNode = ctx.createDelay(Math.max(1, delay * 2));
      delayNode.delayTime.value = delay;

      const feedbackGain = ctx.createGain();
      feedbackGain.gain.value = fb;

      const wetGain = ctx.createGain();
      wetGain.gain.value = wet;

      source.connect(delayNode);
      delayNode.connect(feedbackGain).connect(delayNode);
      delayNode.connect(wetGain).connect(merge);

      return merge;
    },
    scale
  );
}

/**
 * The "8D audio" effect: the source orbits the listener's head using HRTF
 * panning, which is what produces the sense of movement outside the skull
 * rather than simple left-right panning between the speakers.
 */
export function apply8D(
  buffer: AudioBuffer,
  rotationSeconds = 12,
  radius = 3
): Promise<AudioBuffer> {
  const period = Math.max(2, rotationSeconds);

  return renderThrough(buffer, (ctx, source) => {
    const panner = ctx.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.maxDistance = 100;
    panner.rolloffFactor = 0.6;

    // Automate a circular path. 24 steps per rotation is dense enough that the
    // linear ramps between them read as continuous motion.
    const stepsPerRotation = 24;
    const rotations = Math.ceil(buffer.duration / period) + 1;
    const totalSteps = stepsPerRotation * rotations;
    const stepTime = period / stepsPerRotation;

    for (let i = 0; i <= totalSteps; i += 1) {
      const t = i * stepTime;
      const angle = (i / stepsPerRotation) * Math.PI * 2;
      panner.positionX.linearRampToValueAtTime(Math.sin(angle) * radius, t);
      panner.positionZ.linearRampToValueAtTime(Math.cos(angle) * radius, t);
      panner.positionY.linearRampToValueAtTime(0, t);
    }

    source.connect(panner);
    return panner;
  });
}

/** Stereo width: 0 collapses to mono, 1 is unchanged, 2 exaggerates. */
export function setStereoWidth(buffer: AudioBuffer, width: number): AudioBuffer {
  if (buffer.numberOfChannels < 2) return buffer;
  const w = Math.max(0, Math.min(3, width));
  const out = createBuffer(2, buffer.length, buffer.sampleRate);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const outL = out.getChannelData(0);
  const outR = out.getChannelData(1);

  for (let i = 0; i < buffer.length; i += 1) {
    // Mid/side: scaling the side signal is what widens or narrows the image.
    const mid = (left[i] + right[i]) / 2;
    const side = ((left[i] - right[i]) / 2) * w;
    outL[i] = Math.max(-1, Math.min(1, mid + side));
    outR[i] = Math.max(-1, Math.min(1, mid - side));
  }
  return out;
}

export interface CompressorOptions {
  threshold?: number;
  ratio?: number;
  attack?: number;
  release?: number;
  knee?: number;
  makeup?: number;
}

export function applyCompressor(
  buffer: AudioBuffer,
  options: CompressorOptions = {}
): Promise<AudioBuffer> {
  const {
    threshold = -24,
    ratio = 4,
    attack = 0.003,
    release = 0.25,
    knee = 6,
    makeup = 0,
  } = options;

  return renderThrough(buffer, (ctx, source) => {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = threshold;
    comp.ratio.value = ratio;
    comp.attack.value = attack;
    comp.release.value = release;
    comp.knee.value = knee;

    const gain = ctx.createGain();
    gain.gain.value = 10 ** (makeup / 20);

    source.connect(comp).connect(gain);
    return gain;
  });
}

/** Band-limits to a telephone line: 300 Hz–3.4 kHz, the classic voice preset. */
export function telephone(buffer: AudioBuffer): Promise<AudioBuffer> {
  return renderThrough(buffer, (ctx, source) => {
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 300;
    hp.Q.value = 0.9;

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3400;
    lp.Q.value = 0.9;

    const peak = ctx.createBiquadFilter();
    peak.type = 'peaking';
    peak.frequency.value = 1800;
    peak.gain.value = 6;
    peak.Q.value = 1.4;

    source.connect(hp).connect(lp).connect(peak);
    return peak;
  });
}

export function lowpass(buffer: AudioBuffer, frequency: number, q = 0.7) {
  return applyEq(buffer, [{ frequency, gain: 0, q, type: 'lowpass' }]);
}

export function highpass(buffer: AudioBuffer, frequency: number, q = 0.7) {
  return applyEq(buffer, [{ frequency, gain: 0, q, type: 'highpass' }]);
}
