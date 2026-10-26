import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// One HTML file with the data and the code inlined, so the page opens from disk with no server.
export default defineConfig({ plugins: [svelte(), viteSingleFile()] });
