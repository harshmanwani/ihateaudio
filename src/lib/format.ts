/** Formatting helpers shared by every tool. Pure, no DOM. */

/**
 * Seconds to a timecode. Always includes centiseconds because audio editing
 * without sub-second precision is guesswork.
 *
 * 74.5 -> "1:14.50" · 3725.5 -> "1:02:05.50"
 */
export function timecode(seconds: number, showHours?: boolean): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const cs = Math.floor((seconds % 1) * 100);
  const cc = String(cs).padStart(2, '0');
  if (hrs > 0 || showHours) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${cc}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}.${cc}`;
}

/** Coarse duration for listings — "3:07", "1:02:05". No sub-second noise. */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.round(seconds % 60);
  // Rounding can carry: 59.7s must read 1:00, not 0:60.
  let m = mins;
  let s = secs;
  let h = hrs;
  if (s === 60) {
    s = 0;
    m += 1;
  }
  if (m === 60) {
    m = 0;
    h += 1;
  }
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Parses a user-typed timecode back to seconds.
 * Accepts "90", "1:30", "1:30.5", "01:02:03.25". Returns null if unparseable.
 */
export function parseTimecode(input: string): number | null {
  const text = input.trim();
  if (!text) return null;
  if (!/^\d{1,3}(:\d{1,2}){0,2}(\.\d{1,3})?$/.test(text)) return null;
  const parts = text.split(':');
  let total = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isFinite(n)) return null;
    total = total * 60 + n;
  }
  return total;
}

/** Bytes to a human size. Uses 1024 steps, one decimal above KB. */
export function filesize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** "44100" -> "44.1 kHz" */
export function sampleRateLabel(rate: number): string {
  const khz = rate / 1000;
  return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

export function channelLabel(count: number): string {
  if (count === 1) return 'Mono';
  if (count === 2) return 'Stereo';
  return `${count} channels`;
}

/** Signed decibel display: "+3.0 dB", "-6.5 dB", "0.0 dB". */
export function db(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '−∞ dB';
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(digits)} dB`;
}

/** Strips the extension so tools can suffix a filename cleanly. */
export function baseName(filename: string): string {
  const slash = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const name = slash >= 0 ? filename.slice(slash + 1) : filename;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

export function extensionOf(filename: string): string {
  const name = baseName(filename);
  const full = filename.slice(filename.lastIndexOf('/') + 1);
  if (full.length === name.length) return '';
  return full.slice(name.length + 1).toLowerCase();
}

/**
 * Builds an output filename that survives repeated tool runs without
 * accumulating suffixes: "song-trimmed.mp3" trimmed again stays
 * "song-trimmed.mp3", not "song-trimmed-trimmed.mp3".
 */
export function outputName(
  original: string,
  suffix: string,
  ext: string
): string {
  let base = baseName(original) || 'audio';
  const tail = `-${suffix}`;
  if (!base.toLowerCase().endsWith(tail.toLowerCase())) base += tail;
  return `${base}.${ext}`;
}

/** Clamps to a range; NaN falls back to the low bound. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Percentage of a range, for slider fill and progress bars. */
export function pct(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return clamp(((value - min) / (max - min)) * 100, 0, 100);
}
