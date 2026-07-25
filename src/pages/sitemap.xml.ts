import type { APIRoute } from 'astro';
import { TOOLS } from '../data/tools';
import { SITE } from '../consts';

export const prerender = true;

interface Entry {
  path: string;
  priority: string;
  changefreq: string;
}

/**
 * Hand-built rather than generated from the file tree so priorities reflect
 * what actually matters: the homepage and the tools, then the reference pages
 * that earn links, then the boilerplate.
 */
const entries: Entry[] = [
  { path: '/', priority: '1.0', changefreq: 'weekly' },
  ...TOOLS.map((tool) => ({
    path: `/${tool.slug}`,
    priority: '0.9',
    changefreq: 'monthly',
  })),
  { path: '/loudness-targets', priority: '0.7', changefreq: 'monthly' },
  { path: '/audio-formats', priority: '0.7', changefreq: 'monthly' },
  { path: '/about', priority: '0.4', changefreq: 'yearly' },
  { path: '/privacy', priority: '0.3', changefreq: 'yearly' },
];

export const GET: APIRoute = () => {
  const lastmod = new Date().toISOString().slice(0, 10);

  const urls = entries
    .map((entry) => {
      const slug =
        entry.path === '/' ? 'home' : entry.path.replace(/^\//, '');
      const card = new URL(`/og/${slug}.png`, SITE.url).href;
      return `  <url>
    <loc>${new URL(entry.path, SITE.url).href}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${entry.changefreq}</changefreq>
    <priority>${entry.priority}</priority>
    <image:image>
      <image:loc>${card}</image:loc>
    </image:image>
  </url>`;
    })
    .join('\n');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls}
</urlset>
`;

  return new Response(body, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
