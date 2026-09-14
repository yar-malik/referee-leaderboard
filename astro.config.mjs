import { defineConfig } from 'astro/config';

export default defineConfig({
  site: process.env.SITE_URL || 'https://clearandobvious.example',
  trailingSlash: 'always',
});
