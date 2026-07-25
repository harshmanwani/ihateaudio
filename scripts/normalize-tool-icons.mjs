/**
 * Normalizes the generated 3D icons into a consistent set.
 *
 * The generator returns whatever background it feels like (white, light grey,
 * occasionally a whole scene), at 1024px, with the subject floating at an
 * arbitrary size. Icons sitting in a 40px tile chip need the opposite: no
 * background at all, the subject cropped to fill the frame, one size.
 *
 * Runs the pixel work in a headless browser canvas so there is no native image
 * dependency to install.
 *
 *   node scripts/normalize-tool-icons.mjs
 */
import { chromium } from '@playwright/test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'public', 'icons3d');
const OUT_SIZE = 256;

const files = readdirSync(dir).filter((f) => f.endsWith('.png') && !f.includes('.norm.'));
if (files.length === 0) {
  console.error('No icons found. Run generate-tool-icons.mjs first.');
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>');

for (const file of files) {
  const dataUrl =
    'data:image/png;base64,' + readFileSync(join(dir, file)).toString('base64');

  const result = await page.evaluate(
    async ({ src, size }) => {
      const img = new Image();
      img.src = src;
      await img.decode();

      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('no ctx');
      ctx.drawImage(img, 0, 0);

      const image = ctx.getImageData(0, 0, w, h);
      const px = image.data;
      const at = (x, y) => (y * w + x) * 4;

      // Sample the four corners to learn what "background" is for this image,
      // rather than assuming white: some come back light grey.
      const corners = [
        at(2, 2), at(w - 3, 2), at(2, h - 3), at(w - 3, h - 3),
      ].map((i) => [px[i], px[i + 1], px[i + 2]]);
      const bg = [0, 1, 2].map(
        (c) => corners.reduce((s, v) => s + v[c], 0) / corners.length
      );

      // Corners must agree, or this is a scene rather than an isolated object
      // and knocking the background out would eat the subject.
      const spread = Math.max(
        ...corners.map((v) =>
          Math.max(...v.map((c, i) => Math.abs(c - bg[i])))
        )
      );
      if (spread > 26) {
        return { skipped: true, reason: 'background is not uniform' };
      }

      // Flood fill inward from every edge pixel, so a background-coloured area
      // enclosed by the subject (a doughnut hole) is preserved.
      const near = (i, tol) =>
        Math.abs(px[i] - bg[0]) < tol &&
        Math.abs(px[i + 1] - bg[1]) < tol &&
        Math.abs(px[i + 2] - bg[2]) < tol;

      const outside = new Uint8Array(w * h);
      const stack = [];
      for (let x = 0; x < w; x += 1) {
        stack.push([x, 0], [x, h - 1]);
      }
      for (let y = 0; y < h; y += 1) {
        stack.push([0, y], [w - 1, y]);
      }

      const TOL = 22;
      while (stack.length) {
        const [x, y] = stack.pop();
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const flat = y * w + x;
        if (outside[flat]) continue;
        if (!near(at(x, y), TOL)) continue;
        outside[flat] = 1;
        stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
      }

      // Feather the boundary so the cut-out edge is not aliased.
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          const flat = y * w + x;
          const i = flat * 4;
          if (outside[flat]) {
            px[i + 3] = 0;
            continue;
          }
          // Partially transparent where a pixel is close to background and
          // touches a knocked-out neighbour.
          let touches = false;
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (outside[ny * w + nx]) { touches = true; break; }
          }
          if (touches && near(i, 46)) px[i + 3] = 110;
        }
      }
      ctx.putImageData(image, 0, 0);

      // Crop to the subject, with a little breathing room.
      let minX = w, minY = h, maxX = 0, maxY = 0;
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          if (px[(y * w + x) * 4 + 3] > 24) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX <= minX || maxY <= minY) {
        return { skipped: true, reason: 'nothing left after knockout' };
      }

      // Square the crop so nothing is distorted by the final resize.
      const side = Math.max(maxX - minX, maxY - minY);
      const pad = Math.round(side * 0.06);
      const box = side + pad * 2;
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;

      const out = document.createElement('canvas');
      out.width = size;
      out.height = size;
      const octx = out.getContext('2d');
      if (!octx) throw new Error('no out ctx');
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(canvas, cx - box / 2, cy - box / 2, box, box, 0, 0, size, size);

      return { skipped: false, dataUrl: out.toDataURL('image/png') };
    },
    { src: dataUrl, size: OUT_SIZE }
  );

  if (result.skipped) {
    console.log(`!  ${file}: ${result.reason} (left as generated)`);
    continue;
  }

  const bytes = Buffer.from(result.dataUrl.split(',')[1], 'base64');
  writeFileSync(join(dir, file), bytes);
  console.log(`ok ${file} -> ${OUT_SIZE}px transparent (${Math.round(bytes.length / 1024)} KB)`);
}

await browser.close();
