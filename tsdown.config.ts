import { defineConfig } from 'tsdown';
import pkg from './package.json' with { type: 'json' };

const define = {
	__PACKAGE_VERSION__: JSON.stringify(pkg.version),
};

// [LAW:one-source-of-truth] Single build artifact — the Node bundle the
// daemon and CLI both ship as `dist/index.mjs`. The browser-target output
// was the entry point for the deleted `src/browser.ts` library surface
// (bzh.2 retired it alongside the legacy renderer; there is no longer a
// public TypeScript API beyond the CLI).
export default defineConfig({
	entry: ['src/index.ts'],
	format: 'esm',
	target: 'node18',
	platform: 'node',
	clean: true,
	minify: true,
	nodeProtocol: true,
	// Bundle all npm deps (rich-js etc.) into the output so the standalone
	// URL handler copy can run without node_modules.
	noExternal: [/./],
	define,
});
