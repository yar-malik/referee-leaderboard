import { defineConfig } from 'astro/config';

export default defineConfig({
  site: process.env.SITE_URL || 'https://footyvibe.xyz',
  trailingSlash: 'always',
  // In `astro dev`, run `node server/community.mjs` alongside for the fan verdict API; nginx proxies /api in production.
  vite: { server: { proxy: { '/api': 'http://127.0.0.1:4071' } } },
});
