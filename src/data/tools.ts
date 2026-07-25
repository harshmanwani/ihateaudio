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
  | 'utility'
  | 'ai';

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
      "Trim it, split it, stick bits together, cut out the dead air. All of it happens the instant you ask.",
  },
  {
    id: 'convert',
    name: 'Convert',
    blurb:
      "Get your file into whatever format the thing you're using demands. MP3 and WAV are instant; the rarer ones grab a converter once and then fly.",
  },
  {
    id: 'volume',
    name: 'Volume & loudness',
    blurb:
      "For recordings that came out too quiet, too loud, or all over the place. Includes the real loudness numbers Spotify and podcast hosts actually check.",
  },
  {
    id: 'speed',
    name: 'Speed & pitch',
    blurb:
      "Faster, slower, higher, lower. The pitch-keeping ones use proper time-stretching, so nobody ends up sounding like a chipmunk.",
  },
  {
    id: 'effects',
    name: 'Effects',
    blurb:
      "Reverb, echo, EQ, the spinning 8D thing. Rendered with your browser's own audio engine, which is better at this than you'd expect.",
  },
  {
    id: 'utility',
    name: 'Utility & analysis',
    blurb:
      "Ringtones, recording straight off your mic, and finding out what's actually in a file.",
  },
  {
    id: 'ai',
    name: 'AI studio',
    blurb:
      "Pull the vocals out of a song, split it into stems, or turn speech into text. The models download once and then run on your machine, which is why these are free and why nothing you feed them is uploaded.",
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
  /**
   * Phosphor icon name. Still the source of truth for small inline uses (chain
   * links, related lists, the all-tools menu) and the fallback when a tool has
   * no 3D art.
   */
  icon: string;
  /**
   * Custom 3D icon in /public/icons3d, named `<slug>.png`. Every tool has one;
   * the flag stays per-tool so a single bad render can drop back to its glyph
   * without touching the components.
   */
  icon3d?: boolean;
  /** Search synonyms — what people actually type, beyond the tool's name. */
  keywords: string[];
  /** Slugs of tools offered after an export, and in the sidebar. */
  related: string[];
  /** True when the tool never needs the ffmpeg download. */
  instant: boolean;
  /** Hidden from the grid, e.g. deep format variants. */
  secondary?: boolean;
  /**
   * Runs a neural network locally, which earns the AI badge and a warning about
   * the one-time download.
   */
  ai?: boolean;
  /**
   * Bytes of model weights the tool needs before it can run, for the badge and
   * the setup panel. Zero-download AI tools exist — the denoiser's network is
   * small enough to ship with the site — so this is not implied by `ai`.
   */
  modelBytes?: number;
}

export const TOOLS: Tool[] = [
  // ---------------- Cut & join ----------------
  {
    slug: 'audio-trimmer',
    name: 'Audio Trimmer',
    title: 'Audio Trimmer: Cut MP3 and Audio Files Online Free',
    description:
      'Trim and cut audio online free. Drag to select, preview, and download. Works with MP3, WAV, M4A and more. Nothing is uploaded. It all runs in your browser.',
    tagline: "Drag the handles, hear it, keep what you want.",
    short: "Snip a bit out of any audio file. Instantly.",
    category: 'cut',
    icon: 'scissors',
    icon3d: true,
    keywords: ['cut crop shorten clip snip mp3 cutter song cutter trim music ringtone cut'],
    related: ['audio-joiner', 'fade-in-out', 'volume-booster', 'ringtone-maker'],
    instant: true,
  },
  {
    slug: 'audio-joiner',
    name: 'Audio Joiner',
    title: 'Audio Joiner: Merge MP3 and Audio Files Online Free',
    description:
      'Merge multiple audio files into one, in any order. Drag to reorder, add a crossfade, and download. Free, no upload, no account.',
    tagline: "Stack your files up and glue them into one.",
    short: "Glue a few files into one, in whatever order you like.",
    category: 'cut',
    icon: 'arrows-merge',
    icon3d: true,
    keywords: ['merge combine join concatenate stitch put together append songs one file'],
    related: ['audio-trimmer', 'crossfade-joiner', 'audio-splitter', 'fade-in-out'],
    instant: true,
  },
  {
    slug: 'audio-splitter',
    name: 'Audio Splitter',
    title: 'Audio Splitter: Split Audio Files Into Parts Online',
    description:
      'Split one audio file into several: by equal parts, by a set length, or at every silence. Download each piece separately. Runs entirely in your browser.',
    tagline: "Chop one file into pieces, wherever you want the cuts.",
    short: "Break a long recording into parts you can grab separately.",
    category: 'cut',
    icon: 'split-horizontal',
    icon3d: true,
    keywords: ['split divide chop cut into parts chapters segments break up'],
    related: ['audio-trimmer', 'silence-remover', 'audio-joiner'],
    instant: true,
  },
  {
    slug: 'silence-remover',
    name: 'Silence Remover',
    title: 'Silence Remover: Cut Dead Air From Audio Online',
    description:
      'Automatically remove silent gaps from a recording. Adjustable threshold and minimum gap length, with a preview before you commit. Free and private.',
    tagline: "Finds every awkward pause and yanks it out.",
    short: "Kill the dead air in interviews, lectures and voice notes.",
    category: 'cut',
    icon: 'speaker-slash',
    icon3d: true,
    keywords: ['remove silence dead air gaps pauses tighten podcast cleanup auto trim'],
    related: ['audio-normalizer', 'audio-trimmer', 'audio-splitter'],
    instant: true,
  },
  {
    slug: 'fade-in-out',
    name: 'Fade In and Out',
    title: 'Add Fade In and Fade Out to Audio Online Free',
    description:
      'Add a smooth fade in at the start and fade out at the end of any audio file. Four curve shapes, adjustable length, instant preview. No upload needed.',
    tagline: "Ease it in, ease it out. No abrupt starts.",
    short: "Give a track a soft opening and a soft landing.",
    category: 'cut',
    icon: 'wave-sine',
    icon3d: true,
    keywords: ['fade in fade out fades smooth start end soften intro outro'],
    related: ['audio-trimmer', 'crossfade-joiner', 'volume-booster'],
    instant: true,
  },
  {
    slug: 'audio-reverser',
    name: 'Audio Reverser',
    title: 'Reverse Audio Online: Play Any Sound Backwards',
    description:
      'Reverse any audio file so it plays backwards. Instant, free, and runs entirely in your browser with no upload or signup.',
    tagline: "Plays it backwards. That is the entire tool.",
    short: "Flip a track so it runs end to start.",
    category: 'cut',
    icon: 'rewind',
    icon3d: true,
    keywords: ['reverse backwards backmasking play in reverse flip'],
    related: ['speed-changer', 'pitch-shifter', 'audio-trimmer'],
    instant: true,
  },
  {
    slug: 'audio-looper',
    name: 'Audio Looper',
    title: 'Audio Looper: Repeat and Loop Audio Files Online',
    description:
      'Repeat an audio file any number of times, with an optional gap between repeats. Useful for backing tracks, practice loops and ambience.',
    tagline: "Repeat a clip as many times as you need.",
    short: "Turn a short clip into something much longer.",
    category: 'cut',
    icon: 'repeat',
    icon3d: true,
    keywords: ['loop repeat extend seamless background music hour version'],
    related: ['audio-trimmer', 'audio-joiner', 'crossfade-joiner'],
    instant: true,
  },
  {
    slug: 'crossfade-joiner',
    name: 'Crossfade Joiner',
    title: 'Crossfade Audio Online: Blend Tracks Together',
    description:
      'Join audio files with a smooth crossfade instead of a hard cut. Equal-power blending keeps the volume steady through the transition.',
    tagline: "Blend one track into the next instead of slamming them together.",
    short: "Merge tracks with a smooth handover between them.",
    category: 'cut',
    icon: 'intersect',
    icon3d: true,
    keywords: ['crossfade blend mix transition dj smooth join overlap'],
    related: ['audio-joiner', 'fade-in-out', 'audio-trimmer'],
    instant: true,
  },

  // ---------------- Convert ----------------
  {
    slug: 'audio-converter',
    name: 'Audio Converter',
    title: 'Audio Converter: Convert Audio Files Online Free',
    description:
      'Convert audio between MP3, WAV, M4A, OGG, FLAC, AAC, Opus, AIFF and WMA. No upload, no size limit, no account. Everything runs in your browser.',
    tagline: "Any format in, any format out. Nothing leaves your device.",
    short: "Move between MP3, WAV, M4A, OGG, FLAC and the rest.",
    category: 'convert',
    icon: 'swap',
    icon3d: true,
    keywords: ['convert change format transcode any to any file type'],
    related: ['mp3-converter', 'wav-converter', 'audio-compressor', 'video-to-audio'],
    instant: false,
  },
  {
    slug: 'mp3-converter',
    name: 'Convert to MP3',
    title: 'Convert to MP3 Online Free: WAV, M4A, OGG to MP3',
    description:
      'Convert any audio file to MP3 in your browser. Choose the bitrate, see the output size before you download. Free, unlimited, nothing uploaded.',
    tagline: "Turn anything into an MP3. Pick your quality and go.",
    short: "Get an MP3 out of whatever you started with.",
    category: 'convert',
    icon: 'music-note',
    icon3d: true,
    keywords: ['wav to mp3 m4a to mp3 flac to mp3 ogg to mp3 convert to mp3 make mp3'],
    related: ['audio-converter', 'wav-converter', 'audio-compressor'],
    instant: true,
  },
  {
    slug: 'wav-converter',
    name: 'Convert to WAV',
    title: 'Convert to WAV Online Free: MP3 to WAV Converter',
    description:
      'Convert audio to uncompressed WAV in your browser. Choose 16, 24 or 32-bit depth. Instant, lossless from this point on, and nothing is uploaded.',
    tagline: "Straight to uncompressed WAV. Nothing to download first.",
    short: "Convert to WAV at 16, 24 or 32-bit.",
    category: 'convert',
    icon: 'wave-square',
    icon3d: true,
    keywords: ['mp3 to wav convert to wav uncompressed pcm lossless'],
    related: ['audio-converter', 'mp3-converter', 'flac-converter'],
    instant: true,
  },
  {
    slug: 'm4a-converter',
    name: 'Convert to M4A',
    title: 'Convert to M4A Online Free: MP3 to M4A (AAC) Converter',
    description:
      'Convert audio to M4A (AAC) in your browser. Better quality than MP3 at the same file size, and the format Apple devices prefer.',
    tagline: "Better sound than MP3 at the same file size.",
    short: "Convert to M4A, the one Apple gear prefers.",
    category: 'convert',
    icon: 'apple-logo',
    icon3d: true,
    keywords: ['mp3 to m4a convert to m4a aac apple itunes iphone format'],
    related: ['audio-converter', 'mp3-converter', 'ringtone-maker'],
    instant: false,
  },
  {
    slug: 'ogg-converter',
    name: 'Convert to OGG',
    title: 'Convert to OGG Online Free: MP3 to OGG Vorbis Converter',
    description:
      'Convert audio to OGG Vorbis in your browser. The open format used by games, Godot, Unity and much of the Android ecosystem.',
    tagline: "The format Unity and Godot are expecting.",
    short: "Convert to OGG Vorbis for games and open platforms.",
    category: 'convert',
    icon: 'game-controller',
    icon3d: true,
    keywords: ['mp3 to ogg convert to ogg vorbis game unity godot'],
    related: ['audio-converter', 'mp3-converter', 'audio-compressor'],
    instant: false,
  },
  {
    slug: 'flac-converter',
    name: 'Convert to FLAC',
    title: 'Convert to FLAC Online Free: Lossless Audio Converter',
    description:
      'Convert audio to FLAC in your browser. Lossless compression at roughly half the size of WAV, with no quality loss at all.',
    tagline: "Lossless, and about half the size of a WAV.",
    short: "Convert to FLAC when you want to keep every bit.",
    category: 'convert',
    icon: 'archive',
    icon3d: true,
    keywords: ['mp3 to flac wav to flac convert to flac lossless archive'],
    related: ['audio-converter', 'wav-converter', 'mp3-converter'],
    instant: false,
  },
  {
    slug: 'video-to-audio',
    name: 'Video to Audio',
    title: 'Video to Audio Converter: MP4 to MP3 Online Free',
    description:
      'Extract the soundtrack from MP4, MOV, MKV, WEBM and AVI files and save it as MP3, WAV or M4A. Runs in your browser, videos are never uploaded.',
    tagline: "Grab the sound out of a video and leave the picture behind.",
    short: "Pull the audio out of MP4, MOV, MKV and friends.",
    category: 'convert',
    icon: 'film-strip',
    icon3d: true,
    keywords: ['mp4 to mp3 extract audio from video mov mkv webm soundtrack rip audio youtube video sound'],
    related: ['audio-converter', 'mp3-converter', 'audio-trimmer'],
    instant: false,
  },
  {
    slug: 'audio-compressor',
    name: 'Reduce Audio File Size',
    title: 'Compress Audio Online Free: Reduce MP3 File Size',
    description:
      'Make an audio file smaller by lowering the bitrate, sample rate or channel count. See the projected size before you download. No upload required.',
    tagline: "Make the file smaller. See exactly how small before you commit.",
    short: "Shrink a file that's too big to email or send.",
    category: 'convert',
    icon: 'arrows-in-simple',
    icon3d: true,
    keywords: ['compress shrink reduce file size smaller mb email whatsapp limit kb'],
    related: ['audio-converter', 'mp3-converter', 'sample-rate-converter'],
    instant: true,
  },
  {
    slug: 'sample-rate-converter',
    name: 'Sample Rate Converter',
    title: 'Change Audio Sample Rate Online: 44.1kHz, 48kHz, 22kHz',
    description:
      'Resample audio to 8, 16, 22.05, 32, 44.1, 48 or 96 kHz. Useful for game engines, telephony systems and hardware with fixed rate requirements.',
    tagline: "Match whatever rate your gear insists on.",
    short: "Change the sample rate for a device or game engine.",
    category: 'convert',
    icon: 'stairs',
    icon3d: true,
    keywords: ['resample 44100 48000 22050 16khz 8khz hz sample rate change'],
    related: ['audio-compressor', 'audio-converter', 'wav-converter'],
    instant: true,
  },

  // ---------------- Volume & loudness ----------------
  {
    slug: 'volume-booster',
    name: 'Volume Booster',
    title: 'Increase Audio Volume Online Free: MP3 Volume Booster',
    description:
      'Make a quiet recording louder. Boost by a set amount or normalize to the loudest safe level, with clipping protection and a live preview.',
    tagline: "Rescue a recording that came out way too quiet.",
    short: "Turn up something you can barely hear.",
    category: 'volume',
    icon: 'speaker-high',
    icon3d: true,
    keywords: ['louder increase volume boost gain amplify quiet recording turn up'],
    related: ['audio-normalizer', 'bass-booster', 'dynamic-compressor', 'silence-remover'],
    instant: true,
  },
  {
    slug: 'audio-normalizer',
    name: 'Audio Normalizer',
    title: 'Audio Normalizer: Normalize to LUFS Online Free',
    description:
      'Normalize audio to a target loudness in LUFS, using the same ITU-R BS.1770 measurement Spotify, YouTube and podcast hosts use. With true-peak limiting.',
    tagline: "Hit the exact loudness your platform is measuring.",
    short: "Land on -14 LUFS for Spotify, -16 for podcasts, and so on.",
    category: 'volume',
    icon: 'equals',
    icon3d: true,
    keywords: ['normalize lufs loudness spotify youtube podcast level target -14 -16'],
    related: ['loudness-meter', 'volume-booster', 'dynamic-compressor', 'silence-remover'],
    instant: true,
  },
  {
    slug: 'bass-booster',
    name: 'Bass Booster',
    title: 'Bass Booster Online Free: Add Bass to MP3',
    description:
      'Boost the low end of any track with a proper low-shelf filter. Adjustable amount and corner frequency, with instant preview. Free and private.',
    tagline: "Add weight down low, with a proper shelf filter.",
    short: "Give the low end some actual body.",
    category: 'volume',
    icon: 'speaker-low',
    icon3d: true,
    keywords: ['bass boost low end sub deep 808 heavy'],
    related: ['equalizer', 'volume-booster', 'stereo-widener'],
    instant: true,
  },
  {
    slug: 'dynamic-compressor',
    name: 'Audio Compressor (Dynamics)',
    title: 'Audio Dynamic Range Compressor Online Free',
    description:
      'Even out the loud and quiet parts of a recording with threshold, ratio, attack and release controls. Ideal for voice, podcasts and interviews.',
    tagline: "Tame a recording where the volume keeps jumping around.",
    short: "Even out levels that swing all over the place.",
    category: 'volume',
    icon: 'faders',
    icon3d: true,
    keywords: ['compressor dynamics even out levels smooth voice leveler'],
    related: ['audio-normalizer', 'volume-booster', 'silence-remover'],
    instant: true,
  },
  {
    slug: 'stereo-to-mono',
    name: 'Stereo to Mono',
    title: 'Convert Stereo to Mono Online Free: And Mono to Stereo',
    description:
      'Downmix stereo to mono, or duplicate mono to stereo. Also split a stereo file into separate left and right channel files. Instant, no upload.',
    tagline: "Squash to mono, spread to stereo, or pull the channels apart.",
    short: "Switch between mono and stereo, or split the channels.",
    category: 'volume',
    icon: 'headphones',
    icon3d: true,
    keywords: ['stereo mono downmix one channel split channels left right'],
    related: ['audio-compressor', 'stereo-widener', 'audio-converter'],
    instant: true,
  },

  // ---------------- Speed & pitch ----------------
  {
    slug: 'speed-changer',
    name: 'Audio Speed Changer',
    title: 'Change Audio Speed Online Free: Speed Up or Slow Down MP3',
    description:
      'Speed up or slow down audio, with the option to keep the original pitch. 0.25x to 4x, with live preview. Runs entirely in your browser.',
    tagline: "Speed it up or slow it down. Keep the pitch, or don't.",
    short: "Change playback speed, with or without the pitch moving.",
    category: 'speed',
    icon: 'fast-forward',
    icon3d: true,
    keywords: ['speed up slow down faster slower playback rate 2x 0.5x sped up'],
    related: ['tempo-changer', 'pitch-shifter', 'slowed-reverb', 'nightcore-maker'],
    instant: true,
  },
  {
    slug: 'pitch-shifter',
    name: 'Pitch Shifter',
    title: 'Change Audio Pitch Online Free: Pitch Shifter Tool',
    description:
      'Shift pitch up or down by semitones without changing the length. Real time-stretching, so voices stay natural instead of turning into chipmunks.',
    tagline: "Move the pitch, leave the length exactly where it was.",
    short: "Shift a track up or down by semitones.",
    category: 'speed',
    icon: 'arrows-vertical',
    icon3d: true,
    keywords: ['pitch up down higher lower deeper semitone transpose key change'],
    related: ['speed-changer', 'tempo-changer', 'voice-changer', 'nightcore-maker'],
    instant: true,
  },
  {
    slug: 'tempo-changer',
    name: 'Tempo Changer',
    title: 'Change Tempo Without Changing Pitch: Online and Free',
    description:
      'Speed up or slow down music while holding the pitch exactly where it is. Uses WSOLA time-stretching, the same technique DAWs use.',
    tagline: "Slow the music down to learn it. Pitch stays put.",
    short: "Change the speed while the pitch holds still.",
    category: 'speed',
    icon: 'metronome',
    icon3d: true,
    keywords: ['tempo bpm faster slower keep pitch practice slow down music'],
    related: ['speed-changer', 'pitch-shifter', 'bpm-detector'],
    instant: true,
  },
  {
    slug: 'slowed-reverb',
    name: 'Slowed + Reverb Maker',
    title: 'Slowed and Reverb Maker Online Free: No Signup',
    description:
      'Turn any song into a slowed + reverb edit. Adjustable slowdown and reverb depth, with instant preview. Free, no watermark, no account, no upload.',
    tagline: "That slowed and reverb sound, in about ten seconds.",
    short: "Make the slowed + reverb edit everyone's posting.",
    category: 'speed',
    icon: 'moon-stars',
    icon3d: true,
    keywords: ['slowed and reverb slowed down tiktok edit aesthetic chill daycore'],
    related: ['nightcore-maker', 'speed-changer', 'reverb-adder', '8d-audio-maker'],
    instant: true,
  },
  {
    slug: 'nightcore-maker',
    name: 'Nightcore Maker',
    title: 'Nightcore Maker Online Free: Make Nightcore Songs',
    description:
      'Turn any song into nightcore: faster tempo and higher pitch, the classic sped-up sound. Adjustable intensity, instant preview, free with no signup.',
    tagline: "Faster and higher. The proper nightcore treatment.",
    short: "Speed up and pitch up a track, nightcore style.",
    category: 'speed',
    icon: 'lightning',
    icon3d: true,
    keywords: ['nightcore sped up fast high pitch anime edit spedup version'],
    related: ['slowed-reverb', 'speed-changer', 'pitch-shifter'],
    instant: true,
  },
  {
    slug: 'voice-changer',
    name: 'Voice Changer',
    title: 'Voice Changer Online Free: Change Your Voice in a Recording',
    description:
      'Change a recorded voice: deeper, higher, robotic, telephone or radio. Applies to any recording you drop in. Free, instant and never uploaded.',
    tagline: "Deeper, higher, robot, phone. Pick one and hear it.",
    short: "Disguise or restyle a recorded voice.",
    category: 'speed',
    icon: 'mask-happy',
    icon3d: true,
    keywords: ['voice changer deep voice chipmunk robot funny disguise anonymous'],
    related: ['pitch-shifter', 'voice-recorder', 'equalizer'],
    instant: true,
  },

  // ---------------- Effects ----------------
  {
    slug: 'reverb-adder',
    name: 'Add Reverb',
    title: 'Add Reverb to Audio Online Free: Reverb Effect Tool',
    description:
      'Add room, hall or cathedral reverb to any audio file. Adjustable decay, mix and pre-delay, rendered with real convolution. Free and private.',
    tagline: "Drop the recording into a room. You choose how big.",
    short: "Add space and depth with real convolution reverb.",
    category: 'effects',
    icon: 'waves',
    icon3d: true,
    keywords: ['reverb echo room hall cathedral space wet ambience'],
    related: ['echo-adder', 'slowed-reverb', 'equalizer'],
    instant: true,
  },
  {
    slug: 'echo-adder',
    name: 'Add Echo',
    title: 'Add Echo to Audio Online Free: Delay Effect Tool',
    description:
      'Add an echo or delay to any audio file. Control the delay time, how many repeats you get, and how loud they are. Instant preview, no upload.',
    tagline: "Add repeats. You decide how many and how far apart.",
    short: "Put an echo or delay on a track.",
    category: 'effects',
    icon: 'broadcast',
    icon3d: true,
    keywords: ['echo delay repeat trail dub slapback'],
    related: ['reverb-adder', 'voice-changer', 'equalizer'],
    instant: true,
  },
  {
    slug: '8d-audio-maker',
    name: '8D Audio Maker',
    title: '8D Audio Maker Online Free: Convert Songs to 8D',
    description:
      'Turn any song into 8D audio, where the sound orbits your head. Uses real HRTF spatial panning, not simple left-right panning. Best with headphones.',
    tagline: "Makes the sound circle your head. Headphones only.",
    short: "Turn a track into the 8D thing everyone shares.",
    category: 'effects',
    icon: 'planet',
    icon3d: true,
    keywords: ['8d audio surround rotating spatial headphones 3d moving around head'],
    related: ['stereo-widener', 'slowed-reverb', 'reverb-adder'],
    instant: true,
  },
  {
    slug: 'equalizer',
    name: 'Audio Equalizer',
    title: 'Online Audio Equalizer Free: 8-Band EQ for MP3',
    description:
      'Shape the tone of any audio file with an eight-band equalizer. Presets for voice, music, podcast and bass, plus full manual control.',
    tagline: "Eight bands, four presets, and you hear it as you move them.",
    short: "Shape the tone of a track band by band.",
    category: 'effects',
    icon: 'equalizer',
    icon3d: true,
    keywords: ['eq equalizer bands frequency treble mids tone shape'],
    related: ['bass-booster', 'voice-changer', 'dynamic-compressor'],
    instant: true,
  },
  {
    slug: 'stereo-widener',
    name: 'Stereo Widener',
    title: 'Stereo Widener Online Free: Widen the Stereo Image',
    description:
      'Make a stereo mix sound wider, or narrow it toward mono. Uses mid/side processing, so the centre stays put while the sides move.',
    tagline: "Push the mix wider, or pull it back to the middle.",
    short: "Widen or narrow how spread out a mix sounds.",
    category: 'effects',
    icon: 'arrows-out-line-horizontal',
    icon3d: true,
    keywords: ['wide widen stereo image bigger spacious mid side'],
    related: ['8d-audio-maker', 'stereo-to-mono', 'equalizer'],
    instant: true,
  },

  // ---------------- Utility & analysis ----------------
  {
    slug: 'ringtone-maker',
    name: 'iPhone Ringtone Maker',
    title: 'iPhone Ringtone Maker: Make M4R Ringtones Online Free',
    description:
      'Cut any song into an iPhone ringtone and download it as M4R. Enforces the 30-second limit automatically, with step-by-step install instructions.',
    tagline: "Cut a ringtone, get an M4R, and we'll walk you through installing it.",
    short: "Make an M4R iPhone ringtone out of any song.",
    category: 'utility',
    icon: 'bell',
    icon3d: true,
    keywords: ['iphone ringtone m4r make ringtone from song custom text tone'],
    related: ['android-ringtone-maker', 'audio-trimmer', 'fade-in-out', 'm4a-converter'],
    instant: false,
  },
  {
    slug: 'android-ringtone-maker',
    name: 'Android Ringtone Maker',
    title: 'Android Ringtone Maker: Make MP3 Ringtones Online Free',
    description:
      'Cut any song into an Android ringtone and download it as MP3, with instructions for setting it on Samsung, Pixel and other Android phones.',
    tagline: "Cut a ringtone, save the MP3, done. No length limit here.",
    short: "Make an MP3 ringtone for any Android phone.",
    category: 'utility',
    icon: 'android-logo',
    icon3d: true,
    keywords: ['android ringtone samsung pixel mp3 ringtone notification sound'],
    related: ['ringtone-maker', 'audio-trimmer', 'fade-in-out'],
    instant: true,
  },
  {
    slug: 'voice-recorder',
    name: 'Voice Recorder',
    title: 'Online Voice Recorder Free: Record Audio in Your Browser',
    description:
      'Record from your microphone and download the result. Nothing is uploaded, nothing is stored on a server, and no account is needed.',
    tagline: "Record off your mic. It never leaves this tab.",
    short: "Record straight from your microphone and keep the file.",
    category: 'utility',
    icon: 'microphone',
    icon3d: true,
    keywords: ['record voice mic microphone memo dictation online recorder'],
    related: ['audio-trimmer', 'silence-remover', 'audio-normalizer', 'voice-changer'],
    instant: true,
  },
  {
    slug: 'bpm-detector',
    name: 'BPM Detector',
    title: 'BPM Detector Online Free: Find the Tempo of Any Song',
    description:
      'Detect the tempo of any track in beats per minute, using onset detection and autocorrelation. Drop a file and read the number. No upload.',
    tagline: "Drop a track in and read the number.",
    short: "Find out the BPM of any song automatically.",
    category: 'utility',
    icon: 'heartbeat',
    icon3d: true,
    keywords: ['bpm tempo finder beats per minute what bpm song speed detect'],
    related: ['tempo-changer', 'speed-changer', 'loudness-meter'],
    instant: true,
  },
  {
    slug: 'loudness-meter',
    name: 'Loudness Meter',
    title: 'LUFS Meter Online Free: Measure Loudness and True Peak',
    description:
      'Measure integrated loudness (LUFS), loudness range and true peak using the ITU-R BS.1770-4 standard, and compare against every platform target.',
    tagline: "LUFS, loudness range and true peak. Measured properly.",
    short: "Check loudness the way streaming platforms check it.",
    category: 'utility',
    icon: 'gauge',
    icon3d: true,
    keywords: ['lufs meter loudness check measure true peak dbfs how loud'],
    related: ['audio-normalizer', 'dynamic-compressor', 'volume-booster'],
    instant: true,
  },
  {
    slug: 'waveform-generator',
    name: 'Waveform Image Generator',
    title: 'Waveform Image Generator: Make Waveform PNGs Online',
    description:
      'Turn an audio file into a waveform image you can use in a video, a thumbnail or a post. Choose colours, size and style, then download a PNG.',
    tagline: "Turn a track into a waveform picture you can actually use.",
    short: "Make a waveform PNG out of any audio file.",
    category: 'utility',
    icon: 'waveform',
    icon3d: true,
    keywords: ['waveform image png picture visualizer soundwave art poster'],
    related: ['audio-trimmer', 'bpm-detector', 'loudness-meter'],
    instant: true,
  },

  // ---------------- AI studio ----------------
  // These run real neural networks in the browser. The weights are fetched once
  // and kept, which is why `instant` is false and why every one of them carries a
  // download figure the setup panel can quote before asking anyone to wait.
  {
    slug: 'vocal-remover',
    name: 'Vocal Remover',
    title: 'Vocal Remover: Remove Vocals From a Song Free',
    description:
      'Remove the vocals from any song and keep the backing track. Runs an AI model in your browser, so nothing is uploaded and there is no queue. Free, no account.',
    tagline: "Take the singer out and keep the band.",
    short: "Strip the vocals off a track and keep the instrumental.",
    category: 'ai',
    icon: 'microphone-slash',
    icon3d: true,
    keywords: [
      'vocal remover remove vocals karaoke instrumental backing track minus one strip singer ai vocal removal',
    ],
    related: ['acapella-extractor', 'stem-splitter', 'audio-trimmer', 'noise-remover'],
    instant: false,
    ai: true,
    modelBytes: 66_759_214,
  },
  {
    slug: 'acapella-extractor',
    name: 'Acapella Extractor',
    title: 'Acapella Extractor: Isolate Vocals From a Song Free',
    description:
      'Pull the vocals out of a song on their own. The same AI model that makes instrumentals, pointed the other way. Runs in your browser with nothing uploaded.',
    tagline: "Just the voice, with the band taken away.",
    short: "Get the vocal on its own, with the music removed.",
    category: 'ai',
    icon: 'microphone-stage',
    icon3d: true,
    keywords: [
      'acapella extractor isolate vocals extract vocal only voice separator vocal isolation get vocals from song ai',
    ],
    related: ['vocal-remover', 'stem-splitter', 'audio-transcriber', 'noise-remover'],
    instant: false,
    ai: true,
    modelBytes: 66_759_214,
  },
  {
    slug: 'stem-splitter',
    name: 'Stem Splitter',
    title: 'Stem Splitter: Split a Song Into Stems Online Free',
    description:
      'Split a song into vocals, drums, bass and everything else. Pick only the stems you want. AI models run in your browser, so nothing is uploaded.',
    tagline: "Pull a song apart into the parts it was built from.",
    short: "Break a song into vocals, drums, bass and the rest.",
    category: 'ai',
    icon: 'cards-three',
    icon3d: true,
    keywords: [
      'stem splitter stem separation split song into stems drums bass vocals separator multitrack demix ai',
    ],
    related: ['vocal-remover', 'acapella-extractor', 'bpm-detector', 'audio-splitter'],
    instant: false,
    ai: true,
    // One 28 MB network per stem. The tool only fetches the ones asked for, so
    // this is the all-four figure rather than a fixed cost.
    modelBytes: 118_812_816,
  },
  {
    slug: 'audio-transcriber',
    name: 'Audio Transcriber',
    title: 'Audio to Text: Transcribe Audio Online Free',
    description:
      'Turn speech in an audio file into text you can copy or download. Whisper runs in your browser, so recordings are never uploaded. Free, no length limit.',
    tagline: "Speech in, text out, nothing uploaded.",
    short: "Turn a recording of someone talking into text.",
    category: 'ai',
    icon: 'text-t',
    icon3d: true,
    keywords: [
      'audio to text transcribe transcription speech to text whisper convert voice to text dictation interview transcript free',
    ],
    related: ['subtitle-generator', 'noise-remover', 'silence-remover', 'voice-recorder'],
    instant: false,
    ai: true,
    modelBytes: 40_843_851,
  },
  {
    slug: 'subtitle-generator',
    name: 'Subtitle Generator',
    title: 'Subtitle Generator: Make SRT Subtitles Free',
    description:
      'Generate timed SRT or VTT subtitles from audio or video. Whisper runs in your browser, so your file is never uploaded. Free, and it handles long recordings.',
    tagline: "Timed captions, written by listening to the file.",
    short: "Make an SRT or VTT subtitle file from speech.",
    category: 'ai',
    icon: 'closed-captioning',
    icon3d: true,
    keywords: [
      'subtitle generator srt vtt captions auto subtitles caption maker video subtitles timed transcript free',
    ],
    related: ['audio-transcriber', 'video-to-audio', 'noise-remover', 'silence-remover'],
    instant: false,
    ai: true,
    modelBytes: 40_843_851,
  },
  {
    slug: 'noise-remover',
    name: 'Background Noise Remover',
    title: 'Remove Background Noise From Audio Free',
    description:
      'Clean hiss, hum, fans and room noise out of a recording with a neural denoiser. No download to wait for, nothing uploaded, and it runs in seconds.',
    tagline: "Take the room out and leave the voice.",
    short: "Clean hiss, hum and room noise off a recording.",
    category: 'ai',
    icon: 'wind',
    icon3d: true,
    keywords: [
      'noise remover remove background noise denoise clean audio hiss hum fan reduce noise voice cleanup ai denoiser',
    ],
    related: ['audio-transcriber', 'silence-remover', 'volume-booster', 'equalizer'],
    // The denoising network is small enough to ship with the site, so this one
    // needs no download at all and behaves like the instant tools.
    instant: true,
    ai: true,
    modelBytes: 0,
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
