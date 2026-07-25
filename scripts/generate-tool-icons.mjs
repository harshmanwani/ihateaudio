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
    'one thick rounded green bar sliced into three equal separated blocks with clear gaps between them, arranged in a row',
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
