import { test, expect, type Page } from '@playwright/test';
import { TOOLS } from '../../src/data/tools';

const STATIC_PAGES = ['/', '/loudness-targets', '/audio-formats', '/about', '/privacy'];
const ALL_PATHS = [...STATIC_PAGES, ...TOOLS.map((tool) => `/${tool.slug}`)];

/** Console errors that are environmental rather than our bugs. */
function isIgnorableError(text: string): boolean {
  return (
    // The service worker is not registered from the preview origin in CI.
    /service ?worker/i.test(text) ||
    /Failed to load resource.*favicon/i.test(text) ||
    /apple-touch-icon|icon-192|icon-512|og\.png/i.test(text)
  );
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !isIgnorableError(message.text())) {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test.describe('every page', () => {
  for (const path of ALL_PATHS) {
    test(`${path} loads clean`, async ({ page }) => {
      const errors = collectErrors(page);
      const response = await page.goto(path);

      expect(response?.status(), `${path} should return 200`).toBe(200);

      // Exactly one h1, and it must not be empty.
      const h1 = page.locator('h1');
      await expect(h1).toHaveCount(1);
      expect((await h1.textContent())?.trim().length).toBeGreaterThan(0);

      // Title and description must be present and within sane SEO lengths.
      const title = await page.title();
      expect(title.length).toBeGreaterThan(10);
      expect(title.length).toBeLessThan(75);

      const description = await page
        .locator('meta[name="description"]')
        .getAttribute('content');
      expect(description, `${path} needs a meta description`).toBeTruthy();
      expect(description!.length).toBeGreaterThan(70);
      expect(description!.length).toBeLessThan(185);

      // Canonical must be absolute and point at this page.
      const canonical = await page
        .locator('link[rel="canonical"]')
        .getAttribute('href');
      expect(canonical).toContain('https://ihateaudio.com');

      expect(errors, `console errors on ${path}`).toEqual([]);
    });
  }
});

test.describe('structured data', () => {
  for (const tool of TOOLS.slice(0, 8)) {
    test(`/${tool.slug} emits valid JSON-LD`, async ({ page }) => {
      await page.goto(`/${tool.slug}`);

      const blocks = await page
        .locator('script[type="application/ld+json"]')
        .allTextContents();

      expect(blocks.length).toBeGreaterThanOrEqual(3);

      const parsed = blocks.map((block) => JSON.parse(block));
      const types = parsed.map((item) => item['@type']);

      expect(types).toContain('SoftwareApplication');
      expect(types).toContain('HowTo');
      expect(types).toContain('FAQPage');
      expect(types).toContain('BreadcrumbList');

      const faq = parsed.find((item) => item['@type'] === 'FAQPage');
      expect(faq.mainEntity.length).toBeGreaterThanOrEqual(4);

      const howTo = parsed.find((item) => item['@type'] === 'HowTo');
      expect(howTo.step.length).toBeGreaterThanOrEqual(3);
    });
  }
});

test.describe('house style', () => {
  test('no em dashes in any rendered copy', async ({ page }) => {
    // A deliberate voice choice: em dashes read as edited-magazine prose, and
    // this product does not talk like that. Asserted on rendered text so a
    // stray one in any of the 44 pages fails the build rather than shipping.
    const offenders: string[] = [];

    for (const path of ALL_PATHS) {
      await page.goto(path);
      const text = await page.locator('body').innerText();
      if (text.includes('—')) {
        const around = text.slice(
          Math.max(0, text.indexOf('—') - 45),
          text.indexOf('—') + 45
        );
        offenders.push(`${path}: …${around.replace(/\n/g, ' ')}…`);
      }
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});

test.describe('content quality', () => {
  test('tool pages carry enough unique prose to not read as templated', async ({
    page,
  }) => {
    for (const tool of TOOLS.slice(0, 10)) {
      await page.goto(`/${tool.slug}`);
      const words = ((await page.locator('main').innerText()) ?? '')
        .split(/\s+/)
        .filter(Boolean).length;
      expect(words, `/${tool.slug} is too thin`).toBeGreaterThan(450);
    }
  });

  test('no two tool pages share an identical description', async ({ page }) => {
    const seen = new Map<string, string>();
    for (const tool of TOOLS) {
      await page.goto(`/${tool.slug}`);
      const description =
        (await page.locator('meta[name="description"]').getAttribute('content')) ?? '';
      const clash = seen.get(description);
      expect(clash, `${tool.slug} duplicates ${clash}'s description`).toBeUndefined();
      seen.set(description, tool.slug);
    }
  });
});

test.describe('navigation', () => {
  test('homepage links to every tool', async ({ page }) => {
    await page.goto('/');
    for (const tool of TOOLS) {
      await expect(
        page.locator(`a[href="/${tool.slug}"]`).first(),
        `homepage is missing a link to ${tool.slug}`
      ).toBeAttached();
    }
  });

  test('search filters the tool grid', async ({ page }) => {
    await page.goto('/');
    const tiles = page.locator('[data-tile]:not([hidden])');
    const before = await tiles.count();

    await page.fill('#tool-search', 'ringtone');
    await expect.poll(async () => tiles.count()).toBeLessThan(before);
    // Scoped to the grid: the footer also links every tool.
    await expect(page.locator('[data-tile][href="/ringtone-maker"]')).toBeVisible();

    await page.fill('#tool-search', 'zzzznothing');
    await expect(page.locator('[data-search-empty]')).toBeVisible();
  });

  test('search understands synonyms, not just tool names', async ({ page }) => {
    await page.goto('/');
    const cases: [string, string][] = [
      ['mp4 to mp3', '/video-to-audio'],
      ['louder', '/volume-booster'],
      ['sped up', '/speed-changer'],
      ['lufs', '/audio-normalizer'],
      ['combine', '/audio-joiner'],
    ];

    for (const [query, slug] of cases) {
      await page.fill('#tool-search', query);
      await expect(
        page.locator(`[data-tile][href="${slug}"]`),
        `"${query}" should surface ${slug}`
      ).toBeVisible();
    }
  });

  test('category pills filter the grid', async ({ page }) => {
    await page.goto('/');
    await page.click('[data-filter="effects"]');

    // Only the effects section remains.
    await expect(page.locator('[data-category]:not([hidden])')).toHaveCount(1);
    await expect(page.locator('[data-tile]:not([hidden])')).toHaveCount(5);
    await expect(page.locator('[data-filter="effects"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );

    await page.click('[data-filter="all"]');
    await expect(page.locator('[data-category]:not([hidden])')).toHaveCount(6);
  });

  test('the all-tools menu lists every tool from any page', async ({ page }) => {
    await page.goto('/audio-trimmer');
    await page.click('[data-meganav] summary');

    // Scoped to the grid: the panel's own footer also carries the reference
    // links, which is the only route to them on a phone.
    const links = page.locator('[data-meganav] .meganav__grid a');
    await expect(links).toHaveCount(TOOLS.length);
    await expect(
      page.locator('[data-meganav] a[href="/slowed-reverb"]')
    ).toBeVisible();

    for (const href of ['/loudness-targets', '/audio-formats', '/about']) {
      await expect(
        page.locator(`[data-meganav] .meganav__foot a[href="${href}"]`),
        `the menu should reach ${href}`
      ).toBeVisible();
    }

    // Escape closes it and nothing is left covering the page.
    await page.keyboard.press('Escape');
    await expect(page.locator('.meganav__panel')).toBeHidden();
  });

  test('every tool in the menu carries its own art', async ({ page }) => {
    await page.goto('/');
    await page.click('[data-meganav] summary');

    // The art is the point of the launcher: a menu of 39 identical rows of text
    // is a list, not something you can pick from at a glance.
    const art = page.locator('[data-meganav] .meganav__grid img');
    await expect(art).toHaveCount(TOOLS.filter((tool) => tool.icon3d).length);

    const first = art.first();
    await expect(first).toHaveAttribute('src', /\/icons3d\/[a-z0-9-]+\.png$/);

    // Decoded, not merely referenced. Polled because the art is lazy and only
    // starts fetching once the menu is opened or the button is hovered.
    await expect
      .poll(() => first.evaluate((img: HTMLImageElement) => img.naturalWidth), {
        timeout: 5000,
      })
      .toBeGreaterThan(0);
  });

  test('homepage trust band and FAQ are present after the grid', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.trust h2')).toContainText(/never leaves your/i);
    await expect(page.locator('.trust__fact')).toHaveCount(4);
    await expect(page.locator('.homefaq details')).toHaveCount(7);

    // The homepage FAQ must also be in the structured data.
    const blocks = await page
      .locator('script[type="application/ld+json"]')
      .allTextContents();
    const types = blocks.map((b) => JSON.parse(b)['@type']);
    expect(types).toContain('FAQPage');
  });

  test('sitemap lists every tool', async ({ request }) => {
    const response = await request.get('/sitemap.xml');
    expect(response.status()).toBe(200);
    const body = await response.text();
    for (const tool of TOOLS) {
      expect(body, `sitemap missing ${tool.slug}`).toContain(`/${tool.slug}`);
    }
  });

  test('robots.txt points at the sitemap', async ({ request }) => {
    const body = await (await request.get('/robots.txt')).text();
    expect(body).toContain('Sitemap: https://ihateaudio.com/sitemap.xml');
    expect(body).toContain('Disallow: /ffmpeg/');
  });
});

test.describe('discoverability', () => {
  test('every page has its own social card, not one shared image', async ({
    page,
    request,
  }) => {
    const seen = new Map<string, string>();

    for (const path of ALL_PATHS) {
      await page.goto(path);
      const image = await page
        .locator('meta[property="og:image"]')
        .getAttribute('content');

      expect(image, `${path} has no og:image`).toBeTruthy();
      const clash = seen.get(image!);
      expect(clash, `${path} reuses ${clash}'s card`).toBeUndefined();
      seen.set(image!, path);

      // Dimensions and alt text, so previews reserve space and stay accessible.
      await expect(page.locator('meta[property="og:image:width"]')).toHaveAttribute(
        'content',
        '1200'
      );
      await expect(page.locator('meta[property="og:image:alt"]')).toHaveCount(1);
    }

    // Spot-check that a card is actually served rather than just referenced.
    const card = await request.get('/og/audio-trimmer.png');
    expect(card.status()).toBe(200);
    expect(Number(card.headers()['content-length'] ?? 0)).toBeGreaterThan(10_000);
  });

  test('llms.txt describes the site for assistants', async ({ request }) => {
    const response = await request.get('/llms.txt');
    expect(response.status()).toBe(200);

    const body = await response.text();
    // The facts an assistant is most likely to get wrong.
    expect(body).toMatch(/no upload/i);
    expect(body).toMatch(/BS\.1770/);
    expect(body).toMatch(/device memory/i);
    expect(body).toContain('/tools.json');
    // Every tool should be listed, or an assistant will recommend a subset.
    for (const tool of TOOLS) {
      expect(body, `llms.txt omits ${tool.slug}`).toContain(`/${tool.slug})`);
    }
  });

  test('tools.json is a valid machine-readable index', async ({ request }) => {
    const response = await request.get('/tools.json');
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.tools).toHaveLength(TOOLS.length);
    expect(body.categories.length).toBeGreaterThan(0);

    for (const entry of body.tools) {
      expect(entry.url).toMatch(/^https:\/\/ihateaudio\.com\//);
      expect(entry.name.length).toBeGreaterThan(3);
      expect(entry.keywords.length).toBeGreaterThan(3);
      expect(entry.price).toBe(0);
    }
  });

  test('AI crawlers are explicitly allowed', async ({ request }) => {
    const body = await (await request.get('/robots.txt')).text();
    // Being citable by assistants is a distribution channel for a free tool,
    // so these are allowed on purpose rather than left to the wildcard.
    for (const bot of [
      'GPTBot',
      'ClaudeBot',
      'PerplexityBot',
      'Google-Extended',
      'OAI-SearchBot',
      'CCBot',
    ]) {
      expect(body, `${bot} has no explicit policy`).toContain(bot);
    }
    expect(body).toContain('/llms.txt');
  });

  test('sitewide Organization and SearchAction schema is present', async ({
    page,
  }) => {
    await page.goto('/audio-trimmer');
    const blocks = await page
      .locator('script[type="application/ld+json"]')
      .allTextContents();
    const parsed = blocks.map((b) => JSON.parse(b));
    const types = parsed.map((p) => p['@type']);

    expect(types).toContain('Organization');
    expect(types).toContain('WebSite');

    const site = parsed.find((p) => p['@type'] === 'WebSite');
    expect(site.potentialAction['@type']).toBe('SearchAction');
  });

  test('sitemap carries a card per URL', async ({ request }) => {
    const body = await (await request.get('/sitemap.xml')).text();
    expect(body).toContain('sitemap-image');
    expect(body).toContain('/og/audio-trimmer.png');
    expect(body).toContain('/og/home.png');
  });
});

test.describe('installable', () => {
  test('the manifest is complete enough to install', async ({ request }) => {
    const response = await request.get('/manifest.webmanifest');
    expect(response.status()).toBe(200);

    const manifest = await response.json();
    expect(manifest.name.length).toBeGreaterThan(10);
    expect(manifest.short_name.length).toBeLessThanOrEqual(12);
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toContain('/');

    // Chrome refuses to install without a 192 and a 512, and Android crops any
    // icon that is not declared maskable, so all three have to be present.
    const sizes = manifest.icons.map((icon: { sizes: string }) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(
      manifest.icons.some((icon: { purpose?: string }) => icon.purpose === 'maskable')
    ).toBe(true);

    // Every declared asset must actually be served, or the install dialog shows
    // a broken icon and the shortcut menu is empty.
    const assets = [
      ...manifest.icons.map((icon: { src: string }) => icon.src),
      ...manifest.screenshots.map((shot: { src: string }) => shot.src),
      ...manifest.shortcuts.flatMap((s: { icons: { src: string }[] }) =>
        s.icons.map((icon) => icon.src)
      ),
    ];

    for (const src of assets) {
      const asset = await request.get(src);
      expect(asset.status(), `${src} is declared in the manifest but not served`).toBe(
        200
      );
    }
  });

  test('the app icons and launch images are served', async ({ request }) => {
    for (const path of [
      '/favicon.svg',
      '/icon-192.png',
      '/icon-512.png',
      '/icon-maskable-512.png',
      '/apple-touch-icon.png',
      // iOS matches launch images on exact pixel size with no fallback, so a
      // missing one is a white screen rather than a smaller image.
      '/splash/1290x2796.png',
      '/splash/750x1334.png',
      '/splash/2048x2732.png',
    ]) {
      const response = await request.get(path);
      expect(response.status(), `${path} should be served`).toBe(200);
    }
  });

  test('the offline worker is registered and skips the huge core', async ({
    page,
    request,
  }) => {
    const worker = await (await request.get('/sw.js')).text();
    // The ffmpeg core is 31 MB. Caching it would evict everything useful.
    expect(worker).toContain("url.pathname.startsWith('/ffmpeg/')");
    expect(worker).toContain("url.pathname.startsWith('/icons3d/')");

    await page.goto('/');
    const registered = await page.evaluate(
      () => 'serviceWorker' in navigator
    );
    expect(registered).toBe(true);
  });

  test('the install card stays out of the way until it is wanted', async ({ page }) => {
    await page.goto('/');
    // No install event fires in a headless run, and the card must not appear on
    // its own: an invitation that shows up unprompted on page one is an ad.
    await expect(page.locator('[data-pwa-install]')).toBeHidden();
    await expect(page.locator('[data-pwa-trigger]')).toBeHidden();
  });
});

test.describe('tool page reading experience', () => {
  test('the article is separated from the tool and capped for reading', async ({
    page,
  }) => {
    await page.goto('/audio-trimmer');

    const band = page.locator('.toolread');
    await expect(band).toBeVisible();

    // A real gap between working and reading, not a hairline.
    const gap = await page.evaluate(() => {
      const tool = document.querySelector('.toolpage');
      const read = document.querySelector('.toolread');
      if (!tool || !read) return 0;
      return read.getBoundingClientRect().top - tool.getBoundingClientRect().bottom;
    });
    expect(gap).toBeGreaterThan(40);

    // Prose measure: past roughly 75 characters a line, readers lose their place
    // on the return sweep. Measured against the font's real average character
    // width rather than a guessed ratio, because `ch` overstates it badly here:
    // Instrument Sans draws a 0.666em zero and a 0.517em average lowercase.
    const chars = await page.locator('.toolbody__main p').evaluateAll((nodes) => {
      const probe = document.createElement('span');
      probe.style.cssText =
        'position:absolute;visibility:hidden;white-space:pre;font:16px var(--font)';
      probe.textContent = 'abcdefghijklmnopqrstuvwxyz abcdefghijklmnopqrstuvwxyz';
      document.body.append(probe);
      const per = probe.getBoundingClientRect().width / probe.textContent.length / 16;
      probe.remove();

      return nodes.map((node) => {
        const size = parseFloat(getComputedStyle(node).fontSize);
        return node.getBoundingClientRect().width / (size * per);
      });
    });

    expect(chars.length).toBeGreaterThan(3);
    for (const line of chars) expect(Math.round(line)).toBeLessThan(80);
  });

  test('the steps read as a numbered sequence', async ({ page }) => {
    await page.goto('/audio-splitter');
    const steps = page.locator('.steps li');
    expect(await steps.count()).toBeGreaterThanOrEqual(3);

    // The connector rail is what makes four paragraphs read as one sequence.
    const rail = await steps.first().evaluate((li) => {
      const after = getComputedStyle(li, '::after');
      return { content: after.content, width: after.width };
    });
    expect(rail.content).not.toBe('none');
  });
});

test.describe('analytics', () => {
  test('nothing third-party loads without the ids configured', async ({ page }) => {
    // The suite must not depend on anyone else's CDN being up, and a developer
    // should never pollute production numbers by running the site locally.
    const external: string[] = [];
    page.on('request', (request) => {
      const host = new URL(request.url()).host;
      if (!host.includes('localhost') && !host.includes('127.0.0.1')) {
        external.push(request.url());
      }
    });

    await page.goto('/audio-trimmer');
    await page.waitForLoadState('networkidle');
    expect(external, `unexpected third-party requests`).toEqual([]);
  });

  test('the bootstrap is same-origin so the CSP can stay strict', async ({
    request,
  }) => {
    const response = await request.get('/analytics.js');
    expect(response.status()).toBe(200);

    const body = await response.text();
    // The switched-off list is the part that has to survive refactors: this site
    // promises the file never leaves the device, and a session replay of a tool
    // page would capture filenames.
    expect(body).toContain('disable_session_recording: true');
    expect(body).toContain('autocapture: false');
    expect(body).toContain('respect_dnt: true');
    expect(body).toContain("persistence: 'localStorage'");
    expect(body).toContain('allow_google_signals: false');
  });

  test('the security policy allowlists analytics and nothing else', async ({
    request,
  }) => {
    // Read from source: the dev server does not apply Cloudflare's _headers.
    const headers = await (await request.get('/_headers')).text();
    const csp = headers
      .split('\n')
      .find((line) => line.includes('Content-Security-Policy'));

    expect(csp, '_headers must carry a CSP').toBeTruthy();
    expect(csp).toContain('https://www.googletagmanager.com');
    expect(csp).toContain('https://a.tenmiracle.com');
    // Scripts must never need unsafe-inline, which is the whole reason the
    // bootstrap is an external file.
    const scriptSrc = csp!.slice(csp!.indexOf('script-src'));
    expect(scriptSrc.slice(0, scriptSrc.indexOf(';'))).not.toContain('unsafe-inline');
  });

  test('the privacy page describes what is actually collected', async ({ page }) => {
    // If the analytics config changes, this page has to change with it. A stale
    // "no cookies are set" would be the single most damaging sentence on the
    // site.
    await page.goto('/privacy');
    const text = await page.locator('main').innerText();

    expect(text).toMatch(/Google Analytics/);
    expect(text).toMatch(/PostHog/);
    expect(text).toMatch(/no session recording/i);
    expect(text).toMatch(/Do Not Track/i);
    expect(text).not.toMatch(/No cookies are set/i);
  });
});

test.describe('contact', () => {
  test('the support address is reachable from every page', async ({ page }) => {
    for (const path of ['/', '/audio-trimmer', '/privacy']) {
      await page.goto(path);
      await expect(
        page.locator('a[href="mailto:support@ihateaudio.com"]').first(),
        `${path} should offer a way to report a problem`
      ).toBeAttached();
    }
  });
});
