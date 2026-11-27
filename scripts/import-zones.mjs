import { isBuiltin } from "node:module";

// [LAW:one-way-deps] ESLint and the production bundle use this ownership table.
// Application modules no narrower row names belong to the host. More specific
// entries win. A path no row names is in no zone, so nothing may import it:
// a new root says which side of Jest it runs on before anything reaches it.
// The CLI dispatches to every process. The renderer process constructs its
// core using the shared contract and has no host dependencies. The test suite
// is Jest's alone: what runs outside Jest (src, and the tools in scripts/,
// site/ and proto-looks/) imports nothing from it. What a tool and a test
// share lives in scripts/lib/, which imports only the app and itself, so it
// never loads a tool's entry. The tests may import the tools they test.
// Jest's packages are the test zone's too (packageZoneOf).
const ZONE_ROWS = {
  "src/renderer/": "renderer",
  "src/renderer/main.ts": "start",
  "src/renderer-interface/": "shared",
  "src/daemon/foundations/": "shared",
  "src/render/": "shared",
  "src/var-system/": "shared",
  "src/template-engine/": "shared",
  "src/dsl/": "shared",
  "src/themes/": "shared",
  "src/config/": "shared",
  "src/facts/": "shared",
  "src/segments/": "shared",
  "src/utils/": "shared",
  "src/time.ts": "shared",
  "src/claude-settings.ts": "shared",
  "src/repository-cli.ts": "shared",
  "src/proc/launcher.ts": "shared",
  "src/claude-resume.ts": "shared",
  "src/claude-command-line.ts": "shared",
  "src/shell-word.ts": "shared",
  "src/client-hint.ts": "shared",
  "src/config-hint.ts": "shared",
  "src/host-facts.ts": "shared",
  "src/terminal-hint.ts": "shared",
  "src/tmux-hint.ts": "shared",
  "src/click/wire.ts": "shared",
  "src/click/wire-value.ts": "shared",
  "src/click/link-signer.ts": "shared",
  "src/click/gesture.ts": "shared",
  "src/cli-flags.ts": "shared",
  "src/claude-input/slash-line.ts": "shared",
  "src/claude-input/typing.ts": "shared",
  "src/claude-input/prompt-screen.ts": "shared",
  "src/help-text.ts": "shared",
  // The package's manifest is data that imports nothing, so every side reads it.
  "package.json": "shared",
  "src/": "rest",
  "src/index.ts": "root",
  // The renderer process's composition root, the counterpart of the daemon's.
  "src/renderer-process.ts": "renderer-process",
  "test/": "test",
  // The nightly audits run under Jest, over the suite's helpers.
  "audits/": "test",
  "scripts/lib/": "lib",
  "scripts/": "tools",
  "site/": "tools",
  "proto-looks/": "tools",
};
const rendererDependencies = ["renderer", "start", "shared"];
// Every zone of the app in src, which its root and everything outside src may
// import.
const APP = ["renderer", "start", "shared", "rest", "root", "renderer-process"];
export const ZONE_IMPORTS = {
  renderer: rendererDependencies,
  start: rendererDependencies,
  shared: ["shared"],
  rest: ["rest", "start", "shared"],
  "renderer-process": rendererDependencies,
  root: APP,
  lib: [...APP, "lib"],
  tools: [...APP, "lib", "tools"],
  test: [...APP, "lib", "tools", "test"],
};
// The zone of a path no row names: no zone imports it.
export const NO_ZONE = "unlisted";

// The directories of code that runs outside Jest beside the app: the tools,
// and what they share with the tests. eslint.tools.config.mjs lints them.
export const OUTSIDE_JEST_ROOTS = Object.entries(ZONE_ROWS)
  .filter(([, zone]) => zone === "tools" || zone === "lib")
  .map(([row]) => row);

// [LAW:one-source-of-truth] The extensions of code: every glob a lint config
// runs over, and every key the zone rule strips, spell them from here.
const TS_EXTENSIONS = ["ts", "mts", "cts"];
const JS_EXTENSIONS = ["js", "mjs", "cjs"];
export const CODE_EXTENSIONS = [...TS_EXTENSIONS, ...JS_EXTENSIONS];
const globOf = (extensions) => `**/*.{${extensions.join(",")}}`;
export const CODE_GLOB = globOf(CODE_EXTENSIONS);
export const TS_GLOB = globOf(TS_EXTENSIONS);
export const JS_GLOB = globOf(JS_EXTENSIONS);
const CODE_EXTENSION = new RegExp(`\\.(?:${CODE_EXTENSIONS.join("|")})$`);
export const withoutExtension = (p) => p.replace(CODE_EXTENSION, "");
const ZONE_KEYS = Object.entries(ZONE_ROWS)
  .map(([row, zone]) => ({
    row: row.endsWith("/") ? row : withoutExtension(row),
    zone,
  }))
  .sort((a, b) => b.row.length - a.row.length);
export const zoneOf = (file) => {
  const key = withoutExtension(file).replaceAll("\\", "/");
  return ZONE_KEYS.find(({ row }) =>
    row.endsWith("/") ? `${key}/`.startsWith(row) : key === row,
  )?.zone ?? NO_ZONE;
};

// The directories the test zone owns, which run under Jest.
export const TEST_ROOTS = Object.entries(ZONE_ROWS)
  .filter(([, zone]) => zone === "test")
  .map(([row]) => row);

// [LAW:one-way-deps] The zone that owns a package, or none: Jest's are the
// test zone's. Jest's are every package named for it, a `jest` word in its
// scope or name (jest, jest-mock, @jest/globals, ts-jest, babel-jest,
// @types/jest), and its assertion library, published as `expect`. No zone
// owns any other package, and every zone may import it.
export const packageZoneOf = (id) => {
  const name = id.split("/").slice(0, id.startsWith("@") ? 2 : 1).join("/");
  return name === "expect" || name.split(/[@/-]/).includes("jest")
    ? "test"
    : null;
};

export const mayImport = (from, to) => ZONE_IMPORTS[from].includes(to);

// [LAW:no-silent-failure] Every zone a row or a package names is one the
// table says the imports of, or the table refuses to load.
const unknown = [...Object.values(ZONE_ROWS), packageZoneOf("jest")].filter(
  (zone) => !(zone in ZONE_IMPORTS),
);
if (unknown.length > 0)
  throw new Error(`scripts/import-zones.mjs: no zone ${[...new Set(unknown)].join(", ")}`);

// [LAW:effects-at-boundaries] Shared rendering code uses Node for paths, URLs,
// hashes and value inspection. Only the process entry also owns its pipes,
// process measurements and heap snapshots. A new native dependency is
// checked even when it arrives through a package.
const renderBuiltins = new Set([
  "crypto", "path", "path/posix", "path/win32", "url", "util", "util/types",
]);
const transportBuiltins = new Set(["events", "process", "v8"]);
export function mayLoadRendererModule(id, atProcessEntry) {
  if (!isBuiltin(id)) return true;
  const name = id.replace(/^node:/, "");
  return renderBuiltins.has(name) || (atProcessEntry && transportBuiltins.has(name));
}
