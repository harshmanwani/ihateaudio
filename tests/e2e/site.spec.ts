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

    const links = page.locator('[data-meganav] a');
    await expect(links).toHaveCount(TOOLS.length);
    await expect(
      page.locator('[data-meganav] a[href="/slowed-reverb"]')
    ).toBeVisible();

    // Escape closes it and nothing is left covering the page.
    await page.keyboard.press('Escape');
    await expect(page.locator('.meganav__panel')).toBeHidden();
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
