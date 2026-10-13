/**
 * Synthesizes the launch video's music bed from scratch: drums, bass, chords,
 * arp, risers and impacts are all generated here from oscillators and seeded
 * noise. No samples, loops, or third-party material, so the result is original
 * work with no licence to clear.
 *
 * 120 BPM (one beat = 0.5 s = 15 frames at 30 fps). The section map matches
 * STORYBOARD.md; hits are placed on the exact frame starts.
 *
 *   node scripts/make-music.mjs [out.wav]   (default: assets/audio/ihateaudio-bed.wav)
 */
import { writeFileSync } from 'node:fs';

const OUT = process.argv[2] ?? 'assets/audio/ihateaudio-bed.wav';
const SR = 44100;
const BEAT = 0.5;
const DUR = 37.5;
const N = Math.round(SR * DUR);

// Buses
const dryL = new Float32Array(N), dryR = new Float32Array(N);
const sendL = new Float32Array(N), sendR = new Float32Array(N);
// Section map (seconds)
const S = { pain: 4, turn: 8, drop: 10, count: 12, montage: 14.5, promise: 26.5, kickBack: 28.5, stack: 30.5, end: 33.5 };

let seed = 1234567;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const mtof = (m) => 440 * 2 ** ((m - 69) / 12);
const idx = (t) => Math.round(t * SR);

function add(i, l, r, send = 0) {
  if (i < 0 || i >= N) return;
  dryL[i] += l; dryR[i] += r;
  if (send) { sendL[i] += l * send; sendR[i] += r * send; }
}

// ---------- Sidechain from the kick grid ----------
const kickTimes = [];
function kickOn(t) {
  if (t < S.turn) return true;
  if (t >= S.turn && t < S.drop) return false;
  if (t >= S.promise && t < S.kickBack) return false;
  if (t >= S.end) return false;
  return true;
}
for (let b = 0; b * BEAT < S.end; b += 1) { const t = b * BEAT; if (kickOn(t)) kickTimes.push(t); }
const duck = new Float32Array(N).fill(1);
for (const t of kickTimes) {
  const i0 = idx(t);
  for (let k = 0; k < SR * 0.4; k += 1) {
    const x = k / SR;
    const g = 1 - 0.75 * Math.exp(-x / 0.11) * Math.min(1, x / 0.004 + 0.6);
    if (i0 + k < N) duck[i0 + k] = Math.min(duck[i0 + k], g);
  }
}

// ---------- Instruments ----------
function kick(t, gain = 1) {
  const i0 = idx(t); let ph = 0;
  for (let k = 0; k < SR * 0.45; k += 1) {
    const x = k / SR;
    const f = 45 + 115 * Math.exp(-x * 28);
    ph += (2 * Math.PI * f) / SR;
    let v = Math.sin(ph) * Math.exp(-x * 6.5);
    v += (x < 0.004 ? rnd() * 0.5 * (1 - x / 0.004) : 0);
    v = Math.tanh(v * 1.6) * 0.9 * gain;
    add(i0 + k, v, v);
  }
}
function clap(t, gain = 1) {
  const i0 = idx(t); let lp = 0, hp = 0, prev = 0;
  for (let k = 0; k < SR * 0.35; k += 1) {
    const x = k / SR;
    const bursts = [0, 0.011, 0.022].reduce((a, o) => a + (x >= o ? Math.exp(-(x - o) * 140) : 0), 0);
    const env = x < 0.03 ? bursts * 0.5 : Math.exp(-(x - 0.03) * 16) * 0.55;
    const n = rnd();
    lp += 0.45 * (n - lp); hp = lp - prev; prev = lp; // band-ish
    const body = Math.sin(2 * Math.PI * 190 * x) * Math.exp(-x * 40) * 0.35;
    const v = (hp * 2.2 + body) * env * gain * 0.6;
    add(i0 + k, v * 0.95, v * 1.05, 0.35);
  }
}
function hat(t, open = false, gain = 1, pan = 0.1) {
  const i0 = idx(t); let prev = 0;
  const dec = open ? 9 : 55;
  for (let k = 0; k < SR * (open ? 0.3 : 0.08); k += 1) {
    const x = k / SR;
    const n = rnd(); const h = n - prev; prev = n;
    const v = h * Math.exp(-x * dec) * 0.16 * gain;
    add(i0 + k, v * (1 - pan), v * (1 + pan), open ? 0.15 : 0.05);
  }
}
function crash(t, gain = 1) {
  const i0 = idx(t); let prev = 0, p2 = 0;
  for (let k = 0; k < SR * 2.2; k += 1) {
    const x = k / SR;
    const n = rnd(); const h = n - prev; prev = n; p2 += 0.3 * (h - p2);
    const v = (h * 0.6 + p2) * Math.exp(-x * 2.1) * 0.22 * gain;
    add(i0 + k, v * (0.9 + 0.1 * Math.sin(x * 7)), v * (0.9 + 0.1 * Math.cos(x * 7)), 0.4);
  }
}
function impact(t, gain = 1) {
  const i0 = idx(t); let ph = 0;
  for (let k = 0; k < SR * 1.8; k += 1) {
    const x = k / SR;
    const f = 32 + 70 * Math.exp(-x * 9);
    ph += (2 * Math.PI * f) / SR;
    const v = Math.tanh(Math.sin(ph) * Math.exp(-x * 2.4) * 1.8) * 0.75 * gain
      + (x < 0.06 ? rnd() * 0.35 * (1 - x / 0.06) * gain : 0);
    add(i0 + k, v, v, 0.2);
  }
}
function thud(t, gain = 1) { // the pain-word slam
  const i0 = idx(t); let ph = 0, lp = 0;
  for (let k = 0; k < SR * 0.5; k += 1) {
    const x = k / SR;
    ph += (2 * Math.PI * (60 + 160 * Math.exp(-x * 40))) / SR;
    lp += 0.2 * (rnd() - lp);
    const v = (Math.sin(ph) * Math.exp(-x * 9) + lp * Math.exp(-x * 25) * 1.2) * 0.7 * gain;
    add(i0 + k, Math.tanh(v * 1.5), Math.tanh(v * 1.5), 0.15);
  }
}
function strike(t, gain = 1) { // a fast downward scratch for the strike-through
  const i0 = idx(t); const len = 0.22; let lp = 0, ph = 0;
  for (let k = 0; k < SR * len; k += 1) {
    const x = k / SR; const p = x / len;
    const cutoff = 0.5 - 0.42 * p;
    lp += cutoff * (rnd() - lp);
    ph += (2 * Math.PI * (2400 - 2000 * p)) / SR;
    const env = Math.sin(Math.PI * Math.min(1, p * 1.2)) ** 0.6;
    const v = (lp * 0.8 + Math.sin(ph) * 0.08) * env * 0.5 * gain;
    add(i0 + k, v * (0.6 + p * 0.8), v * (1.4 - p * 0.8), 0.1);
  }
}
function whoosh(tPeak, len = 0.35, gain = 1) {
  const i0 = idx(tPeak - len); let lp = 0, bp = 0;
  for (let k = 0; k < SR * (len + 0.12); k += 1) {
    const x = k / SR; const p = Math.min(1, x / len);
    const c = 0.02 + 0.5 * p * p;
    lp += c * (rnd() - lp); bp += c * (lp - bp);
    const env = x < len ? p ** 2.2 : Math.exp(-(x - len) * 30);
    const v = (lp - bp) * env * 0.9 * gain;
    add(i0 + k, v * (1 - 0.5 * p), v * (0.5 + 0.5 * p), 0.15);
  }
}
function tick(t, freq = 2000, gain = 1) {
  const i0 = idx(t);
  for (let k = 0; k < SR * 0.05; k += 1) {
    const x = k / SR;
    const v = Math.sin(2 * Math.PI * freq * x) * Math.exp(-x * 90) * 0.18 * gain;
    add(i0 + k, v, v, 0.2);
  }
}
function riser(t0, t1, gain = 1) {
  const i0 = idx(t0), n = idx(t1) - i0; let lp = 0, bp = 0, ph = 0;
  for (let k = 0; k < n; k += 1) {
    const p = k / n;
    const c = 0.01 + 0.35 * p * p;
    lp += c * (rnd() - lp); bp += c * (lp - bp);
    ph += (2 * Math.PI * (200 + 1600 * p * p)) / SR;
    const v = ((lp - bp) * 1.4 + Math.sin(ph) * 0.06) * p ** 1.6 * 0.5 * gain;
    add(i0 + k, v, v, 0.3);
  }
}
// band-limited saw (polyBLEP)
function blep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
function saw(phase, dt) { return 2 * phase - 1 - blep(phase, dt); }

function synthNote({ t, dur, midi, gain = 0.2, detune = [0], cutoff = 1800, cutEnv = 0, attack = 0.005, release = 0.08, pan = 0, send = 0.2, sub = 0, sideChain = true, drive = 1, decay = 0 }) {
  const i0 = idx(t), n = Math.round((dur + release) * SR);
  const phases = detune.map((_, j) => (j * 0.37) % 1);
  let low = 0, band = 0; let subPh = 0;
  const f0 = mtof(midi);
  for (let k = 0; k < n; k += 1) {
    const x = k / SR;
    let env = Math.min(1, x / attack);
    if (decay) env *= Math.exp(-x * decay);
    if (x > dur) env *= Math.max(0, 1 - (x - dur) / release);
    let v = 0;
    for (let j = 0; j < detune.length; j += 1) {
      const f = f0 * 2 ** (detune[j] / 1200);
      const dt = f / SR;
      phases[j] += dt; if (phases[j] >= 1) phases[j] -= 1;
      v += saw(phases[j], dt);
    }
    v /= Math.sqrt(detune.length);
    const fc = Math.min(0.99, (2 * Math.sin(Math.PI * Math.min(cutoff * (1 + cutEnv * Math.exp(-x * 12)), 16000) / SR)));
    // Chamberlin SVF lowpass, q ~ 0.7
    low += fc * band; const high = v - low - 1.2 * band; band += fc * high;
    let out = low;
    if (sub) { subPh += (2 * Math.PI * f0 * 0.5) / SR; out += Math.sin(subPh) * sub; }
    out = Math.tanh(out * drive) / Math.tanh(drive);
    out *= env * gain;
    const i = i0 + k; if (i >= N) break;
    const g = sideChain ? duck[i] : 1;
    add(i, out * g * (1 - pan), out * g * (1 + pan), send);
  }
}

// ---------- Harmony ----------
const HOOK = [
  { bass: 33, chord: [57, 60, 64, 69] }, // Am
  { bass: 33, chord: [57, 60, 64, 69] }, // Am
  { bass: 29, chord: [57, 60, 65, 69] }, // F
  { bass: 28, chord: [56, 59, 64, 68] }, // E
];
const BRIGHT = [
  { bass: 36, chord: [60, 64, 67, 72] }, // C
  { bass: 31, chord: [59, 62, 67, 71] }, // G
  { bass: 33, chord: [57, 60, 64, 69] }, // Am
  { bass: 29, chord: [57, 60, 65, 69] }, // F
];
function harmonyAt(t) {
  if (t < S.turn) return HOOK[Math.floor(t / 2) % 4];
  if (t < S.drop) return HOOK[3];
  return BRIGHT[Math.floor((t - S.drop) / 2) % 4];
}

// ---------- Arrangement ----------
// Drums
for (const t of kickTimes) {
  const g = t >= S.kickBack && t < S.stack ? 0.8 : 1;
  kick(t, g);
}
for (let b = 0; b * BEAT < S.end; b += 1) {
  const t = b * BEAT;
  const beatInBar = b % 4;
  const inGroove = t >= S.drop && t < S.end && !(t >= S.promise && t < S.kickBack);
  // claps on 2 and 4
  if ((beatInBar === 1 || beatInBar === 3) && ((t >= 2 && t < S.turn) || inGroove)) clap(t, t >= S.drop ? 1 : 0.85);
  // hats
  if (t < S.turn) {
    for (let s = 0; s < 4; s += 1) {
      const ts = t + (s * BEAT) / 4;
      // a stuttering, uneven hat for the "broken" hook
      const g = [0.9, 0.35, s === 2 ? 0.7 : 0.25, 0.5][s] * (t < 2 ? 0.6 : 1);
      if (!(t < 4 && s === 3 && b % 2)) hat(ts, false, g, (s % 2 ? 0.25 : -0.25));
    }
  } else if (inGroove || (t >= S.promise && t < S.kickBack)) {
    const soft = t >= S.promise && t < S.kickBack ? 0.5 : 1;
    hat(t + BEAT / 2, true, 0.75 * soft, 0.2);
    for (let s = 0; s < 4; s += 1) if (s !== 2) hat(t + (s * BEAT) / 4, false, (s === 0 ? 0.6 : 0.4) * soft, s % 2 ? 0.3 : -0.3);
  }
}

// Bass: offbeat 8ths with a sub, pumping against the kick
for (let e = 0; e * (BEAT / 2) < S.end; e += 1) {
  const t = e * (BEAT / 2);
  if (t >= S.turn && t < S.drop) continue;
  const h = harmonyAt(t);
  const isOff = e % 2 === 1;
  if (t < S.turn) {
    // hook + pain: gritty, detuned, offbeat only
    if (isOff) synthNote({ t, dur: 0.18, midi: h.bass + 12, gain: 0.32, detune: [-22, 9, 27], cutoff: 700, cutEnv: 2.5, drive: 3, sub: 0.6, send: 0, pan: 0 });
  } else if (t >= S.promise && t < S.kickBack) {
    if (e % 4 === 0) synthNote({ t, dur: 0.9, midi: h.bass + 12, gain: 0.22, detune: [-6, 6], cutoff: 380, sub: 0.9, send: 0, sideChain: false });
  } else {
    if (isOff) synthNote({ t, dur: 0.2, midi: h.bass + 12, gain: 0.3, detune: [-7, 7], cutoff: 900, cutEnv: 2, drive: 2, sub: 0.8, send: 0 });
  }
}

// Chords
// Hook/pain: a dissonant, wobbly pad (detuned wide) - "miserable"
for (let bar = 0; bar < 4; bar += 1) {
  const t = bar * 2; const h = HOOK[bar];
  for (const m of h.chord) synthNote({ t, dur: 1.9, midi: m, gain: 0.05, detune: [-38, -4, 31], cutoff: 1100, attack: 0.05, release: 0.2, send: 0.35, pan: (m % 3 - 1) * 0.3 });
}
// Turn: a clean, sparse E chord bell at 8.0, then the filter opens under the riser
for (const m of [64, 68, 71, 76]) synthNote({ t: S.turn, dur: 0.2, midi: m, gain: 0.07, detune: [0], cutoff: 5000, decay: 4, release: 0.9, send: 0.6, sideChain: false });
for (const m of HOOK[3].chord) synthNote({ t: S.turn + 0.5, dur: 1.45, midi: m, gain: 0.05, detune: [-12, 0, 12], cutoff: 500, cutEnv: 0, attack: 1.2, release: 0.05, send: 0.4, sideChain: false });
// Drop onward: offbeat supersaw stabs (montage + stack), pads in the promise
for (let e = 0; e * (BEAT / 2) < S.end; e += 1) {
  const t = e * (BEAT / 2);
  if (t < S.drop) continue;
  const h = harmonyAt(t);
  if (t >= S.promise && t < S.stack) {
    if (Math.abs(((t - S.promise) % 2)) < 1e-6) {
      for (const m of h.chord) synthNote({ t, dur: 1.95, midi: m, gain: 0.045, detune: [-14, 0, 14], cutoff: t < S.kickBack ? 1400 : 2400, attack: 0.25, release: 0.3, send: 0.5, sideChain: t >= S.kickBack, pan: (m % 3 - 1) * 0.35 });
    }
    continue;
  }
  if (e % 2 === 1) for (const m of h.chord) synthNote({ t, dur: 0.13, midi: m, gain: 0.05, detune: [-16, 0, 16], cutoff: 3200, cutEnv: 1, release: 0.06, send: 0.25, pan: (m % 3 - 1) * 0.4 });
}
// Arp lead in the montage: 16ths over chord tones, one octave up
for (let s = 0; (S.montage + s * BEAT / 4) < S.promise; s += 1) {
  const t = S.montage + (s * BEAT) / 4;
  const h = harmonyAt(t);
  const tones = [h.chord[0] + 12, h.chord[1] + 12, h.chord[2] + 12, h.chord[3] + 12, h.chord[2] + 12, h.chord[1] + 12];
  synthNote({ t, dur: 0.07, midi: tones[s % tones.length], gain: 0.045, detune: [0, 7], cutoff: 4200, cutEnv: 1.5, release: 0.05, send: 0.35, pan: s % 2 ? 0.35 : -0.35 });
}
// End: one big C chord that rings out
for (const m of [48, 55, 60, 64, 67, 72, 76]) synthNote({ t: S.end, dur: 2.6, midi: m, gain: 0.05, detune: [-14, 0, 14], cutoff: 3000, decay: 0.55, release: 1.2, send: 0.6, sideChain: false });
synthNote({ t: S.end, dur: 2.4, midi: 36, gain: 0.3, detune: [0], cutoff: 300, sub: 1, decay: 0.8, release: 1, send: 0, sideChain: false });
// A soft final bell when the URL settles
for (const m of [84, 91]) synthNote({ t: S.end + 0.5, dur: 0.1, midi: m, gain: 0.04, detune: [0], cutoff: 8000, decay: 3, release: 1.4, send: 0.7, sideChain: false });

// FX and hits locked to picture
impact(0, 0.8); crash(0, 0.6);
thud(S.pain, 1); thud(S.pain + 1, 1); thud(S.pain + 2, 1);
strike(S.pain + 0.5); strike(S.pain + 1.5); strike(S.pain + 2.5);
riser(S.turn + 0.5, S.drop - 0.05, 1.1);
// snare roll into the drop: 8ths -> 16ths -> 32nds
for (let t = S.turn + 1.0; t < S.drop - 0.02; ) {
  const p = (t - (S.turn + 1.0)) / 1.0;
  clap(t, 0.25 + 0.6 * p);
  t += p < 0.5 ? BEAT / 2 : p < 0.75 ? BEAT / 4 : BEAT / 8;
}
impact(S.drop, 1.1); crash(S.drop, 1);
// count-up blips: 16ths rising in pitch from 12.0 to 13.0, then hits
for (let s = 0; s < 8; s += 1) tick(S.count + (s * BEAT) / 4, 900 + s * 180, 0.9);
thud(13.0, 0.8); crash(13.0, 0.5);
thud(13.5, 0.9);
// montage: whoosh into every cut + a tick on the cut
for (let k = 0; k < 8; k += 1) {
  const tc = S.montage + k * 1.5;
  whoosh(tc, 0.28, 0.7); tick(tc, 2600, 0.6);
}
whoosh(S.promise, 0.4, 0.8);
riser(S.kickBack + 1.0, S.stack - 0.03, 0.8);
impact(S.stack, 0.7); crash(S.stack, 0.6);
thud(S.stack + 1, 0.85); thud(S.stack + 2, 0.85);
impact(S.end, 1.15); crash(S.end, 0.9);

// ---------- Hook glitch: stutter-repeat 1/32 slices ----------
function stutter(t0, len, slice) {
  const a = idx(t0), sl = Math.round(slice * SR), n = Math.round(len * SR);
  for (let k = 0; k < n; k += 1) {
    const src = a + (k % sl);
    const g = 1 - 0.3 * Math.floor(k / sl) / Math.max(1, n / sl);
    dryL[a + k] = dryL[src] * g; dryR[a + k] = dryR[src] * g;
  }
}
stutter(1.75, 0.25, BEAT / 8);
stutter(3.5, 0.5, BEAT / 16);
// ---------- Tape stop into the turn (7.5 -> 8.0) ----------
{
  const a = idx(7.5), n = idx(8.0) - a;
  const srcL = dryL.slice(a, a + n * 2), srcR = dryR.slice(a, a + n * 2);
  let pos = 0;
  for (let k = 0; k < n; k += 1) {
    const p = k / n;
    const rate = Math.max(0, 1 - p) ** 1.4;
    pos += rate;
    const i = Math.floor(pos), f = pos - i;
    dryL[a + k] = (srcL[i] * (1 - f) + srcL[i + 1] * f) * (1 - p * 0.3);
    dryR[a + k] = (srcR[i] * (1 - f) + srcR[i + 1] * f) * (1 - p * 0.3);
    sendL[a + k] *= 1 - p; sendR[a + k] *= 1 - p;
  }
}

// ---------- Reverb (Schroeder) on the send ----------
function reverb(inp, combs, aps) {
  const out = new Float32Array(N);
  for (const [d, fb] of combs) {
    const buf = new Float32Array(d); let p = 0, lp = 0;
    for (let i = 0; i < N; i += 1) {
      const y = buf[p]; lp = y * 0.7 + lp * 0.3;
      buf[p] = inp[i] + lp * fb; p = (p + 1) % d; out[i] += y;
    }
  }
  for (const [d, g] of aps) {
    const buf = new Float32Array(d); let p = 0;
    for (let i = 0; i < N; i += 1) {
      const bo = buf[p]; const x = out[i] + bo * g; buf[p] = x; out[i] = bo - g * x; p = (p + 1) % d;
    }
  }
  return out;
}
const revL = reverb(sendL, [[1557, 0.8], [1617, 0.8], [1491, 0.8], [1422, 0.8]], [[225, 0.5], [556, 0.5]]);
const revR = reverb(sendR, [[1580, 0.8], [1640, 0.8], [1514, 0.8], [1445, 0.8]], [[248, 0.5], [579, 0.5]]);

// ---------- Mix + master ----------
const L = new Float32Array(N), R = new Float32Array(N);
let peak = 0;
for (let i = 0; i < N; i += 1) {
  const t = i / SR;
  let l = dryL[i] + revL[i] * 0.12, r = dryR[i] + revR[i] * 0.12;
  // fade in the first 10 ms and out over the last 2.5 s
  const fade = Math.min(1, t / 0.01) * (t > DUR - 2.5 ? Math.max(0, (DUR - t) / 2.5) ** 1.5 : 1);
  l = Math.tanh(l * 1.15) * fade; r = Math.tanh(r * 1.15) * fade;
  L[i] = l; R[i] = r; peak = Math.max(peak, Math.abs(l), Math.abs(r));
}
// Peak-normalise to about -1 dBFS, then trim 4.3 dB so the bed lands at about
// -14 LUFS integrated (the YouTube reference) with headroom for the AAC encode.
const norm = (0.89 / peak) * 10 ** (-4.3 / 20);
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i += 1) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[i] * norm)) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[i] * norm)) * 32767), 46 + i * 4);
}
writeFileSync(OUT, buf);
console.log(`wrote ${OUT} (${DUR}s, peak normalised from ${peak.toFixed(3)})`);
