// [LAW:one-way-deps] ESLint and the production bundle use this ownership table.
// Unlisted application modules belong to the host. More specific entries win.
// The CLI dispatches to every process. The renderer process constructs its
// core using the shared contract and has no host dependencies. The test suite
// is Jest's alone: what runs outside Jest (src, and the tools in scripts/,
// site/ and proto-looks/) imports nothing from it. What a tool and a test
// share lives in scripts/lib/, which imports only the app and itself, so it
// never loads a tool's entry. The tests may import the tools they test.
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
  "src/click/link-signer.ts": "shared",
  "src/cli-flags.ts": "shared",
  "src/claude-input/slash-line.ts": "shared",
  "src/claude-input/typing.ts": "shared",
  "src/claude-input/prompt-screen.ts": "shared",
  "src/help-text.ts": "shared",
  "src/index.ts": "root",
  // The renderer process's composition root, the counterpart of the daemon's.
  "src/renderer-process.ts": "renderer-process",
  "test/": "test",
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

// The directories of code that runs outside Jest beside the app: the tools,
// and what they share with the tests. eslint.tools.config.mjs lints them.
export const OUTSIDE_JEST_ROOTS = Object.entries(ZONE_ROWS)
  .filter(([, zone]) => zone === "tools" || zone === "lib")
  .map(([row]) => row);

export const withoutExtension = (p) => p.replace(/\.(m?ts|m?js)$/, "");
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
  )?.zone ?? "rest";
};

export const mayImport = (from, to) => ZONE_IMPORTS[from].includes(to);
import { isBuiltin } from "node:module";


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
