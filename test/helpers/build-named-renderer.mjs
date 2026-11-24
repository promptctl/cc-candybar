import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../../package.json" with { type: "json" };

const root = fileURLToPath(new URL("../..", import.meta.url));
const sessionSource = path.join(root, "src/renderer/session-source.ts");
const alternate = path.join(root, "test/fixtures/named-renderer-payload.ts");
const [, , outfile] = process.argv;
if (outfile === undefined) throw new Error("expected a named renderer output file");

// [LAW:locality-or-seam] Replace one source import while building the regular
// executable entry, so the fixture runs the real renderer and frames client.
await build({
  entryPoints: [path.join(root, "src/index.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: 'import { createRequire as requireFrom } from "node:module"; const require = requireFrom(import.meta.url);',
  },
  define: { __PACKAGE_VERSION__: JSON.stringify(pkg.version) },
  plugins: [{
    name: "named-renderer-payload",
    setup(builder) {
      builder.onResolve({ filter: /^\.\/render-payload\.js$/ }, ({ importer }) =>
        importer === sessionSource ? { path: alternate } : undefined,
      );
    },
  }],
});
