// [LAW:one-source-of-truth] The source-run reader of the package version
// stamp — tsdown's `define` counterpart for anything that runs untranspiled
// source. src/version.ts throws at load without a stamp, so every such process
// preloads this (test/setup.ts requires it and threads it through NODE_OPTIONS
// `--import`; scripts/daemon-load-harness.ts does the same for its tsx daemon).
// CommonJS so plain `node`, `tsx`, and Jest's sandbox all load it untransformed.
const { version } = require("../package.json");
globalThis.__PACKAGE_VERSION__ = version;

// The NODE_OPTIONS a caller spawns children with: whatever it already had,
// plus the preload of this file. One merge, so no caller clobbers an
// operator's own flags or spells the append a second way.
const IMPORT_FLAG = `--import=${require("node:url").pathToFileURL(__filename).href}`;
exports.withStamp = (nodeOptions) =>
  [nodeOptions ?? "", IMPORT_FLAG].filter((s) => s !== "").join(" ");
