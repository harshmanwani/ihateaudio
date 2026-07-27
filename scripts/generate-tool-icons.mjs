/**
 * Generates the 3D tool icons with fal.ai FLUX.
 *
 * Run with a key in the environment; it is never stored in the repo:
 *   FAL_KEY=... node scripts/generate-tool-icons.mjs [slug ...]
 *
 * The output is committed, so this only runs when an icon needs (re)making.
 * The shared STYLE string is what keeps eight separate generations looking like
 * one family: same material, same lighting, same palette, same framing. Only
 * the subject changes.
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY = process.env.FAL_KEY;
if (!KEY) {
  console.error('Set FAL_KEY in the environment. Nothing was generated.');
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'icons3d');
mkdirSync(outDir, { recursive: true });

/**
 * The house style. Soft matte clay, chunky and rounded, lit from above left,
 * on a transparent-ready plain background, with our own green/cream palette
 * rather than the rainbow these models default to.
 */
const STYLE = [
  '3D clay render icon, matte plasticine material',
  'chunky rounded friendly forms, thick and simple, bold readable silhouette',
  'three-quarter isometric view, single centered object filling the frame',
  'mint green and deep forest green with warm cream accents',
  'even soft studio light from upper left, small soft contact shadow',
  // Pure white, not cream: cream is the saturated AI default and it clashes
  // with the site's literal-white page.
  'isolated on a pure white background, nothing else in frame',
  // FLUX renders shallow depth of field by default, which makes an icon look
  // like a photo of an object rather than an icon.
  'everything in sharp focus, no depth of field, no blur, no bokeh',
  'clean vector-like clarity, app icon, instantly recognisable',
].join(', ');

const NEGATIVE = [
  'text, letters, words, numbers, watermark, signature, label',
  'blurry, out of focus, bokeh, depth of field, motion blur',
  'cream background, beige background, yellow background, gradient background',
  'photorealistic, glossy, metallic, chrome, neon, glowing, wet',
  'busy background, scenery, multiple objects, collage, pattern',
  'thin lines, wireframe, flat 2d illustration, sketch, melted, deformed, distorted',
  'dark background, harsh shadows, cluttered, abstract blob',
].join(', ');

/**
 * Subjects. Each is a concrete physical object or gesture, because these models
 * render nouns far better than concepts: "a hand shushing" works, "silence
 * removal" does not.
 */
const SUBJECTS = {
  'audio-trimmer':
    'a chunky pair of open scissors standing upright, blades apart, clean and undamaged, toy-like',
  'audio-joiner':
    'two thick rounded jigsaw puzzle pieces interlocking, one mint green and one cream',
  'audio-splitter':
    'one long thick rounded mint green bar lying horizontally, cleanly cut into three separate equal pieces with clear gaps between them, all three pieces still lined up in one straight row',
  'silence-remover':
    'a cute rounded cartoon head seen from the front, one chunky hand raised with a single index finger held vertically in front of its closed mouth, making a shush gesture, eyes closed',
  'fade-in-out':
    'five chunky vertical rounded mint green bars of increasing then decreasing height standing side by side in a row, forming a symmetrical pyramid shape, all bars the same mint green colour',
  'audio-reverser':
    'one single chunky mint green rewind arrow shape, a thick arrow body curving around and its triangular arrowhead pointing left, simple solid toy object standing alone',
  'audio-looper':
    'a thick rounded circular ring like a doughnut with a small arrowhead on it pointing clockwise',
  'crossfade-joiner':
    'two thick rounded flat ribbons crossing over each other in an X shape, one mint green and one cream',

  // Convert. The nine converter pages are the highest-risk group for looking
  // interchangeable, so each gets a distinct physical object rather than nine
  // variations on an arrow.
  'audio-converter':
    'two thick rounded arrows chasing each other in a circle, one mint green and one cream, forming a two-way swap loop',
  'mp3-converter':
    'one single chunky rounded music note, mint green, standing upright as a solid toy object',
  'wav-converter':
    'a chunky rounded reel of magnetic studio tape seen at a three-quarter angle, cream reel with mint green tape wound around it',
  'm4a-converter':
    'a chunky rounded mint green apple with one small cream leaf on top, solid toy object',
  'ogg-converter':
    'one single chunky rounded egg standing upright in a small cream egg cup, the egg mint green',
  'flac-converter':
    'a thick rounded treasure chest with its domed lid propped slightly open, cream body with mint green bands',
  'video-to-audio':
    'a chunky rounded cream film clapperboard lying flat with one small solid mint green music note resting on top of it',
  'audio-compressor':
    'a thick rounded mint green block clamped in a cream C-shaped vise with its screw turned tight, the block visibly squashed narrower where the vise presses it',
  'sample-rate-converter':
    'three chunky rounded mint green blocks stacked into a small staircase of three steps, solid toy shape',

  // Volume and loudness.
  'volume-booster':
    'a chunky rounded megaphone pointing up and to the right, mint green cone with a cream handle',
  'audio-normalizer':
    'a chunky rounded toy balance scale, mint green post with two cream pans hanging perfectly level with each other',
  'bass-booster':
    'a chunky rounded low wide speaker cabinet in mint green with one large deep cream speaker cone in the middle',
  'dynamic-compressor':
    'a chunky rounded mint green hand gripping and squeezing a soft cream ball, the ball dented where the fingers press',
  'stereo-to-mono':
    'a chunky rounded Y-shaped cable, two mint green plugs at the top joining down into one single cream plug at the bottom',

  // Speed and pitch.
  'speed-changer':
    'a chunky rounded speedometer dial, cream face with a thick mint green needle pointing up and to the right',
  'pitch-shifter':
    'one single chunky rounded tuning fork standing upright, mint green, two thick tines and a short handle',
  'tempo-changer':
    'a chunky rounded metronome, cream pyramid body with a mint green pendulum arm tilted to one side',
  'slowed-reverb':
    'a chunky rounded crescent moon in mint green with two small solid cream stars beside it',
  'nightcore-maker':
    'a chunky rounded toy rocket tilted upward, mint green body with cream fins and a round window',
  'voice-changer':
    'two chunky rounded theatre masks standing side by side, one mint green with a smiling mouth and one cream with a frowning mouth, simple cut-out eyes',

  // Effects.
  'reverb-adder':
    'a chunky rounded cream pebble sitting in mint green water with three thick concentric ripple rings spreading around it',
  'echo-adder':
    'a chunky rounded mint green ball with three smaller cream copies of itself trailing behind it along a curved bouncing path, each copy smaller than the one before',
  '8d-audio-maker':
    'a chunky rounded mint green globe with one thick cream ring orbiting around it at a tilt',
  equalizer:
    'a chunky rounded cream control panel with five thick vertical slider tracks, each with a mint green knob sitting at a different height',
  'stereo-widener':
    'one thick mint green double-headed arrow lying horizontally, with a large clear triangular arrowhead on its left end and another large triangular arrowhead on its right end, both pointing away from each other',

  // Utility and analysis.
  'ringtone-maker':
    'a chunky rounded hand bell tilted as if ringing, mint green bell with a cream handle',
  'android-ringtone-maker':
    'a chunky rounded cream robot head with two short mint green antennae and two simple round eyes',
  'voice-recorder':
    'a chunky rounded studio microphone on a small cream desk stand, mint green capsule with a rounded grille',
  'bpm-detector':
    'a chunky rounded mint green heart with a thick cream zigzag pulse line running straight across its middle',
  'loudness-meter':
    'one single chunky rounded analogue VU meter gauge, a round cream dial face with a thick mint green needle swung to the upper right, set in a rounded mint green case, nothing else in the frame',
  'waveform-generator':
    'a chunky rounded cream picture frame standing upright with five solid mint green bars of different heights inside it',

  // Utility, continued.
  'key-finder':
    'a chunky rounded cream tuning fork standing upright on its handle, two thick prongs pointing up, with one small solid mint green music note floating beside its tip',

  /**
   * AI studio. These are the group most at risk of turning into six variations
   * on a robot head, so each one is the physical thing the tool does to the
   * audio rather than a picture of intelligence. No brains, no circuit boards,
   * no glowing edges — those read as stock AI clipart and would break the family
   * the other thirty-nine belong to.
   */
  // The first attempt lost the stroke entirely and came back as a bare
  // microphone, which made it indistinguishable from the acapella extractor. The
  // stroke is described as its own object rather than as a modifier.
  'vocal-remover':
    'a chunky rounded cream studio microphone standing upright, and one thick solid mint green bar lying diagonally straight across the front of it corner to corner like a prohibition slash, the bar clearly in front and overlapping the microphone, two simple solid toy objects only',
  'acapella-extractor':
    'a chunky rounded cream studio microphone standing upright inside a thick rounded mint green spotlight cone shining down onto it, nothing else in frame',
  // Came back pink first time. The palette is repeated inside the subject because
  // the shared style string alone did not hold it.
  'stem-splitter':
    'four thick rounded horizontal slabs stacked in four separate parallel layers with clear gaps of empty space between them, strictly only mint green and deep forest green and warm cream colours, no pink, no purple, no blue, like separated tracks lifted apart',
  // Also came back pink first time, hence the explicit exclusions.
  'audio-transcriber':
    'a single chunky rounded warm cream speech bubble standing upright with three thick solid mint green horizontal bars inside it like lines of text, strictly only cream and mint green colours, no pink, no purple, no blue, one object only',
  'subtitle-generator':
    'a chunky rounded cream rectangular screen standing upright with two thick solid mint green horizontal bars across its lower third, like a caption box on a video frame',
  /**
   * Took three attempts, and both failures are worth recording.
   *
   * "A handheld brush sweeping" came back as a banana on a green plate — a
   * described real-world implement gives the model too much room, and every
   * subject that works in this file is simple solid geometry instead. A stack of
   * bars fixed the shape but landed on a pink podium and read as a near-copy of
   * stem-splitter, which is the exact failure the note above this group warns
   * about. A single wavy ribbon is the one shape no other tool here uses, and the
   * base has to be ruled out by several names because "no base" alone does not
   * take.
   */
  'noise-remover':
    'one single chunky rounded warm cream wavy ribbon lying flat and horizontal like a smooth clean sound wave, with three small solid mint green rounded specks drifting up and away from its right end, strictly only mint green and deep forest green and warm cream colours, absolutely no pink, no purple, no blue, the object floats freely with nothing underneath it, no plate, no disc, no podium, no pedestal, no circular base, no tray, nothing else in frame',
};

const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : Object.keys(SUBJECTS);

async function submit(prompt) {
  const response = await fetch('https://queue.fal.run/fal-ai/flux-pro/v1.1', {
    method: 'POST',
    headers: { Authorization: `Key ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      negative_prompt: NEGATIVE,
      image_size: 'square_hd',
      num_images: 1,
      enable_safety_checker: false,
      safety_tolerance: '5',
    }),
  });
  if (!response.ok) {
    throw new Error(`submit failed ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function poll(statusUrl, responseUrl) {
  // FLUX takes roughly 10-25s per image; check twice a second and give up at
  // three minutes rather than hanging a build.
  for (let i = 0; i < 360; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const res = await fetch(statusUrl, { headers: { Authorization: `Key ${KEY}` } });
    const body = await res.json();
    if (body.status === 'COMPLETED') {
      const out = await fetch(responseUrl, {
        headers: { Authorization: `Key ${KEY}` },
      });
      return out.json();
    }
    if (body.status === 'FAILED' || body.error) {
      throw new Error(`generation failed: ${JSON.stringify(body).slice(0, 300)}`);
    }
  }
  throw new Error('timed out waiting for the image');
}

let made = 0;
for (const slug of targets) {
  const subject = SUBJECTS[slug];
  if (!subject) {
    console.warn(`no subject defined for "${slug}" — skipping`);
    continue;
  }

  const file = join(outDir, `${slug}.png`);
  if (existsSync(file) && !process.env.FORCE) {
    console.log(`· ${slug} already exists (set FORCE=1 to redo)`);
    continue;
  }

  process.stdout.write(`→ ${slug} `);
  try {
    const queued = await submit(`${subject}, ${STYLE}`);
    const result = await poll(queued.status_url, queued.response_url);
    const url = result?.images?.[0]?.url;
    if (!url) throw new Error(`no image in response: ${JSON.stringify(result).slice(0, 200)}`);

    const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
    writeFileSync(file, bytes);
    made += 1;
    console.log(`ok (${Math.round(bytes.length / 1024)} KB)`);
  } catch (error) {
    console.log(`FAILED: ${error.message}`);
  }
}

console.log(`\n${made} icon(s) written to public/icons3d`);
