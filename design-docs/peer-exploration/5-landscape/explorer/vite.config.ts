import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The page is one HTML file with the data and the code inlined. The bar bundles in public/bars are
// copied beside it and loaded on demand, so the page opens from disk with no server.
export default defineConfig({
  plugins: [svelte(), viteSingleFile()],
  build: { outDir: '../site', emptyOutDir: true },
});
