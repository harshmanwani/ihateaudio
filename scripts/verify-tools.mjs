/**
 * Runs every tool end to end against real audio files and proves the output.
 *
 * Different from the Playwright suite on purpose: that generates synthetic WAV
 * tones in-page, which exercises the code paths but not the messy reality of a
 * real MP3. This drives the actual file input with real files on disk, presses
 * the tool's own button, captures what the browser downloads, and then decodes
 * that download back to confirm it is audio of a plausible length rather than a
 * zero-byte file with the right extension.
 *
 *   npm run dev
 *   node scripts/verify-tools.mjs <file.mp3> [second.mp3] [--only slug,slug]
 */
import { chromium } from '@playwright/test';
import { existsSync, readFileSync, mkdtempSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const onlyIndex = args.indexOf('--only');
const only =
  onlyIndex >= 0 ? args[onlyIndex + 1].split(',').map((s) => s.trim()) : null;
const files = args.filter((a) => a.endsWith('.mp3') || a.endsWith('.wav'));
const base = process.env.BASE ?? 'http://localhost:4321';

if (files.length === 0) {
  console.error('Pass at least one audio file.');
  process.exit(1);
}
for (const file of files) {
  if (!existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(1);
  }
}

const primary = files[0];
const second = files[1] ?? files[0];
const downloads = mkdtempSync(join(tmpdir(), 'ihateaudio-verify-'));

/**
 * Written line by line as the run goes, as well as printed.
 *
 * A run of forty browser sessions takes long enough that it has to be watchable
 * while it happens, and stdout can sit in a pipe buffer for the whole run when
 * this is invoked from a wrapper.
 */
const logPath = process.env.VERIFY_LOG ?? join(downloads, 'verify.log');
writeFileSync(logPath, '');
function say(line) {
  console.log(line);
  appendFileSync(logPath, `${line}\n`);
}

/**
 * How each tool is driven and what counts as success.
 *
 * `kind`:
 *   download  press the export button, expect one file
 *   many      press the button, expect a list of per-part downloads
 *   readout   no export; the page has to show measured numbers
 *   image     the output is a PNG rather than audio
 *   skip      cannot be driven headlessly, with the reason recorded
 */
const PLAN = {
  'audio-trimmer': { kind: 'download' },
  'audio-joiner': { kind: 'download', files: 2 },
  'audio-splitter': { kind: 'many' },
  'silence-remover': { kind: 'download' },
  'fade-in-out': { kind: 'download' },
  'audio-reverser': { kind: 'download' },
  'audio-looper': { kind: 'download' },
  'crossfade-joiner': { kind: 'download', files: 2 },

  'audio-converter': { kind: 'download' },
  'mp3-converter': { kind: 'download' },
  'wav-converter': { kind: 'download' },
  // Tier 2: needs the ffmpeg core, so it gets a much longer budget.
  'm4a-converter': { kind: 'download', slow: true },
  'ogg-converter': { kind: 'download', slow: true },
  'flac-converter': { kind: 'download', slow: true },
  'video-to-audio': { kind: 'download' },
  'audio-compressor': { kind: 'download' },
  // Forced to a rate the source is not already at. The default target is 44.1
  // kHz and these sources are 44.1 kHz, so asserting the default would have
  // passed a converter that copied the file through untouched.
  'sample-rate-converter': {
    kind: 'download',
    set: { rate: 22050 },
    expectRate: 22050,
  },

  'volume-booster': { kind: 'download' },
  'audio-normalizer': { kind: 'download' },
  'bass-booster': { kind: 'download' },
  'dynamic-compressor': { kind: 'download' },
  'stereo-to-mono': { kind: 'download' },

  // These three default to "change nothing", which is right for the product and
  // useless for a test: at the default they only prove the encoder works. Each
  // is driven to a real setting, and where the arithmetic is predictable the
  // output duration is asserted against it.
  'speed-changer': { kind: 'download', set: { speed: 1.5 }, ratio: 1 / 1.5 },
  // Pitch shifting holds the length, so there is nothing to assert but that the
  // stretch path runs and produces audio.
  'pitch-shifter': { kind: 'download', set: { semitones: 4 }, ratio: 1 },
  'tempo-changer': { kind: 'download', set: { tempo: 150 }, ratio: 1 / 1.5 },
  'slowed-reverb': { kind: 'download' },
  'nightcore-maker': { kind: 'download' },
  'voice-changer': { kind: 'download' },

  'reverb-adder': { kind: 'download', nudge: true },
  'echo-adder': { kind: 'download', nudge: true },
  '8d-audio-maker': { kind: 'download', nudge: true },
  // Peak and duration both stay put under EQ on a track already at the ceiling,
  // which the page's own FAQ predicts. So this one is proven the only way left:
  // export twice, flat and boosted, and require the bytes to differ.
  equalizer: { kind: 'download', nudge: true, differsFromDefault: true },
  'stereo-widener': { kind: 'download', nudge: true },

  'ringtone-maker': { kind: 'download', slow: true },
  'android-ringtone-maker': { kind: 'download' },
  'voice-recorder': { kind: 'skip', why: 'needs a live microphone' },
  // Assert on the element that holds the number rather than regexing the page:
  // this page prints the figure and the unit in separate elements, so a pattern
  // wanting "128 BPM" adjacent finds nothing while the tool works perfectly.
  'bpm-detector': {
    kind: 'readout',
    at: '[data-bpm]',
    expect: /^\s*\d{2,3}(\.\d+)?\s*$/,
  },
  'loudness-meter': { kind: 'readout', expect: /-\d+(\.\d+)?\s*LUFS/i },
  'waveform-generator': { kind: 'image' },
};

/**
 * Reads the declared rate and channel count out of a WAV header.
 *
 * Necessary because `decodeAudioData` reports the *AudioContext's* sample rate,
 * not the file's: the browser resamples on decode. Trusting it would have let
 * the sample rate converter pass while doing nothing at all.
 */
function wavFormat(bytes) {
  if (bytes.length < 44) return null;
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF') return null;

  // Walk the chunks rather than assuming fmt is at offset 12: some encoders
  // put a LIST or JUNK chunk first.
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(at, at + 4));
    const size = bytes.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      return {
        channels: bytes.readUInt16LE(at + 10),
        rate: bytes.readUInt32LE(at + 12),
        bits: bytes.readUInt16LE(at + 22),
      };
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

/** Magic bytes, so a renamed text file cannot pass as audio. */
function sniff(bytes) {
  const b = bytes;
  const ascii = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(4, 4) === 'ftyp') return 'mp4';
  if (ascii(0, 3) === 'ID3') return 'mp3';
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return 'mp3';
  if (b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'png';
  return 'unknown';
}

const browser = await chromium.launch({
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
  ],
});

const results = [];

for (const [slug, plan] of Object.entries(PLAN)) {
  if (only && !only.includes(slug)) continue;

  if (plan.kind === 'skip') {
    results.push({ slug, ok: null, note: plan.why });
      say(`—  ${slug.padEnd(24)} skipped: ${plan.why}`);
    continue;
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
    permissions: ['microphone'],
  });
  const page = await context.newPage();

  const problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/favicon|service ?worker/i.test(m.text())) {
      problems.push(m.text());
    }
  });
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

  const budget = plan.slow ? 240_000 : 90_000;
  const started = Date.now();

  try {
    await page.goto(`${base}/${slug}`, { waitUntil: 'domcontentloaded' });

    const input = page.locator('[data-file-input]');
    await input.setInputFiles(plan.files === 2 ? [primary, second] : [primary]);

    await page.waitForSelector('[data-workspace]:not([hidden])', {
      timeout: 60_000,
    });

    // A decode failure renders in the status region rather than throwing.
    const err = page.locator('.note--error');
    if (await err.count()) {
      throw new Error(`decode failed: ${(await err.innerText()).slice(0, 140)}`);
    }

    // Give tool-specific onReady work (analysis, previews) time to settle.
    await page.waitForTimeout(1200);

    // The tool has already decoded the file, so its own readout is the cheapest
    // honest source for the input length.
    const sourceSeconds = await page.evaluate(() => {
      const meta = document.querySelector('[data-time]')?.textContent ?? '';
      const total = meta.split('/')[1] ?? '';
      const parts = total.trim().split(':').map(Number);
      if (parts.length !== 2 || parts.some((n) => Number.isNaN(n))) return 0;
      return parts[0] * 60 + parts[1];
    });

    if (plan.kind === 'readout') {
      const scope = plan.at ?? '[data-workspace]';
      const text = await page.locator(scope).first().innerText();
      if (!plan.expect.test(text)) {
        throw new Error(`no measurement in ${scope}: ${text.slice(0, 160)}`);
      }
      if (/NaN|Infinity|undefined/.test(text)) {
        throw new Error(`bad numbers rendered: ${text.slice(0, 160)}`);
      }
      const found = text.match(plan.expect)?.[0] ?? '';
      results.push({
        slug,
        ok: true,
        note: `measured ${found.replace(/\s+/g, ' ')}`,
        ms: Date.now() - started,
      });
      say(`ok ${slug.padEnd(24)} ${results.at(-1).note}`);
      await context.close();
      continue;
    }

    if (plan.kind === 'image') {
      // The generator renders a preview and offers a PNG download.
      const button = page
        .locator('button:has-text("Download"), [data-download]')
        .first();
      const wait = page.waitForEvent('download', { timeout: budget });
      await button.click();
      const download = await wait;
      const path = join(downloads, `${slug}-${await download.suggestedFilename()}`);
      await download.saveAs(path);
      const bytes = readFileSync(path);
      const type = sniff(bytes);
      if (type !== 'png') throw new Error(`expected a PNG, got ${type}`);
      if (bytes.length < 3000) throw new Error(`PNG is only ${bytes.length} bytes`);
      results.push({
        slug,
        ok: true,
        note: `${type}, ${(bytes.length / 1024).toFixed(0)} KB`,
        ms: Date.now() - started,
      });
      say(`ok ${slug.padEnd(24)} ${results.at(-1).note}`);
      await context.close();
      continue;
    }

    // Baseline export at the untouched defaults, kept to compare against.
    let baseline = null;
    if (plan.differsFromDefault) {
      const wait = page.waitForEvent('download', { timeout: budget });
      await page.locator('[data-download]').click();
      const first = await wait;
      const path = join(downloads, `${slug}-default.bin`);
      await first.saveAs(path);
      baseline = readFileSync(path);
    }

    // Drive the controls this tool needs moved off their neutral defaults.
    if (plan.set) {
      for (const [name, value] of Object.entries(plan.set)) {
        const moved = await page.evaluate(
          ({ name, value }) => {
            const el = document.querySelector(`[data-control="${name}"]`);
            if (!el) return false;
            el.value = String(value);
            // Both events: pages listen for `input` to repaint and `change` to
            // recompute, and which one matters differs per tool.
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          },
          { name, value }
        );
        if (!moved) throw new Error(`no control named "${name}" on the page`);
      }
      // Previews are recomputed asynchronously off a control change.
      await page.waitForTimeout(1500);
    }

    // No specific value to set, but the tool's default does nothing: move its
    // first slider so the effect is actually applied.
    if (plan.nudge) {
      const nudged = await page.evaluate(() => {
        const slider = document.querySelector(
          'input[type="range"][data-control]:not([data-control$="-num"])'
        );
        if (!slider) return null;
        const min = Number(slider.min || 0);
        const max = Number(slider.max || 100);
        slider.value = String(min + (max - min) * 0.75);
        slider.dispatchEvent(new Event('input', { bubbles: true }));
        slider.dispatchEvent(new Event('change', { bubbles: true }));
        return { control: slider.dataset.control, value: slider.value };
      });
      if (!nudged) throw new Error('no slider to move on a tool that needs one');
      await page.waitForTimeout(1500);
    }

    // Audio out. Press the tool's own primary button.
    const action = page.locator('[data-download]');
    await action.waitFor({ state: 'visible', timeout: 20_000 });

    if (plan.kind === 'many') {
      await action.click();
      // Parts are appended one at a time as each finishes encoding, and the
      // progress bar is cleared only after the last one. Counting on the first
      // row appearing races the encoder and reports one part out of four.
      await page.waitForFunction(
        () =>
          document.querySelectorAll('[data-results] .result').length >= 2 &&
          !document.querySelector('.progress'),
        undefined,
        { timeout: budget }
      );
      const parts = await page.locator('[data-results] .result').count();
      if (parts < 2) throw new Error(`expected several parts, got ${parts}`);

      // Prove one of them is real, not just a row in a list.
      const wait = page.waitForEvent('download', { timeout: budget });
      await page.locator('[data-results] .result button').first().click();
      const download = await wait;
      const path = join(downloads, `${slug}-part.bin`);
      await download.saveAs(path);
      const bytes = readFileSync(path);
      const type = sniff(bytes);
      if (type === 'unknown') throw new Error('a part is not recognisable audio');
      if (bytes.length < 2000) throw new Error(`a part is only ${bytes.length} bytes`);

      results.push({
        slug,
        ok: true,
        note: `${parts} parts, first is ${type} ${(bytes.length / 1024).toFixed(0)} KB`,
        ms: Date.now() - started,
      });
      say(`ok ${slug.padEnd(24)} ${results.at(-1).note}`);
      await context.close();
      continue;
    }

    const wait = page.waitForEvent('download', { timeout: budget });
    await action.click();
    const download = await wait;
    const path = join(downloads, `${slug}-${await download.suggestedFilename()}`);
    await download.saveAs(path);

    const bytes = readFileSync(path);
    const type = sniff(bytes);
    if (type === 'unknown') {
      throw new Error(`output is not recognisable audio (${bytes.length} bytes)`);
    }
    if (bytes.length < 4000) {
      throw new Error(`output is suspiciously small: ${bytes.length} bytes`);
    }

    // The real proof: decode the download back and read its duration. A file
    // with valid magic bytes and a broken payload fails here.
    const decoded = await page.evaluate(async (b64) => {
      const bin = atob(b64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const audio = await ctx.decodeAudioData(buf.buffer);
        const out = {
          duration: audio.duration,
          channels: audio.numberOfChannels,
          rate: audio.sampleRate,
          peak: 0,
        };
        const data = audio.getChannelData(0);
        // Sampled rather than scanned: only need to know it is not silence.
        for (let i = 0; i < data.length; i += 97) {
          const v = Math.abs(data[i]);
          if (v > out.peak) out.peak = v;
        }
        await ctx.close();
        return out;
      } catch (error) {
        return { error: String(error).slice(0, 120) };
      }
    }, bytes.toString('base64'));

    if (decoded.error) {
      // Formats the browser cannot decode natively are still valid output.
      if (['flac', 'ogg', 'mp4'].includes(type)) {
        results.push({
          slug,
          ok: true,
          note: `${type}, ${(bytes.length / 1024).toFixed(0)} KB, not natively decodable`,
          ms: Date.now() - started,
        });
        say(`ok ${slug.padEnd(24)} ${results.at(-1).note}`);
        await context.close();
        continue;
      }
      throw new Error(`output will not decode: ${decoded.error}`);
    }

    if (decoded.duration < 0.2) {
      throw new Error(`output is ${decoded.duration.toFixed(3)}s long`);
    }

    // The strongest single assertion available: if a speed change did not
    // happen, the length gives it away.
    if (plan.ratio && sourceSeconds) {
      const want = sourceSeconds * plan.ratio;
      const drift = Math.abs(decoded.duration - want) / want;
      if (drift > 0.06) {
        throw new Error(
          `expected about ${want.toFixed(1)}s at this setting, got ` +
            `${decoded.duration.toFixed(1)}s from a ${sourceSeconds.toFixed(1)}s source`
        );
      }
    }
    if (decoded.peak < 0.0005) {
      throw new Error(`output is silent (peak ${decoded.peak})`);
    }

    if (baseline && baseline.equals(bytes)) {
      throw new Error(
        'moving the control produced a byte-identical file, so the setting is ' +
          'not reaching the export'
      );
    }

    const header = type === 'wav' ? wavFormat(bytes) : null;
    if (plan.expectRate && header && header.rate !== plan.expectRate) {
      throw new Error(
        `expected ${plan.expectRate} Hz in the WAV header, found ${header.rate}`
      );
    }

    results.push({
      slug,
      ok: true,
      note:
        `${type}, ${(bytes.length / 1024).toFixed(0)} KB, ` +
        `${decoded.duration.toFixed(1)}s, ` +
        (header
          ? `${header.channels}ch ${(header.rate / 1000).toFixed(1)}kHz ` +
            `${header.bits}-bit (from the header)`
          : `${decoded.channels}ch, rate not readable without a decoder`) +
        `, peak ${decoded.peak.toFixed(2)}`,
      ms: Date.now() - started,
      warnings: problems,
    });
    say(`ok ${slug.padEnd(24)} ${results.at(-1).note}`);
  } catch (error) {
    results.push({
      slug,
      ok: false,
      note: String(error.message ?? error).slice(0, 220),
      ms: Date.now() - started,
      warnings: problems,
    });
    say(`FAIL ${slug.padEnd(22)} ${results.at(-1).note}`);
  }

  await context.close();
}

await browser.close();

const pass = results.filter((r) => r.ok === true);
const fail = results.filter((r) => r.ok === false);
const skip = results.filter((r) => r.ok === null);

say(`\n${'='.repeat(72)}`);
say(`${pass.length} passed, ${fail.length} failed, ${skip.length} skipped`);

if (fail.length) {
  say('\nFailures:');
  for (const f of fail) {
    say(`  ${f.slug}: ${f.note}`);
    for (const w of f.warnings ?? []) say(`      console: ${w.slice(0, 160)}`);
  }
}

const noisy = pass.filter((r) => (r.warnings ?? []).length > 0);
if (noisy.length) {
  say('\nPassed but logged console errors:');
  for (const n of noisy) {
    say(`  ${n.slug}: ${n.warnings[0].slice(0, 160)}`);
  }
}

say(`\nOutputs kept in ${downloads}`);
process.exit(fail.length ? 1 : 0);
