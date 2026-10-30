import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The page is one HTML file with the data and the code inlined. The bar bundles in public/bars are
// copied beside it and loaded on demand, so the page opens from disk with no server.
// LANDSCAPE_DIR is where the site's deploy publishes this page, relative to the live bar; the link
// back climbs one folder per segment. Unset, the build has no live bar to link to.
// [LAW:no-silent-failure] a path that is not plain folders would climb to the wrong place.
const dir = process.env.LANDSCAPE_DIR;
if (dir !== undefined && !/^[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(dir))
  throw new Error(`LANDSCAPE_DIR must be folders below the live bar, like "landscape"; got ${JSON.stringify(dir)}`);
const liveBar = dir === undefined ? null : '../'.repeat(dir.split('/').length);

export default defineConfig({
  plugins: [svelte(), viteSingleFile()],
  define: { __LIVE_BAR__: JSON.stringify(liveBar) },
  build: { outDir: '../site', emptyOutDir: true },
});
