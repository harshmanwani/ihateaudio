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

/** Above this the loop rings on for minutes; the echo page's slider stops here too. */
const MAX_FEEDBACK = 0.85;

/**
 * How long the repeats run past the end of the file, in seconds.
 *
 * Repeat n of the last sample arrives n delays after it, at `feedback ** (n - 1)`
 * of the first repeat's level, so the render runs to the first repeat at or
 * below -60 dB. There is deliberately no cap on the count: at the top of the
 * feedback range that takes 44 repeats, and stopping at 24 would end the file
 * while the echoes were still only about 33 dB down, which is plainly audible. The
 * feedback clamp is what keeps the length bounded instead — at most 44 delays.
 */
export function echoTail(delay: number, feedback: number): number {
  const fb = Math.min(MAX_FEEDBACK, Math.max(0, feedback));
  if (fb <= 0.01) return delay;
  return delay * (1 + Math.ceil(Math.log(0.001) / Math.log(fb)));
}

export function applyEcho(
  buffer: AudioBuffer,
  options: EchoOptions = {}
): Promise<AudioBuffer> {
  const { delay = 0.3, feedback = 0.35, mix = 0.4 } = options;
  const fb = Math.min(MAX_FEEDBACK, Math.max(0, feedback));
  const wet = Math.min(1, Math.max(0, mix));

  // Chromium runs each trip round a feedback loop one render quantum (128
  // frames) late, measured: the repeats come every delay + 2.9 ms at 44.1 kHz,
  // not every delay. Spacing the tail's repeats by that much keeps the last one
  // inside the render; where an engine is exact it only adds a little silence.
  const loopDelay = delay + 128 / buffer.sampleRate;
  const scale = 1 + echoTail(loopDelay, fb) / Math.max(0.001, buffer.duration);

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

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const linearToDb = (x: number): number => (x > 0 ? 20 * Math.log10(x) : -1000);

/**
 * The DynamicsCompressorNode's static curve: output level in dB for a steady
 * input level in dB, before any makeup gain.
 *
 * The spec leaves the knee's shape to the browser, so this is the curve the
 * engines actually run (Chromium, WebKit and Gecko share one implementation),
 * written out so a drawing of it is what the node does rather than the
 * textbook version. Two things differ from the textbook. The knee sits entirely
 * above the threshold, from threshold to threshold + knee, instead of being
 * centred on it: the signal is untouched right up to the threshold. And the
 * knee is an exponential in linear amplitude, `T + (1 - e^(-k(x - T))) / k`,
 * with k found by the same 15-step bisection the engine uses so that its slope
 * at the top of the knee is 1/ratio and it joins the ratio line without a
 * corner.
 *
 * Levels are sample peaks: the node's detector works on the largest absolute
 * sample across channels, not on RMS.
 */
export function compressorCurve(
  threshold: number,
  knee: number,
  ratio: number
): (inputDb: number) => number {
  // The node clamps its parameters to these ranges; the curve follows suit.
  const t = clamp(threshold, -100, 0);
  const w = clamp(knee, 0, 40);
  const r = clamp(ratio, 1, 20);

  const linearThreshold = 10 ** (t / 20);
  const kneeTopDb = t + w;
  const kneeTop = 10 ** (kneeTopDb / 20);

  const kneeCurve = (x: number, k: number): number =>
    x < linearThreshold ? x : linearThreshold + (1 - Math.exp(-k * (x - linearThreshold))) / k;

  // Slope in dB per dB, by finite difference, exactly as the engine measures it.
  const slopeAt = (x: number, k: number): number => {
    if (x < linearThreshold) return 1;
    const x2 = x * 1.001;
    return (
      (linearToDb(kneeCurve(x2, k)) - linearToDb(kneeCurve(x, k))) /
      (linearToDb(x2) - linearToDb(x))
    );
  };

  let minK = 0.1;
  let maxK = 10000;
  let k = 5;
  for (let i = 0; i < 15; i += 1) {
    if (slopeAt(kneeTop, k) < 1 / r) maxK = k;
    else minK = k;
    k = Math.sqrt(minK * maxK);
  }

  const kneeTopOutDb = linearToDb(kneeCurve(kneeTop, k));

  return (inputDb: number): number => {
    const x = 10 ** (inputDb / 20);
    if (x < kneeTop) return linearToDb(kneeCurve(x, k));
    return kneeTopOutDb + (inputDb - kneeTopDb) / r;
  };
}

/**
 * The node's own makeup gain, in dB, for these settings.
 *
 * The spec has the node lift its output by `(1 / curve(0 dBFS)) ** 0.6` on its
 * own, a perceptual guess at how much level the compression took away.
 * applyCompressor measures and cancels this rather than computing it, but the
 * figure is the same, and having it here is what lets the curve be checked
 * against a real browser.
 */
export function compressorAutoMakeup(threshold: number, knee: number, ratio: number): number {
  return -0.6 * compressorCurve(threshold, knee, ratio)(0);
}

/**
 * A single sample at -120 dBFS. That is below the lowest threshold the node
 * accepts (-100 dB), and the node treats anything under 1e-4 as silence for
 * detection anyway, so the click is never compressed: it comes out scaled by
 * the node's own makeup gain alone, at the position its lookahead delays it to.
 */
const CLICK = 2 ** -20;

/**
 * Silence the node runs on before the audio starts, in whole seconds so the
 * source's start time lands exactly on a frame and is not interpolated.
 *
 * The node starts with its detector at zero, which it reads as "fully
 * compressed", and recovers from there at its release rate: the first 100 ms
 * of a file came out up to 11 dB down at the voice settings, and the first
 * second up to 21 dB down at the slowest release. Measured in Chromium, it
 * settles within 0.001 dB after 1.06 s at the worst setting (attack 0,
 * release 1 s, the node's maximum), so two seconds of silence first puts the
 * audio through a compressor that is already at rest.
 */
const SETTLE_SECONDS = 2;

/**
 * The click goes in half a second before the audio: after the 1.06 s the node
 * needs to settle at its slowest release, so it measures the makeup alone, and
 * far enough ahead of the audio that no lookahead reaches it.
 */
const CLICK_SECONDS = 1.5;

/**
 * Room past the end for the node's lookahead, which delays its output by a
 * fixed amount the spec leaves to the browser. Chromium uses 6 ms; 100 ms is
 * spare for any engine that uses more.
 */
const LOOKAHEAD_ROOM_SECONDS = 0.1;

/**
 * Dynamic range compression through the browser's DynamicsCompressorNode,
 * corrected so the result is the drawn curve plus the makeup asked for.
 *
 * Left alone, the node does three things on top of the curve. It adds its own
 * makeup gain (8 dB at the voice preset, 15 dB at a heavy one), so material
 * below the threshold came out louder rather than untouched and a full-level
 * song clipped on export. It delays the output by its lookahead, so the file
 * started late and lost its last few milliseconds. And it starts up as though
 * it were already compressing hard, fading in the start of every file.
 *
 * One render fixes all three. The audio starts after SETTLE_SECONDS of
 * silence, with a click below the node's detection range half a second before it.
 * Where the click comes out gives the lookahead in frames and how loud it
 * comes out gives the node's own makeup, both measured from the browser doing
 * the work rather than assumed. The result is then cut from the moment the
 * audio emerges, to the input's exact length, and scaled so the node's makeup
 * is replaced by the one asked for.
 */
export async function applyCompressor(
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

  const rate = buffer.sampleRate;
  const settleFrames = SETTLE_SECONDS * rate;
  // Rounded: 1.5 s is not a whole frame at 11.025 kHz, and a fractional index
  // would write the click nowhere.
  const clickFrame = Math.round(CLICK_SECONDS * rate);
  const ctx = new OfflineAudioContext(
    buffer.numberOfChannels,
    settleFrames + buffer.length + Math.ceil(LOOKAHEAD_ROOM_SECONDS * rate),
    rate
  );

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = threshold;
  comp.ratio.value = ratio;
  comp.attack.value = attack;
  comp.release.value = release;
  comp.knee.value = knee;
  comp.connect(ctx.destination);

  // The click sits at the end of its own buffer so that buffer can start at 0,
  // the one start time that is frame-exact by construction.
  const clickBuffer = ctx.createBuffer(1, clickFrame + 1, rate);
  clickBuffer.getChannelData(0)[clickFrame] = CLICK;
  const click = ctx.createBufferSource();
  click.buffer = clickBuffer;
  click.connect(comp);
  click.start(0);

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(comp);
  source.start(SETTLE_SECONDS);

  const rendered = await ctx.startRendering();

  // Everything before the click is silence times a gain, which is exactly 0,
  // so the first non-zero sample is the click.
  const probe = rendered.getChannelData(0);
  let at = -1;
  for (let i = clickFrame; i < settleFrames; i += 1) {
    if (probe[i] !== 0) {
      at = i;
      break;
    }
  }
  const latency = at < 0 ? 0 : at - clickFrame;
  const builtIn = at < 0 ? 1 : probe[at]! / CLICK;
  const scale = 10 ** (makeup / 20) / builtIn;

  const start = settleFrames + latency;
  const out = createBuffer(buffer.numberOfChannels, buffer.length, rate);
  for (let c = 0; c < buffer.numberOfChannels; c += 1) {
    const from = rendered.getChannelData(c);
    const to = out.getChannelData(c);
    const end = Math.min(buffer.length, from.length - start);
    for (let i = 0; i < end; i += 1) to[i] = from[start + i]! * scale;
  }
  return out;
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
