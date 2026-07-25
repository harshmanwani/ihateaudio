/**
 * The tool registry — one entry per page.
 *
 * This drives the homepage grid, the search, the footer, related-tool links,
 * the chain bar, the sitemap and the nav. Adding a tool means adding an entry
 * here plus a page file; nothing else needs touching.
 */

export type ToolCategory =
  | 'cut'
  | 'convert'
  | 'volume'
  | 'speed'
  | 'effects'
  | 'utility';

export interface CategoryMeta {
  id: ToolCategory;
  name: string;
  blurb: string;
}

export const CATEGORIES: CategoryMeta[] = [
  {
    id: 'cut',
    name: 'Cut & join',
    blurb:
      'Trim, split, merge and clean up recordings. Everything here runs instantly — no encoder download, no waiting.',
  },
  {
    id: 'convert',
    name: 'Convert',
    blurb:
      'Move between formats without uploading anything. MP3 and WAV are instant; other formats load a converter once, then stay fast.',
  },
  {
    id: 'volume',
    name: 'Volume & loudness',
    blurb:
      'Make quiet recordings usable, and hit the loudness targets Spotify, YouTube and podcast hosts actually measure.',
  },
  {
    id: 'speed',
    name: 'Speed & pitch',
    blurb:
      'Change tempo, pitch, or both. Pitch-preserving tools use real time-stretching, not a resample that turns voices into chipmunks.',
  },
  {
    id: 'effects',
    name: 'Effects',
    blurb:
      'Reverb, echo, EQ and spatial effects, rendered with the browser’s own audio engine.',
  },
  {
    id: 'utility',
    name: 'Utility & analysis',
    blurb:
      'Ringtones, recording, and measuring what is actually in a file.',
  },
];

export interface Tool {
  slug: string;
  /** Page H1 and card title. Written as the thing people search for. */
  name: string;
  /** <title> tag. Kept under ~60 chars. */
  title: string;
  /** Meta description. 140–160 chars. */
  description: string;
  /** One line under the H1. */
  tagline: string;
  /** Card blurb on the homepage. */
  short: string;
  category: ToolCategory;
  /** Phosphor icon name. */
  icon: string;
  /** Slugs of tools offered after an export, and in the sidebar. */
  related: string[];
  /** True when the tool never needs the ffmpeg download. */
  instant: boolean;
  /** Hidden from the grid, e.g. deep format variants. */
  secondary?: boolean;
}

export const TOOLS: Tool[] = [
  // ---------------- Cut & join ----------------
  {
    slug: 'audio-trimmer',
    name: 'Audio Trimmer',
    title: 'Audio Trimmer — Cut MP3 and Audio Files Online Free',
    description:
      'Trim and cut audio online free. Drag to select, preview, and download. Works with MP3, WAV, M4A and more. Nothing is uploaded — it all runs in your browser.',
    tagline: 'Drag to select the part you want. Preview it, then download.',
    short: 'Cut a section out of any audio file. Instant, no upload.',
    category: 'cut',
    icon: 'scissors',
    related: ['audio-joiner', 'fade-in-out', 'volume-booster', 'ringtone-maker'],
    instant: true,
  },
  {
    slug: 'audio-joiner',
    name: 'Audio Joiner',
    title: 'Audio Joiner — Merge MP3 and Audio Files Online Free',
    description:
      'Merge multiple audio files into one, in any order. Drag to reorder, add a crossfade, and download. Free, no upload, no account.',
    tagline: 'Combine files into one. Drag to reorder, add a crossfade if you want.',
    short: 'Merge several files into one track, in the order you choose.',
    category: 'cut',
    icon: 'arrows-merge',
    related: ['audio-trimmer', 'crossfade-joiner', 'audio-splitter', 'fade-in-out'],
    instant: true,
  },
  {
    slug: 'audio-splitter',
    name: 'Audio Splitter',
    title: 'Audio Splitter — Split Audio Files Into Parts Online',
    description:
      'Split one audio file into several: by equal parts, by a set length, or at every silence. Download each piece separately. Runs entirely in your browser.',
    tagline: 'Break one file into several — by length, by count, or at every gap.',
    short: 'Split a long recording into parts you can download separately.',
    category: 'cut',
    icon: 'split-horizontal',
    related: ['audio-trimmer', 'silence-remover', 'audio-joiner'],
    instant: true,
  },
  {
    slug: 'silence-remover',
    name: 'Silence Remover',
    title: 'Silence Remover — Cut Dead Air From Audio Online',
    description:
      'Automatically remove silent gaps from a recording. Adjustable threshold and minimum gap length, with a preview before you commit. Free and private.',
    tagline: 'Find every silent gap and cut it out. Adjust how aggressive it is.',
    short: 'Strip dead air out of interviews, lectures and voice notes.',
    category: 'cut',
    icon: 'speaker-slash',
    related: ['audio-normalizer', 'audio-trimmer', 'audio-splitter'],
    instant: true,
  },
  {
    slug: 'fade-in-out',
    name: 'Fade In and Out',
    title: 'Add Fade In and Fade Out to Audio Online Free',
    description:
      'Add a smooth fade in at the start and fade out at the end of any audio file. Four curve shapes, adjustable length, instant preview. No upload needed.',
    tagline: 'Soften the start and end. Pick a curve and a length.',
    short: 'Add a clean fade to the beginning and end of a track.',
    category: 'cut',
    icon: 'wave-sine',
    related: ['audio-trimmer', 'crossfade-joiner', 'volume-booster'],
    instant: true,
  },
  {
    slug: 'audio-reverser',
    name: 'Audio Reverser',
    title: 'Reverse Audio Online — Play Any Sound Backwards',
    description:
      'Reverse any audio file so it plays backwards. Instant, free, and runs entirely in your browser with no upload or signup.',
    tagline: 'Play it backwards. That is the whole tool.',
    short: 'Flip a track so it plays from end to start.',
    category: 'cut',
    icon: 'rewind',
    related: ['speed-changer', 'pitch-shifter', 'audio-trimmer'],
    instant: true,
  },
  {
    slug: 'audio-looper',
    name: 'Audio Looper',
    title: 'Audio Looper — Repeat and Loop Audio Files Online',
    description:
      'Repeat an audio file any number of times, with an optional gap between repeats. Useful for backing tracks, practice loops and ambience.',
    tagline: 'Repeat a clip as many times as you need, with an optional gap.',
    short: 'Repeat a clip to make a longer track.',
    category: 'cut',
    icon: 'repeat',
    related: ['audio-trimmer', 'audio-joiner', 'crossfade-joiner'],
    instant: true,
  },
  {
    slug: 'crossfade-joiner',
    name: 'Crossfade Joiner',
    title: 'Crossfade Audio Online — Blend Tracks Together',
    description:
      'Join audio files with a smooth crossfade instead of a hard cut. Equal-power blending keeps the volume steady through the transition.',
    tagline: 'Blend one track into the next instead of cutting hard.',
    short: 'Merge tracks with a smooth overlap between them.',
    category: 'cut',
    icon: 'intersect',
    related: ['audio-joiner', 'fade-in-out', 'audio-trimmer'],
    instant: true,
  },

  // ---------------- Convert ----------------
  {
    slug: 'audio-converter',
    name: 'Audio Converter',
    title: 'Audio Converter — Convert Audio Files Online Free',
    description:
      'Convert audio between MP3, WAV, M4A, OGG, FLAC, AAC, Opus, AIFF and WMA. No upload, no size limit, no account. Everything runs in your browser.',
    tagline: 'Convert between every common audio format, without uploading.',
    short: 'Convert between MP3, WAV, M4A, OGG, FLAC and more.',
    category: 'convert',
    icon: 'swap',
    related: ['mp3-converter', 'wav-converter', 'audio-compressor', 'video-to-audio'],
    instant: false,
  },
  {
    slug: 'mp3-converter',
    name: 'Convert to MP3',
    title: 'Convert to MP3 Online Free — WAV, M4A, OGG to MP3',
    description:
      'Convert any audio file to MP3 in your browser. Choose the bitrate, see the output size before you download. Free, unlimited, nothing uploaded.',
    tagline: 'Turn anything into an MP3. Pick a bitrate and go.',
    short: 'Convert any audio file to MP3 at the quality you choose.',
    category: 'convert',
    icon: 'music-note',
    related: ['audio-converter', 'wav-converter', 'audio-compressor'],
    instant: true,
  },
  {
    slug: 'wav-converter',
    name: 'Convert to WAV',
    title: 'Convert to WAV Online Free — MP3 to WAV Converter',
    description:
      'Convert audio to uncompressed WAV in your browser. Choose 16, 24 or 32-bit depth. Instant, lossless from this point on, and nothing is uploaded.',
    tagline: 'Convert to uncompressed WAV. Instant, no encoder download.',
    short: 'Convert to WAV at 16, 24 or 32-bit.',
    category: 'convert',
    icon: 'wave-square',
    related: ['audio-converter', 'mp3-converter', 'flac-converter'],
    instant: true,
  },
  {
    slug: 'm4a-converter',
    name: 'Convert to M4A',
    title: 'Convert to M4A Online Free — MP3 to M4A (AAC) Converter',
    description:
      'Convert audio to M4A (AAC) in your browser. Better quality than MP3 at the same file size, and the format Apple devices prefer.',
    tagline: 'Convert to M4A — better quality than MP3 at the same size.',
    short: 'Convert to M4A/AAC, the Apple-friendly format.',
    category: 'convert',
    icon: 'apple-logo',
    related: ['audio-converter', 'mp3-converter', 'ringtone-maker'],
    instant: false,
  },
  {
    slug: 'ogg-converter',
    name: 'Convert to OGG',
    title: 'Convert to OGG Online Free — MP3 to OGG Vorbis Converter',
    description:
      'Convert audio to OGG Vorbis in your browser. The open format used by games, Godot, Unity and much of the Android ecosystem.',
    tagline: 'Convert to OGG Vorbis — open, royalty-free, game-engine friendly.',
    short: 'Convert to OGG Vorbis for games and open platforms.',
    category: 'convert',
    icon: 'game-controller',
    related: ['audio-converter', 'mp3-converter', 'audio-compressor'],
    instant: false,
  },
  {
    slug: 'flac-converter',
    name: 'Convert to FLAC',
    title: 'Convert to FLAC Online Free — Lossless Audio Converter',
    description:
      'Convert audio to FLAC in your browser. Lossless compression at roughly half the size of WAV, with no quality loss at all.',
    tagline: 'Convert to FLAC — lossless, and about half the size of WAV.',
    short: 'Convert to FLAC for lossless archiving.',
    category: 'convert',
    icon: 'archive',
    related: ['audio-converter', 'wav-converter', 'mp3-converter'],
    instant: false,
  },
  {
    slug: 'video-to-audio',
    name: 'Video to Audio',
    title: 'Video to Audio Converter — MP4 to MP3 Online Free',
    description:
      'Extract the soundtrack from MP4, MOV, MKV, WEBM and AVI files and save it as MP3, WAV or M4A. Runs in your browser — videos are never uploaded.',
    tagline: 'Pull the audio out of a video file and save it on its own.',
    short: 'Extract the soundtrack from MP4, MOV, MKV and more.',
    category: 'convert',
    icon: 'film-strip',
    related: ['audio-converter', 'mp3-converter', 'audio-trimmer'],
    instant: false,
  },
  {
    slug: 'audio-compressor',
    name: 'Reduce Audio File Size',
    title: 'Compress Audio Online Free — Reduce MP3 File Size',
    description:
      'Make an audio file smaller by lowering the bitrate, sample rate or channel count. See the projected size before you download. No upload required.',
    tagline: 'Make the file smaller. See exactly how small before you commit.',
    short: 'Shrink a file for email, messaging or upload limits.',
    category: 'convert',
    icon: 'arrows-in-simple',
    related: ['audio-converter', 'mp3-converter', 'sample-rate-converter'],
    instant: true,
  },
  {
    slug: 'sample-rate-converter',
    name: 'Sample Rate Converter',
    title: 'Change Audio Sample Rate Online — 44.1kHz, 48kHz, 22kHz',
    description:
      'Resample audio to 8, 16, 22.05, 32, 44.1, 48 or 96 kHz. Useful for game engines, telephony systems and hardware with fixed rate requirements.',
    tagline: 'Resample to whatever rate your target system needs.',
    short: 'Change the sample rate to match a device or engine.',
    category: 'convert',
    icon: 'stairs',
    related: ['audio-compressor', 'audio-converter', 'wav-converter'],
    instant: true,
  },

  // ---------------- Volume & loudness ----------------
  {
    slug: 'volume-booster',
    name: 'Volume Booster',
    title: 'Increase Audio Volume Online Free — MP3 Volume Booster',
    description:
      'Make a quiet recording louder. Boost by a set amount or normalize to the loudest safe level, with clipping protection and a live preview.',
    tagline: 'Make a quiet recording louder without turning it to mush.',
    short: 'Turn up a recording that came out too quiet.',
    category: 'volume',
    icon: 'speaker-high',
    related: ['audio-normalizer', 'bass-booster', 'dynamic-compressor', 'silence-remover'],
    instant: true,
  },
  {
    slug: 'audio-normalizer',
    name: 'Audio Normalizer',
    title: 'Audio Normalizer — Normalize to LUFS Online Free',
    description:
      'Normalize audio to a target loudness in LUFS, using the same ITU-R BS.1770 measurement Spotify, YouTube and podcast hosts use. With true-peak limiting.',
    tagline: 'Hit the exact loudness target your platform measures.',
    short: 'Normalize to -14 LUFS for Spotify, -16 for podcasts, and so on.',
    category: 'volume',
    icon: 'equals',
    related: ['loudness-meter', 'volume-booster', 'dynamic-compressor', 'silence-remover'],
    instant: true,
  },
  {
    slug: 'bass-booster',
    name: 'Bass Booster',
    title: 'Bass Booster Online Free — Add Bass to MP3',
    description:
      'Boost the low end of any track with a proper low-shelf filter. Adjustable amount and corner frequency, with instant preview. Free and private.',
    tagline: 'Add low end with a shelf filter, not a crude EQ bump.',
    short: 'Add weight to the low end of a track.',
    category: 'volume',
    icon: 'speaker-low',
    related: ['equalizer', 'volume-booster', 'stereo-widener'],
    instant: true,
  },
  {
    slug: 'dynamic-compressor',
    name: 'Audio Compressor (Dynamics)',
    title: 'Audio Dynamic Range Compressor Online Free',
    description:
      'Even out the loud and quiet parts of a recording with threshold, ratio, attack and release controls. Ideal for voice, podcasts and interviews.',
    tagline: 'Even out the loud and quiet parts of a recording.',
    short: 'Level out a recording where volume jumps around.',
    category: 'volume',
    icon: 'faders',
    related: ['audio-normalizer', 'volume-booster', 'silence-remover'],
    instant: true,
  },
  {
    slug: 'stereo-to-mono',
    name: 'Stereo to Mono',
    title: 'Convert Stereo to Mono Online Free — And Mono to Stereo',
    description:
      'Downmix stereo to mono, or duplicate mono to stereo. Also split a stereo file into separate left and right channel files. Instant, no upload.',
    tagline: 'Downmix to mono, expand to stereo, or split the channels apart.',
    short: 'Switch between mono and stereo, or split the channels.',
    category: 'volume',
    icon: 'headphones',
    related: ['audio-compressor', 'stereo-widener', 'audio-converter'],
    instant: true,
  },

  // ---------------- Speed & pitch ----------------
  {
    slug: 'speed-changer',
    name: 'Audio Speed Changer',
    title: 'Change Audio Speed Online Free — Speed Up or Slow Down MP3',
    description:
      'Speed up or slow down audio, with the option to keep the original pitch. 0.25x to 4x, with live preview. Runs entirely in your browser.',
    tagline: 'Speed it up or slow it down — keep the pitch, or let it shift.',
    short: 'Change playback speed, with or without changing pitch.',
    category: 'speed',
    icon: 'fast-forward',
    related: ['tempo-changer', 'pitch-shifter', 'slowed-reverb', 'nightcore-maker'],
    instant: true,
  },
  {
    slug: 'pitch-shifter',
    name: 'Pitch Shifter',
    title: 'Change Audio Pitch Online Free — Pitch Shifter Tool',
    description:
      'Shift pitch up or down by semitones without changing the length. Real time-stretching, so voices stay natural instead of turning into chipmunks.',
    tagline: 'Move the pitch up or down without changing the length.',
    short: 'Transpose a track by semitones, keeping the same duration.',
    category: 'speed',
    icon: 'arrows-vertical',
    related: ['speed-changer', 'tempo-changer', 'voice-changer', 'nightcore-maker'],
    instant: true,
  },
  {
    slug: 'tempo-changer',
    name: 'Tempo Changer',
    title: 'Change Tempo Without Changing Pitch — Online and Free',
    description:
      'Speed up or slow down music while holding the pitch exactly where it is. Uses WSOLA time-stretching, the same technique DAWs use.',
    tagline: 'Change the tempo. The pitch stays exactly where it was.',
    short: 'Change speed while holding pitch — for practice and edits.',
    category: 'speed',
    icon: 'metronome',
    related: ['speed-changer', 'pitch-shifter', 'bpm-detector'],
    instant: true,
  },
  {
    slug: 'slowed-reverb',
    name: 'Slowed + Reverb Maker',
    title: 'Slowed and Reverb Maker Online Free — No Signup',
    description:
      'Turn any song into a slowed + reverb edit. Adjustable slowdown and reverb depth, with instant preview. Free, no watermark, no account, no upload.',
    tagline: 'The slowed + reverb sound, in about ten seconds.',
    short: 'Make the slowed + reverb edit everyone posts.',
    category: 'speed',
    icon: 'moon-stars',
    related: ['nightcore-maker', 'speed-changer', 'reverb-adder', '8d-audio-maker'],
    instant: true,
  },
  {
    slug: 'nightcore-maker',
    name: 'Nightcore Maker',
    title: 'Nightcore Maker Online Free — Make Nightcore Songs',
    description:
      'Turn any song into nightcore: faster tempo and higher pitch, the classic sped-up sound. Adjustable intensity, instant preview, free with no signup.',
    tagline: 'Faster and higher — the classic nightcore treatment.',
    short: 'Speed up and pitch up a track, nightcore style.',
    category: 'speed',
    icon: 'lightning',
    related: ['slowed-reverb', 'speed-changer', 'pitch-shifter'],
    instant: true,
  },
  {
    slug: 'voice-changer',
    name: 'Voice Changer',
    title: 'Voice Changer Online Free — Change Your Voice in a Recording',
    description:
      'Change a recorded voice: deeper, higher, robotic, telephone or radio. Applies to any recording you drop in. Free, instant and never uploaded.',
    tagline: 'Deeper, higher, robot, telephone, radio. Pick one and preview it.',
    short: 'Disguise or restyle a recorded voice.',
    category: 'speed',
    icon: 'mask-happy',
    related: ['pitch-shifter', 'voice-recorder', 'equalizer'],
    instant: true,
  },

  // ---------------- Effects ----------------
  {
    slug: 'reverb-adder',
    name: 'Add Reverb',
    title: 'Add Reverb to Audio Online Free — Reverb Effect Tool',
    description:
      'Add room, hall or cathedral reverb to any audio file. Adjustable decay, mix and pre-delay, rendered with real convolution. Free and private.',
    tagline: 'Put the recording in a room. Choose how big a room.',
    short: 'Add space and depth with real convolution reverb.',
    category: 'effects',
    icon: 'waves',
    related: ['echo-adder', 'slowed-reverb', 'equalizer'],
    instant: true,
  },
  {
    slug: 'echo-adder',
    name: 'Add Echo',
    title: 'Add Echo to Audio Online Free — Delay Effect Tool',
    description:
      'Add an echo or delay to any audio file. Control the delay time, how many repeats you get, and how loud they are. Instant preview, no upload.',
    tagline: 'Add repeats. Control how far apart and how many.',
    short: 'Add a delay or echo effect to a track.',
    category: 'effects',
    icon: 'broadcast',
    related: ['reverb-adder', 'voice-changer', 'equalizer'],
    instant: true,
  },
  {
    slug: '8d-audio-maker',
    name: '8D Audio Maker',
    title: '8D Audio Maker Online Free — Convert Songs to 8D',
    description:
      'Turn any song into 8D audio, where the sound orbits your head. Uses real HRTF spatial panning, not simple left-right panning. Best with headphones.',
    tagline: 'Make the sound orbit your head. Headphones required.',
    short: 'Turn a track into the 8D effect everyone shares.',
    category: 'effects',
    icon: 'planet',
    related: ['stereo-widener', 'slowed-reverb', 'reverb-adder'],
    instant: true,
  },
  {
    slug: 'equalizer',
    name: 'Audio Equalizer',
    title: 'Online Audio Equalizer Free — 8-Band EQ for MP3',
    description:
      'Shape the tone of any audio file with an eight-band equalizer. Presets for voice, music, podcast and bass, plus full manual control.',
    tagline: 'Eight bands, four presets, live preview.',
    short: 'Shape the tone of a track band by band.',
    category: 'effects',
    icon: 'equalizer',
    related: ['bass-booster', 'voice-changer', 'dynamic-compressor'],
    instant: true,
  },
  {
    slug: 'stereo-widener',
    name: 'Stereo Widener',
    title: 'Stereo Widener Online Free — Widen the Stereo Image',
    description:
      'Make a stereo mix sound wider, or narrow it toward mono. Uses mid/side processing, so the centre stays put while the sides move.',
    tagline: 'Push the mix wider, or pull it back toward the centre.',
    short: 'Widen or narrow the stereo image of a mix.',
    category: 'effects',
    icon: 'arrows-out-line-horizontal',
    related: ['8d-audio-maker', 'stereo-to-mono', 'equalizer'],
    instant: true,
  },

  // ---------------- Utility & analysis ----------------
  {
    slug: 'ringtone-maker',
    name: 'iPhone Ringtone Maker',
    title: 'iPhone Ringtone Maker — Make M4R Ringtones Online Free',
    description:
      'Cut any song into an iPhone ringtone and download it as M4R. Enforces the 30-second limit automatically, with step-by-step install instructions.',
    tagline: 'Cut a ringtone, get an M4R, and install it in a couple of minutes.',
    short: 'Make an M4R ringtone for iPhone from any song.',
    category: 'utility',
    icon: 'bell',
    related: ['android-ringtone-maker', 'audio-trimmer', 'fade-in-out', 'm4a-converter'],
    instant: false,
  },
  {
    slug: 'android-ringtone-maker',
    name: 'Android Ringtone Maker',
    title: 'Android Ringtone Maker — Make MP3 Ringtones Online Free',
    description:
      'Cut any song into an Android ringtone and download it as MP3, with instructions for setting it on Samsung, Pixel and other Android phones.',
    tagline: 'Cut a ringtone and save it as MP3 — no length limit on Android.',
    short: 'Make an MP3 ringtone for any Android phone.',
    category: 'utility',
    icon: 'android-logo',
    related: ['ringtone-maker', 'audio-trimmer', 'fade-in-out'],
    instant: true,
  },
  {
    slug: 'voice-recorder',
    name: 'Voice Recorder',
    title: 'Online Voice Recorder Free — Record Audio in Your Browser',
    description:
      'Record from your microphone and download the result. Nothing is uploaded, nothing is stored on a server, and no account is needed.',
    tagline: 'Record from your mic. The audio never leaves this tab.',
    short: 'Record straight from your microphone and download it.',
    category: 'utility',
    icon: 'microphone',
    related: ['audio-trimmer', 'silence-remover', 'audio-normalizer', 'voice-changer'],
    instant: true,
  },
  {
    slug: 'bpm-detector',
    name: 'BPM Detector',
    title: 'BPM Detector Online Free — Find the Tempo of Any Song',
    description:
      'Detect the tempo of any track in beats per minute, using onset detection and autocorrelation. Drop a file and read the number. No upload.',
    tagline: 'Find the tempo of a track. Drop it in and read the number.',
    short: 'Detect the BPM of any song automatically.',
    category: 'utility',
    icon: 'heartbeat',
    related: ['tempo-changer', 'speed-changer', 'loudness-meter'],
    instant: true,
  },
  {
    slug: 'loudness-meter',
    name: 'Loudness Meter',
    title: 'LUFS Meter Online Free — Measure Loudness and True Peak',
    description:
      'Measure integrated loudness (LUFS), loudness range and true peak using the ITU-R BS.1770-4 standard, and compare against every platform target.',
    tagline: 'Measure LUFS, loudness range and true peak — properly.',
    short: 'Measure loudness the way streaming platforms measure it.',
    category: 'utility',
    icon: 'gauge',
    related: ['audio-normalizer', 'dynamic-compressor', 'volume-booster'],
    instant: true,
  },
  {
    slug: 'waveform-generator',
    name: 'Waveform Image Generator',
    title: 'Waveform Image Generator — Make Waveform PNGs Online',
    description:
      'Turn an audio file into a waveform image you can use in a video, a thumbnail or a post. Choose colours, size and style, then download a PNG.',
    tagline: 'Turn a track into a waveform picture you can actually use.',
    short: 'Generate a waveform PNG from any audio file.',
    category: 'utility',
    icon: 'waveform',
    related: ['audio-trimmer', 'bpm-detector', 'loudness-meter'],
    instant: true,
  },
];

export const TOOLS_BY_SLUG = new Map(TOOLS.map((tool) => [tool.slug, tool]));

export function getTool(slug: string): Tool {
  const tool = TOOLS_BY_SLUG.get(slug);
  if (!tool) throw new Error(`Unknown tool slug: ${slug}`);
  return tool;
}

export function toolsIn(category: ToolCategory): Tool[] {
  return TOOLS.filter((tool) => tool.category === category);
}

export function relatedTools(slug: string): Tool[] {
  const tool = TOOLS_BY_SLUG.get(slug);
  if (!tool) return [];
  return tool.related
    .map((related) => TOOLS_BY_SLUG.get(related))
    .filter((t): t is Tool => Boolean(t));
}

export function categoryOf(slug: string): CategoryMeta | undefined {
  const tool = TOOLS_BY_SLUG.get(slug);
  return CATEGORIES.find((c) => c.id === tool?.category);
}
