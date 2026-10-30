import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The page is one HTML file with the data and the code inlined. The bar bundles in public/bars are
// copied beside it and loaded on demand, so the page opens from disk with no server.
// LANDSCAPE_DIR is where the site's deploy publishes this page, relative to the live bar; the link
// back climbs one folder per segment. Unset, the build has no live bar to link to.
const dir = process.env.LANDSCAPE_DIR;
const liveBar = dir ? '../'.repeat(dir.split('/').filter(Boolean).length) : null;

export default defineConfig({
  plugins: [svelte(), viteSingleFile()],
  define: { __LIVE_BAR__: JSON.stringify(liveBar) },
  build: { outDir: '../site', emptyOutDir: true },
});
