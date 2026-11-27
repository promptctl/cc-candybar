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
const PANEL_ROOT = "resources/bar-window/";
const BAR_WEB_ROOT = "scripts/bar-web/";
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
  "scripts/import-zones.mjs": "lib",
  ".github/scripts/": "tools",
  "candybar-lite.mjs": "tools",
  "tsdown.config.ts": "tools",
  [PANEL_ROOT]: "tools",
  [BAR_WEB_ROOT]: "tools",
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

// [LAW:one-source-of-truth] All source forms have one extension vocabulary.
const TS_EXTENSIONS = ["ts", "mts", "cts", "tsx"];
export const JS_EXTENSIONS = ["js", "mjs", "cjs", "jsx"];
export const CODE_EXTENSIONS = [...TS_EXTENSIONS, ...JS_EXTENSIONS];
const globOf = (extensions) => `**/*.{${extensions.join(",")}}`;
export const CODE_GLOB = globOf(CODE_EXTENSIONS);
export const TS_GLOB = globOf(TS_EXTENSIONS);
export const JS_GLOB = globOf(JS_EXTENSIONS);
const CODE_EXTENSION = new RegExp(`\\.(?:${CODE_EXTENSIONS.join("|")})$`);
export const isCodeFile = (file) => CODE_EXTENSION.test(file);
export const withoutExtension = (p) => p.replace(CODE_EXTENSION, "");
const JS_EXTENSION = new RegExp(`\\.(?:${JS_EXTENSIONS.join("|")})$`);
export const isJavaScript = (file) => JS_EXTENSION.test(file);
const WEB_DECLARATION = /\.d\.[cm]?ts$/;
export const BROWSER_FILES = [
  PANEL_ROOT + CODE_GLOB, BAR_WEB_ROOT + JS_GLOB, BAR_WEB_ROOT + "**/*.d.{ts,mts,cts}",
];

// Exact bootstrap configs are executed by their runners. Jest config can
// import worker paths before Jest globals exist. None is an importable tool.
const jestConfig = "Jest reads this bootstrap before installing its worker globals.";
const lintConfig = "ESLint loads its own flat configuration to construct the rules.";
const exemptions = {
  "jest.config.js": jestConfig,
  "jest.worker.config.js": jestConfig,
  "jest.unit.config.js": jestConfig,
  "jest.process.config.js": jestConfig,
  "jest.launcher-fixtures.config.js": jestConfig,
  "jest.unit-fixtures.config.js": jestConfig,
  "audits/jest.config.js": jestConfig,
  "eslint.config.mjs": lintConfig,
  "eslint.tests.config.mjs": lintConfig,
  "eslint.tools.config.mjs": lintConfig,
  "design-docs/peer-exploration/5-landscape/explorer/": "The independently built design explorer has its own package, generated examples and TypeScript project.",
  "docs/design/probes/": "Standalone design experiments, outside the application's dependency graph.",
  "vendor/cc-extra/": "Vendored upstream package maintained by scripts/vendor-cc-extra.mjs.",
  "bin/cc-candybar": "Extensionless Node shim exercised as both a packaged ES module and a staged CommonJS entry.",
};

const ownershipRows = Object.entries(ZONE_ROWS).map(([row, zone]) => ({ row, zone }));
const table = [
  ...ownershipRows,
  ...Object.entries(exemptions).map(([row, reason]) => ({ row, reason })),
].sort((a, b) => b.row.length - a.row.length);
if (new Set(table.map(({row}) => row)).size !== table.length)
  throw new Error("scripts/import-zones.mjs: multiple coverage declarations for one path");

// Source files match physical filenames. Import specifiers below can name the
// same module by an emitted extension or an extensionless directory index.
export const coverageOf = (file) =>
  table.find(({row}) => row.endsWith("/") ? file.startsWith(row) : file === row);

export function environmentOf(file, zone) {
  if (file.startsWith(PANEL_ROOT) ||
      (file.startsWith(BAR_WEB_ROOT) && (isJavaScript(file) || WEB_DECLARATION.test(file))))
    return "browser";
  return zone === "test" ? "jest" : "node";
}

const tools = ownershipRows.filter(({zone}) => zone === "tools" || zone === "lib");
const globsOf = (rows, glob) => rows.map(({row}) => row.endsWith("/") ? row + glob : row);
const application = ownershipRows.filter(({row, zone}) => APP.includes(zone) && (row.endsWith("/") || isCodeFile(row)));
export const APP_FILES = globsOf(application, CODE_GLOB);
export const APP_TYPESCRIPT = APP_FILES.map((pattern) => [pattern, TS_GLOB]);
export const APP_JAVASCRIPT = APP_FILES.map((pattern) => [pattern, JS_GLOB]);
export const isApplicationZone = (zone) => APP.includes(zone);
export const TOOL_FILES = globsOf(tools, CODE_GLOB);
export const LIB_FILES = globsOf(ownershipRows.filter(({zone}) => zone === "lib"), CODE_GLOB);
// Directory probes belonging to the Node project. Exact files and browser
// roots have their own real-file probes.
export const OUTSIDE_JEST_ROOTS = tools.map(({row}) => row)
  .filter((row) => row.endsWith("/") && row !== PANEL_ROOT && row !== BAR_WEB_ROOT);

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
  (zone) => zone === null || !(zone in ZONE_IMPORTS),
);
if (unknown.length > 0)
  throw new Error(`scripts/import-zones.mjs: no zone ${[...new Set(unknown)].join(", ")}`);

// The Node transport uses native diagnostics and owns its pipes and heap.
// The separately built renderer module admits no builtin anywhere.
const transportBuiltins = new Set(["events", "process", "v8"]);
export function mayLoadRendererModule(id, atProcessEntry) {
  if (!isBuiltin(id)) return true;
  const name = id.replace(/^node:/, "");
  return name === "util" || (atProcessEntry && transportBuiltins.has(name));
}
