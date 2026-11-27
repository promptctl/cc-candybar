import fs from "node:fs";
import { publishByRename } from "../../src/utils/atomic-write.ts";
import path from "node:path";
import { isBuiltin } from "node:module";
import { build } from "esbuild";
import { checkRendererEnvironment } from "./renderer-environment.ts";
import type { TsdownPlugin } from "tsdown";
import { mayImport, zoneOf } from "../import-zones.mjs";
import {
  RUNTIME_MANIFEST,
  manifestOf,
  obsoleteRendererFiles,
  rendererAssetName,
  rendererDigest,
} from "../../src/install/renderer-asset.ts";

// [LAW:one-source-of-truth] Both modules are shared at the distribution
// boundary. Their source imports keep the same direction in host and peer.
const runtimeModules = {
  "src/renderer/main.ts": "mainRendererOf",
  "src/utils/calendar.ts": "ZonedCalendar",
};

export async function bundleRenderer(root: string) {
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents: Object.entries(runtimeModules)
        .map(([module, name]) => `export { ${name} } from "./${module}";`)
        .join("\n"),
      resolveDir: root,
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    tsconfigRaw: { compilerOptions: { verbatimModuleSyntax: true } },
    // The regular histogram entry carries the repository's pako patch.
    mainFields: ["module", "main"],
    logOverride: {
      "unsupported-dynamic-import": "error",
      "unsupported-require-call": "error",
      "indirect-require": "error",
    },
    outfile: "renderer.mjs",
    sourcemap: "external",
    sourcesContent: false,
    write: false,
    minify: true,
    metafile: true,
    plugins: [
      {
        name: "portable-imports",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, ({ path: specifier }) => {
            if (isBuiltin(specifier) || specifier.startsWith("node:"))
              return {
                errors: [{ text: `Portable renderer imports ${specifier}` }],
              };
            return undefined;
          });
        },
      },
    ],
  });
  const js = result.outputFiles.find((file) =>
    file.path.endsWith("/renderer.mjs"),
  );
  const map = result.outputFiles.find((file) =>
    file.path.endsWith("/renderer.mjs.map"),
  );
  if (!js || !map || result.outputFiles.length !== 2)
    throw new Error(
      "Portable renderer must emit one module and its source map",
    );
  checkRendererEnvironment(js.text, map.text);
  return { ...result, outputFiles: [js] };
}

// [LAW:single-enforcer] Node imports the same closed module a browser loads.
// Esbuild's resolver sees dependencies before tree shaking and diagnoses
// computed loads, including those in packages.
export function portableRenderer(root: string): TsdownPlugin {
  const entries = new Set(
    Object.keys(runtimeModules).map((module) => path.join(root, module)),
  );
  const names = new Set([...entries].map((entry) => path.parse(entry).name));
  let file: string;
  let digest: string;
  let bytes: Uint8Array;
  let previous: string | undefined;
  const dist = path.join(root, "dist");
  return {
    name: "cc-candybar:portable-renderer",
    async buildStart() {
      const result = await bundleRenderer(root);
      for (const input of Object.keys(result.metafile.inputs)) {
        if (input === "<stdin>") continue;
        this.addWatchFile(path.resolve(root, input));
        if (
          input.startsWith("src/") &&
          !mayImport("renderer-process", zoneOf(input))
        )
          this.error(`Portable renderer imports a host module: ${input}`);
      }
      const [output] = result.outputFiles;
      if (
        result.outputFiles.length !== 1 ||
        !output ||
        Object.values(result.metafile.outputs).some(
          (chunk) => chunk.imports.length,
        )
      )
        this.error("Portable renderer must be a single self-contained module");
      digest = rendererDigest(output.contents);
      file = "./" + rendererAssetName(digest);
      bytes = output.contents;
    },
    resolveId: {
      order: "pre",
      async handler(source, importer) {
        if (
          !importer ||
          !source.startsWith(".") ||
          !names.has(path.parse(source).name)
        )
          return null;
        const resolved = await this.resolve(source, importer, {
          skipSelf: true,
        });
        return resolved && entries.has(resolved.id)
          ? { id: file, external: true }
          : null;
      },
    },
    generateBundle(_options, output) {
      // A new consumer or import spelling must not silently bundle a Node copy.
      const cli = output["index.mjs"];
      if (
        [...entries].some((entry) => this.getModuleInfo(entry)) ||
        cli?.type !== "chunk" ||
        !cli.imports.some(
          (specifier) => specifier === file || "./" + specifier === file,
        )
      )
        this.error(
          "The CLI must import the renderer and calendar from its emitted portable module",
        );
      // Publish the immutable import before the bundler exposes its new CLI.
      // A source checkout and an installer both have live readers during upgrades.
      fs.mkdirSync(dist, { recursive: true });
      const manifest = path.join(dist, RUNTIME_MANIFEST);
      previous = fs.existsSync(manifest)
        ? manifestOf(fs.readFileSync(manifest, "utf8"))?.renderer
        : undefined;
      publishByRename(path.join(dist, file), bytes, 0o644);
      this.emitFile({
        type: "asset",
        fileName: RUNTIME_MANIFEST,
        source:
          JSON.stringify({ cli: rendererDigest(cli.code), renderer: digest }) +
          "\n",
      });
    },
    writeBundle() {
      for (const obsolete of obsoleteRendererFiles(
        fs.readdirSync(dist),
        previous,
        digest,
      ))
        fs.rmSync(path.join(dist, obsolete), { force: true });
    },
  };
}
