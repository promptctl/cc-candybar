import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';
import pkg from './package.json' with { type: 'json' };
import { sourceDigest } from './src/source-digest.ts';

const define = {
	__PACKAGE_VERSION__: JSON.stringify(pkg.version),
};

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
// The one module that reads the digest token (see src/build-stamps.d.ts).
const STAMPED_MODULE = path.join(SRC, 'daemon', 'build-currency.ts');

// [LAW:one-source-of-truth] Bake the digest of the source tree being bundled
// into the bundle, so the daemon can ask "was I built from the source beside
// me?" by comparing digests (src/daemon/build-currency.ts) rather than
// mtimes. Computed in buildStart — once per build, so a `--watch` rebuild
// re-stamps — and substituted textually into the one module that names the
// token. A static `define` would be evaluated once per watch session and
// stamp every rebuild with the first build's digest.
function sourceDigestPlugin() {
	let digest = '';
	return {
		name: 'cc-candybar:source-digest',
		buildStart() {
			digest = sourceDigest(SRC);
		},
		transform(code: string, id: string) {
			if (id !== STAMPED_MODULE) return null;
			return code.replaceAll('__SOURCE_DIGEST__', JSON.stringify(digest));
		},
	};
}

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
	plugins: [sourceDigestPlugin()],
});
