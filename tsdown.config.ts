import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsdown';
import { portableRenderer } from './scripts/lib/portable-renderer.ts';
import { mayImport, mayLoadRendererModule, zoneOf } from './scripts/import-zones.mjs';
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

export default defineConfig([{
	entry: ['src/index.ts'],
	format: 'esm',
	target: 'node18',
	platform: 'node',
	// A checkout can be serving the last build. The renderer publisher collects superseded modules.
	clean: false,
	minify: true,
	nodeProtocol: true,
	// Bundle all npm deps (rich-js etc.) into the output so the standalone
	// URL handler copy can run without node_modules.
	noExternal: [/./],
	define,
	plugins: [sourceDigestPlugin(), portableRenderer(ROOT), {
		name: 'cc-candybar:renderer-boundary',
		// [LAW:effects-at-boundaries] Only the renderer's graph is bounded in
		// this shared CLI bundle. Follow packages and dynamic imports as well.
		generateBundle() {
			const entry = path.join(SRC, 'renderer-process.ts');
			if (!this.getModuleInfo(entry)) {
				this.error('Cannot check the renderer boundary: renderer entry is missing');
			}
			const paths = new Map([[entry, [path.relative(ROOT, entry)]]]);
			for (const [module, chain] of paths) {
				const info = this.getModuleInfo(module);
				if (!info) {
					this.error(`Cannot check renderer import chain ${chain.join(' -> ')}: module information is missing`);
				}
				for (const id of [...info.importedIds, ...info.dynamicallyImportedIds]) {
					const label = path.isAbsolute(id) ? path.relative(ROOT, id) : id;
					const next = [...chain, label];
					if (!mayLoadRendererModule(id, module === entry)) {
						const facility = /^(?:node:)?fs(?:\/|$)/.test(id) ? 'the filesystem' : id.replace(/^node:/, '');
						this.error(`Renderer imports ${facility} through ${next.join(' -> ')}`);
					}
					if (paths.has(id)) continue;
					const projectModule = id.startsWith(ROOT + path.sep) && !label.split(path.sep).includes('node_modules');
					if (projectModule && !mayImport('renderer-process', zoneOf(label))) {
						this.error(`Renderer imports a host module through ${next.join(' -> ')}`);
					}
					paths.set(id, next);
				}
			}
		},
	}],
	// The attach launcher lane B restarts Claude Code under
	// (scripts/vendor-cc-extra.mjs), beside the bundle that runs it: an
	// install stages dist/cc-extra with dist/index.mjs.
	copy: [
        { from: 'vendor/cc-extra', to: 'dist', flatten: false },
        { from: ['resources/bar-window/*', 'scripts/bar-web/rich-powerline.woff2', 'scripts/bar-web/FONT-LICENSE'], to: 'dist/bar-window' },
    ],
}, {
	// The preload `BUN_OPTIONS='--preload <dist>/attach-preload.cjs' claude`
	// runs inside Claude Code to start it under that launcher
	// (src/attach-preload.ts). Its own build, so nothing it shares with the
	// bundle above is split into a chunk the install would not stage. Bun runs
	// it, so `bun:ffi` is Bun's, never bundled.
	entry: { 'attach-preload': 'src/attach-preload-exec.ts' },
	format: 'cjs',
	target: 'node18',
	platform: 'node',
	clean: false,
	minify: true,
	nodeProtocol: true,
	external: ['bun:ffi'],
	outExtensions: () => ({ js: '.cjs' }),
}]);
