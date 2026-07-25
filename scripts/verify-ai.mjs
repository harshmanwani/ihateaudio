/**
 * Drives the AI tools in a real browser and measures whether they worked.
 *
 * The distinction this script exists to make: "produced a file" and "separated the
 * audio" are very different claims, and only the second one matters. A broken
 * pipeline still returns a perfectly valid WAV of the right length — it just
 * contains the original mix, or noise, or silence. So this does not check that a
 * download happened; it decodes what came back and measures it against ground
 * truth.
 *
 * Ground truth exists because the fixture is constructed rather than found. The
 * mix is a known instrumental plus known speech, so the correct answer for the
 * vocal remover is a file already on disk, and the quality of the answer is a
 * number in decibels.
 *
 * Scale-invariant SDR is the metric, not plain SDR, because the model applies its
 * own level compensation on the way out and a gain difference is not a separation
 * error. Projecting the estimate onto the reference before measuring removes that
 * confound.
 *
 *   npm run verify:ai
 *   npm run verify:ai -- --only vocal-remover
 */
import { chromium } from 'playwright';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.env.VERIFY_BASE ?? 'http://localhost:4321';
const downloads = mkdtempSync(join(tmpdir(), 'ihateaudio-ai-'));

const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > -1 ? process.argv[onlyArg + 1]?.split(',') : null;

const logPath = process.env.VERIFY_LOG ?? join(downloads, 'verify-ai.log');
const lines = [];
function say(text) {
  lines.push(text);
  process.stdout.write(`${text}\n`);
  // Written as it goes, because a run that hangs is exactly the run whose output
  // you need, and buffering it until exit loses precisely that.
  writeFileSync(logPath, `${lines.join('\n')}\n`);
}

const MIX = join(root, 'tests', 'fixtures', 'ai-mix.wav');
const TRUTH = join(root, 'tests', 'fixtures', 'ai-truth.wav');

if (!existsSync(MIX) || !existsSync(TRUTH)) {
  console.error(
    `Fixtures missing. Expected:\n  ${MIX}\n  ${TRUTH}\n\n` +
      'These are a controlled mix (known instrumental + known speech) and the\n' +
      'matching ground-truth instrumental. Without them there is nothing to\n' +
      'measure against and this script can only check that a file appeared.'
  );
  process.exit(1);
}

/** Minimal WAV reader for 16-bit and 32-bit float PCM. */
function readWav(path) {
  const buf = readFileSync(path);
  if (buf.subarray(0, 4).toString('latin1') !== 'RIFF') {
    throw new Error(`${path} is not a WAV (magic ${buf.subarray(0, 4).toString('hex')})`);
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.subarray(pos, pos + 4).toString('latin1');
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(pos + 8),
        channels: buf.readUInt16LE(pos + 10),
        rate: buf.readUInt32LE(pos + 12),
        bits: buf.readUInt16LE(pos + 22),
      };
    } else if (id === 'data') {
      data = buf.subarray(pos + 8, pos + 8 + size);
    }
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error(`${path}: missing fmt or data chunk`);

  const frames = data.length / (fmt.channels * (fmt.bits / 8));
  const channels = Array.from({ length: fmt.channels }, () => new Float64Array(frames));
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < fmt.channels; c += 1) {
      const at = i * fmt.channels + c;
      if (fmt.bits === 16) channels[c][i] = data.readInt16LE(at * 2) / 32768;
      else if (fmt.bits === 32 && fmt.format === 3) channels[c][i] = data.readFloatLE(at * 4);
      else if (fmt.bits === 32) channels[c][i] = data.readInt32LE(at * 4) / 2147483648;
      else if (fmt.bits === 24) {
        const o = at * 3;
        const v = (data[o] | (data[o + 1] << 8) | (data[o + 2] << 16)) << 8;
        channels[c][i] = v / 2147483648;
      } else throw new Error(`${path}: unsupported ${fmt.bits}-bit format ${fmt.format}`);
    }
  }
  return { channels, rate: fmt.rate, frames };
}

/**
 * Scale-invariant SDR in dB, over as many samples as both signals share.
 *
 * Lengths can differ by a frame or two after resampling, which is not an error
 * worth failing on, so the comparison uses the shorter of the two.
 */
function siSdr(est, ref) {
  const n = Math.min(est[0].length, ref[0].length);
  const channels = Math.min(est.length, ref.length);
  let dot = 0;
  let refEnergy = 0;
  for (let c = 0; c < channels; c += 1) {
    for (let i = 0; i < n; i += 1) {
      dot += est[c][i] * ref[c][i];
      refEnergy += ref[c][i] * ref[c][i];
    }
  }
  const gain = dot / (refEnergy || 1e-30);
  let signal = 0;
  let noise = 0;
  for (let c = 0; c < channels; c += 1) {
    for (let i = 0; i < n; i += 1) {
      const target = gain * ref[c][i];
      signal += target * target;
      const d = est[c][i] - target;
      noise += d * d;
    }
  }
  return 10 * Math.log10(signal / (noise || 1e-30));
}

function rms(channels) {
  let sum = 0;
  let count = 0;
  for (const channel of channels) {
    for (let i = 0; i < channel.length; i += 1) {
      sum += channel[i] * channel[i];
      count += 1;
    }
  }
  return Math.sqrt(sum / (count || 1));
}

/**
 * What each tool must achieve to count as working.
 *
 * `gain` is the improvement in SI-SDR against the ground-truth instrumental that
 * separation has to deliver over the untouched mix. The reference implementation
 * measures about +13 dB on this fixture, so 6 dB is a floor that a working
 * pipeline clears comfortably and a broken one cannot reach at all — returning the
 * input unchanged scores exactly 0.
 */
const PLAN = {
  'vocal-remover': {
    against: 'instrumental',
    gain: 6,
    budget: 420_000,
  },
  /**
   * The acapella extractor is measured against the speech, not the instrumental,
   * and its bar is lower on purpose. It keeps the residual rather than the
   * directly-predicted stem, so every error in the instrumental estimate lands in
   * the vocal — the page says so, and the threshold should agree with the page
   * rather than flatter it. Separating tiled speech from music is also a harder
   * task than the reverse, because the fixture's "vocal" is read aloud rather than
   * sung and the model was trained on singing.
   */
  'acapella-extractor': {
    against: 'vocals',
    gain: 3,
    budget: 420_000,
  },
  /**
   * Drums only. One stem is enough to prove the four-stem path — the model
   * selection, the per-stem transform sizes, the results list — without spending
   * four passes on it, and drums is the stem with no ground truth in this fixture,
   * so it is checked for being real audio that is clearly not the input rather
   * than for SDR against a reference that does not exist.
   */
  'stem-splitter': {
    stems: { drums: true, vocals: false },
    differsFrom: 'mix',
    budget: 420_000,
  },
};

const browser = await chromium.launch();
const truth = readWav(TRUTH);
const mix = readWav(MIX);

/** The fixture was built as instrumental plus speech, so the speech is recoverable. */
const speech = {
  channels: truth.channels.map((channel, c) => {
    const out = new Float64Array(Math.min(channel.length, mix.channels[c].length));
    for (let i = 0; i < out.length; i += 1) out[i] = mix.channels[c][i] - channel[i];
    return out;
  }),
};

const REFERENCES = { instrumental: truth, vocals: speech, mix };

say(`base   ${base}`);
say(
  `mix vs instrumental ${siSdr(mix.channels, truth.channels).toFixed(2)} dB, ` +
    `mix vs speech ${siSdr(mix.channels, speech.channels).toFixed(2)} dB\n`
);

const results = [];

for (const [slug, plan] of Object.entries(PLAN)) {
  if (only && !only.includes(slug)) continue;

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();

  /**
   * Console errors that are the dev server's rather than the product's.
   *
   * "Outdated Optimize Dep" is Vite invalidating its own pre-bundle cache after a
   * dependency changes, and it aborts a request for the Astro dev toolbar. It has
   * nothing to do with the tool and does not exist in a built site, but it was
   * enough to fail a run whose separation had already succeeded — which is exactly
   * the sort of false negative that teaches people to ignore their own checks.
   *
   * The Cloudflare entries are the same problem from the other direction. Against
   * production, the edge injects its Web Analytics beacon and its JavaScript
   * Detections shim into our HTML, and our CSP has no 'unsafe-inline' and does not
   * list static.cloudflareinsights.com, so the browser blocks both and logs a
   * violation on every page. Those are real problems — they are in the notes for the
   * dashboard — but they are Cloudflare's injections rather than our code, and they
   * were failing three tools whose separation had already been measured and passed.
   */
  const IGNORE =
    /favicon|service ?worker|Outdated Optimize Dep|dev-toolbar|astro\/runtime|cloudflareinsights|beacon\.min\.js|Executing inline script violates/i;

  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !IGNORE.test(m.text())) problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  const started = Date.now();
  try {
    await page.goto(`${base}/${slug}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-file-input]').setInputFiles(MIX);
    await page.waitForSelector('[data-workspace]:not([hidden])', { timeout: 60_000 });

    const decodeError = page.locator('.note--error');
    if (await decodeError.count()) {
      throw new Error(`decode failed: ${(await decodeError.innerText()).slice(0, 160)}`);
    }

    // Stem selection, where the tool has it.
    for (const [key, on] of Object.entries(plan.stems ?? {})) {
      const box = page.locator(`[data-control="${key}"]`);
      if (await box.count()) await box.setChecked(on);
    }

    // WAV out, so the measurement is of separation rather than of an MP3 encoder.
    await page.selectOption('[data-format]', 'wav').catch(() => {});

    /**
     * Multi-output tools do not download anything when the export button is
     * pressed. They encode each part into a results list with its own button, so
     * waiting for a download event here waits forever — which is precisely how the
     * stem splitter appeared to hang for seven minutes while working correctly.
     */
    const many = Boolean(plan.stems);

    const wait = many ? null : page.waitForEvent('download', { timeout: plan.budget });
    await page.locator('[data-download]').first().click();

    // The model download and the inference both happen after this click, so the
    // progress panel is the only sign of life for minutes. Surface it, so a hang
    // is distinguishable from slow arithmetic.
    const ticker = setInterval(async () => {
      const phase = await page
        .locator('[data-ai-phase]')
        .innerText()
        .catch(() => '');
      const count = await page
        .locator('[data-ai-count]')
        .innerText()
        .catch(() => '');
      if (phase) process.stdout.write(`   … ${phase} ${count}\r`);
    }, 3000);

    let download;
    try {
      if (many) {
        // Each finished part becomes a row with its own button. Wait for the first
        // to exist, then take it.
        await page.waitForSelector('.result', { timeout: plan.budget });
        const rowDownload = page.waitForEvent('download', { timeout: 60_000 });
        await page.locator('.result button').first().click();
        download = await rowDownload;
      } else {
        download = await wait;
      }
    } finally {
      clearInterval(ticker);
    }

    const path = join(downloads, `${slug}-${download.suggestedFilename()}`);
    await download.saveAs(path);

    const got = readWav(path);
    if (got.frames < truth.frames * 0.8) {
      throw new Error(`output is ${got.frames} frames, expected about ${truth.frames}`);
    }

    const level = rms(got.channels);
    if (level < 1e-4) {
      throw new Error(`output is effectively silent (rms ${level.toExponential(2)})`);
    }

    let note;

    if (plan.against) {
      const reference = REFERENCES[plan.against];
      const baseline = siSdr(mix.channels, reference.channels);
      const score = siSdr(got.channels, reference.channels);
      const gain = score - baseline;

      if (gain < plan.gain) {
        throw new Error(
          `separation gained only ${gain.toFixed(2)} dB against the ${plan.against} ` +
            `(${baseline.toFixed(2)} -> ${score.toFixed(2)}), needed ${plan.gain} dB. ` +
            'The pipeline produced audio but did not separate it.'
        );
      }
      note =
        `vs ${plan.against}: ${baseline.toFixed(2)} -> ${score.toFixed(2)} dB ` +
        `(+${gain.toFixed(2)})`;
    } else {
      /**
       * No ground truth for this stem, so the check is that the output is real
       * audio which is clearly not simply the input handed back. A pipeline that
       * silently passes its input through is the failure this catches, and it
       * would score enormously here while separating nothing.
       */
      const against = REFERENCES[plan.differsFrom ?? 'mix'];
      const similarity = siSdr(got.channels, against.channels);
      if (similarity > 12) {
        throw new Error(
          `output is ${similarity.toFixed(2)} dB similar to the ${plan.differsFrom}, ` +
            'which means it was passed through rather than separated.'
        );
      }
      note = `differs from ${plan.differsFrom} by design (similarity ${similarity.toFixed(2)} dB)`;
    }

    if (problems.length) throw new Error(`console: ${problems[0].slice(0, 160)}`);

    const ms = Date.now() - started;
    results.push({ slug, ok: true, ms });
    say(`ok  ${slug.padEnd(20)} ${note}, rms ${level.toFixed(4)}, ${(ms / 1000).toFixed(0)}s`);
  } catch (error) {
    results.push({ slug, ok: false, note: String(error.message ?? error) });
    say(`FAIL ${slug.padEnd(20)} ${String(error.message ?? error).slice(0, 300)}`);
  } finally {
    await context.close();
  }
}

await browser.close();

const failed = results.filter((r) => r.ok === false);
say(`\n${results.length - failed.length} of ${results.length} passed`);
say(`log: ${logPath}`);
if (failed.length) process.exit(1);
