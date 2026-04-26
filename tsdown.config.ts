import { defineConfig } from 'tsdown';
import pkg from './package.json' with { type: 'json' };

const define = {
	__PACKAGE_VERSION__: JSON.stringify(pkg.version),
};

export default defineConfig([
	{
		entry: ['src/index.ts'],
		format: 'esm',
		target: 'node18',
		platform: 'node',
		clean: true,
		minify: true,
		nodeProtocol: true,
		define,
	},
	{
		entry: ['src/browser.ts'],
		format: 'esm',
		target: 'es2022',
		platform: 'browser',
		clean: false,
		minify: true,
		dts: true,
		deps: { neverBundle: [/^node:/] },
		define,
	},
]);
