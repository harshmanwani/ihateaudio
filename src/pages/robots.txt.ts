import type { APIRoute } from 'astro';
import { SITE } from '../consts';

export const prerender = true;

export const GET: APIRoute = () => {
  const body = `User-agent: *
Allow: /

# The ffmpeg core is a 31 MB binary with no crawlable content; keeping bots out
# of it saves a great deal of pointless bandwidth on both sides.
Disallow: /ffmpeg/

Sitemap: ${new URL('/sitemap.xml', SITE.url).href}
`;

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
