/**
 * Synchronised multi-stem playback: mute, solo and level, per stem, while playing.
 *
 * This exists because handing somebody four separate downloads is a worse answer
 * than letting them hear the four parts against each other. Separation quality is
 * not a number, it is a judgement, and the only way to make that judgement is to
 * solo the vocal, hear what bled into it, then unmute the drums and decide whether
 * it matters. Downloading four files and loading them into a DAW to find out is a
 * lot of work to discover the result was no good.
 *
 * The whole thing is one AudioContext with a gain node per stem, which is what makes
 * the toggles sample-accurate and free. Every stem plays from the same
 * `start(when, offset)` moment, so they cannot drift no matter how many are toggled
 * mid-playback — mute is a gain change on a running graph, not a stop and restart.
 */

export interface Stem {
  /** Stable key, used for the DOM and for filenames. */
  id: string;
  /** What the person reads. */
  name: string;
  buffer: AudioBuffer;
}

interface Track {
  stem: Stem;
  gain: GainNode;
  source: AudioBufferSourceNode | null;
  muted: boolean;
  /** 0..1.5, so a quiet stem can be pushed above unity to hear it properly. */
  level: number;
}

export interface StemPlayerState {
  playing: boolean;
  /** Seconds. */
  time: number;
  duration: number;
  /** Stem id that is soloed, or null. */
  solo: string | null;
}

export type StemPlayerListener = (state: StemPlayerState) => void;

/** Fade applied when a stem is muted or unmuted, in seconds. */
const MUTE_FADE = 0.015;

export class StemPlayer {
  private context: AudioContext;
  private tracks: Track[] = [];
  private master: GainNode;
  private duration = 0;

  private playing = false;
  /** Context time at which playback of `offset` began. */
  private startedAt = 0;
  /** Position within the stems at the last start or seek. */
  private offset = 0;
  private solo: string | null = null;
  private raf = 0;
  private listeners = new Set<StemPlayerListener>();

  constructor(stems: Stem[]) {
    if (stems.length === 0) throw new Error('StemPlayer needs at least one stem');

    this.context = new AudioContext();
    this.master = this.context.createGain();
    this.master.connect(this.context.destination);

    for (const stem of stems) {
      const gain = this.context.createGain();
      gain.connect(this.master);
      this.tracks.push({ stem, gain, source: null, muted: false, level: 1 });
      this.duration = Math.max(this.duration, stem.buffer.duration);
    }
    this.applyGains(0);
  }

  get stems(): Stem[] {
    return this.tracks.map((track) => track.stem);
  }

  subscribe(listener: StemPlayerListener): () => void {
    this.listeners.add(listener);
    listener(this.state());
    return () => this.listeners.delete(listener);
  }

  state(): StemPlayerState {
    return {
      playing: this.playing,
      time: this.currentTime(),
      duration: this.duration,
      solo: this.solo,
    };
  }

  private emit(): void {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }

  currentTime(): number {
    if (!this.playing) return Math.min(this.offset, this.duration);
    return Math.min(this.duration, this.offset + (this.context.currentTime - this.startedAt));
  }

  /**
   * Whether a stem is audible right now, which is not the same as "not muted".
   *
   * Solo overrides mute rather than replacing it: soloing the vocal then clearing
   * the solo has to restore whatever was muted before, or the control becomes
   * destructive and people stop trusting it.
   */
  private audible(track: Track): boolean {
    if (this.solo) return track.stem.id === this.solo;
    return !track.muted;
  }

  private applyGains(fade = MUTE_FADE): void {
    const now = this.context.currentTime;
    for (const track of this.tracks) {
      const target = this.audible(track) ? track.level : 0;
      const gain = track.gain.gain;
      // Ramping rather than setting: an instant gain change on a running source is
      // a step discontinuity, which is an audible click on every toggle.
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      if (fade > 0) gain.linearRampToValueAtTime(target, now + fade);
      else gain.setValueAtTime(target, now);
    }
  }

  async play(): Promise<void> {
    if (this.playing) return;
    // Autoplay policy: the context starts suspended until a gesture resumes it.
    if (this.context.state === 'suspended') await this.context.resume();

    const startAt = this.context.currentTime + 0.02;
    const from = this.offset >= this.duration ? 0 : this.offset;
    this.offset = from;

    for (const track of this.tracks) {
      const source = this.context.createBufferSource();
      source.buffer = track.stem.buffer;
      source.connect(track.gain);
      // Every stem is scheduled for the same instant, which is why they cannot
      // drift relative to each other however much is toggled later.
      source.start(startAt, Math.min(from, track.stem.buffer.duration));
      track.source = source;
    }

    this.startedAt = startAt;
    this.playing = true;
    this.applyGains(0);
    this.tick();
    this.emit();

    // The longest stem ending is the end of playback.
    const longest = this.tracks.reduce(
      (best, track) => (track.stem.buffer.duration > best.stem.buffer.duration ? track : best),
      this.tracks[0]!
    );
    longest.source!.onended = () => {
      // Only stop if this is still the current source; a seek replaces it and the
      // old one fires onended on the way out.
      if (longest.source && this.playing) this.stop(true);
    };
  }

  stop(atEnd = false): void {
    for (const track of this.tracks) {
      if (track.source) {
        track.source.onended = null;
        try {
          track.source.stop();
        } catch {
          /* Already stopped, which is not an error worth surfacing. */
        }
        track.source.disconnect();
        track.source = null;
      }
    }
    if (this.playing) this.offset = atEnd ? this.duration : this.currentTime();
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.emit();
  }

  async toggle(): Promise<void> {
    if (this.playing) this.stop();
    else await this.play();
  }

  seek(seconds: number): void {
    const target = Math.max(0, Math.min(this.duration, seconds));
    if (this.playing) {
      this.stop();
      this.offset = target;
      void this.play();
    } else {
      this.offset = target;
      this.emit();
    }
  }

  setMuted(id: string, muted: boolean): void {
    const track = this.tracks.find((t) => t.stem.id === id);
    if (!track) return;
    track.muted = muted;
    this.applyGains();
    this.emit();
  }

  isMuted(id: string): boolean {
    return this.tracks.find((t) => t.stem.id === id)?.muted ?? false;
  }

  /** Passing the already-soloed id clears it, which is what people expect. */
  setSolo(id: string | null): void {
    this.solo = this.solo === id ? null : id;
    this.applyGains();
    this.emit();
  }

  setLevel(id: string, level: number): void {
    const track = this.tracks.find((t) => t.stem.id === id);
    if (!track) return;
    track.level = Math.max(0, Math.min(1.5, level));
    this.applyGains(0.05);
  }

  getLevel(id: string): number {
    return this.tracks.find((t) => t.stem.id === id)?.level ?? 1;
  }

  private tick(): void {
    const step = (): void => {
      if (!this.playing) return;
      this.emit();
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  /**
   * A mixdown of exactly what is currently audible, at the current levels.
   *
   * The point of the whole panel: having balanced four stems by ear, being able to
   * take that balance away as one file. Rendered offline rather than recorded, so it
   * is exact and takes no longer than the arithmetic.
   */
  async mixdown(): Promise<AudioBuffer> {
    const audible = this.tracks.filter((track) => this.audible(track));
    if (audible.length === 0) throw new Error('Nothing is audible to mix down.');

    const reference = audible[0]!.stem.buffer;
    const frames = Math.max(...audible.map((track) => track.stem.buffer.length));
    const channels = Math.max(...audible.map((track) => track.stem.buffer.numberOfChannels));

    const context = new OfflineAudioContext(channels, frames, reference.sampleRate);
    for (const track of audible) {
      const source = context.createBufferSource();
      source.buffer = track.stem.buffer;
      const gain = context.createGain();
      gain.gain.value = track.level;
      source.connect(gain);
      gain.connect(context.destination);
      source.start();
    }
    const mixed = await context.startRendering();

    // Summing several stems at unity can exceed full scale, and clipping a mixdown
    // somebody balanced by ear would be a poor reward for the effort. Only scaled
    // when it actually overflows.
    let peak = 0;
    for (let c = 0; c < mixed.numberOfChannels; c += 1) {
      const data = mixed.getChannelData(c);
      for (let i = 0; i < data.length; i += 1) {
        const value = Math.abs(data[i]!);
        if (value > peak) peak = value;
      }
    }
    if (peak > 1) {
      const scale = 0.999 / peak;
      for (let c = 0; c < mixed.numberOfChannels; c += 1) {
        const data = mixed.getChannelData(c);
        for (let i = 0; i < data.length; i += 1) data[i] = data[i]! * scale;
      }
    }
    return mixed;
  }

  destroy(): void {
    this.stop();
    this.listeners.clear();
    void this.context.close().catch(() => {});
  }
}
