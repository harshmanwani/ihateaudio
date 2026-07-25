/**
 * Playback transport shared by every tool.
 *
 * AudioBufferSourceNode is single-use — it cannot be paused and restarted — so
 * position is tracked against the context clock and a fresh node is created on
 * each play. That is the standard approach and it is what makes scrubbing feel
 * immediate rather than gated on a media element's buffering.
 */
import { getAudioContext, resumeAudioContext } from './decode';

export interface PlayerEvents {
  /** Fires every animation frame while playing. */
  time?: (seconds: number) => void;
  play?: () => void;
  pause?: () => void;
  ended?: () => void;
}

export class Player {
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private startedAt = 0;
  private offset = 0;
  private playing = false;
  private raf = 0;
  private events: PlayerEvents;
  private region: { start: number; end: number } | null = null;
  private looping = false;
  private volume = 1;

  constructor(events: PlayerEvents = {}) {
    this.events = events;
  }

  setBuffer(buffer: AudioBuffer | null): void {
    this.stop();
    this.buffer = buffer;
    this.offset = 0;
  }

  /** Constrains playback to a range. Null plays the whole buffer. */
  setRegion(region: { start: number; end: number } | null): void {
    this.region = region;
    // A playing head outside the new range would be confusing; pull it in.
    if (region && (this.offset < region.start || this.offset > region.end)) {
      this.seek(region.start);
    }
  }

  setLoop(value: boolean): void {
    this.looping = value;
    if (this.source) this.source.loop = value;
    if (this.playing) {
      // Loop points are set at start time, so restart to apply them.
      const at = this.currentTime;
      this.stop(true);
      this.play(at);
    }
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(2, value));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get duration(): number {
    return this.buffer?.duration ?? 0;
  }

  get currentTime(): number {
    if (!this.playing) return this.offset;
    const ctx = getAudioContext();
    const elapsed = ctx.currentTime - this.startedAt;
    const bounds = this.bounds();
    let position = this.offset + elapsed;

    if (this.looping && position > bounds.end) {
      const span = bounds.end - bounds.start;
      if (span > 0) position = bounds.start + ((position - bounds.start) % span);
    }
    return Math.min(bounds.end, position);
  }

  private bounds(): { start: number; end: number } {
    if (this.region) return this.region;
    return { start: 0, end: this.duration };
  }

  async play(from?: number): Promise<void> {
    if (!this.buffer) return;
    await resumeAudioContext();

    const ctx = getAudioContext();
    const bounds = this.bounds();

    let start = from ?? this.offset;
    // Restarting from the very end should replay, not sit silent.
    if (start >= bounds.end - 0.01 || start < bounds.start) start = bounds.start;

    this.stop(true);

    const source = ctx.createBufferSource();
    source.buffer = this.buffer;

    const gain = ctx.createGain();
    gain.gain.value = this.volume;

    source.connect(gain).connect(ctx.destination);

    if (this.looping) {
      source.loop = true;
      source.loopStart = bounds.start;
      source.loopEnd = bounds.end;
    }

    source.onended = () => {
      // A manual stop also fires onended; only react to natural completion.
      if (this.source !== source) return;
      this.playing = false;
      this.offset = this.bounds().start;
      this.stopTicking();
      this.events.ended?.();
      this.events.time?.(this.offset);
    };

    const playDuration = this.looping ? undefined : bounds.end - start;
    source.start(0, start, playDuration);

    this.source = source;
    this.gain = gain;
    this.offset = start;
    this.startedAt = ctx.currentTime;
    this.playing = true;

    this.events.play?.();
    this.startTicking();
  }

  pause(): void {
    if (!this.playing) return;
    const at = this.currentTime;
    this.stop(true);
    this.offset = at;
    this.events.pause?.();
    this.events.time?.(at);
  }

  toggle(): void {
    if (this.playing) this.pause();
    else void this.play();
  }

  seek(seconds: number): void {
    const bounds = this.bounds();
    const target = Math.min(bounds.end, Math.max(bounds.start, seconds));
    if (this.playing) {
      void this.play(target);
    } else {
      this.offset = target;
      this.events.time?.(target);
    }
  }

  /** `silent` suppresses the pause event, for internal restarts. */
  stop(silent = false): void {
    if (this.source) {
      this.source.onended = null;
      try {
        this.source.stop();
      } catch {
        /* Already stopped — nothing to unwind. */
      }
      this.source.disconnect();
      this.source = null;
    }
    if (this.gain) {
      this.gain.disconnect();
      this.gain = null;
    }
    this.playing = false;
    this.stopTicking();
    if (!silent) this.events.pause?.();
  }

  private startTicking(): void {
    this.stopTicking();
    const tick = (): void => {
      if (!this.playing) return;
      this.events.time?.(this.currentTime);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopTicking(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  destroy(): void {
    this.stop(true);
    this.buffer = null;
  }
}
