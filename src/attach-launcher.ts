// Where the attach launcher lane B restarts Claude Code under sits: cc-extra's
// `bun-attach.js`, vendored at vendor/cc-extra (scripts/vendor-cc-extra.mjs),
// which the build lays beside the bundle (tsdown.config.ts) and an install
// stages beside it (src/install/index.ts).
//
// [LAW:one-source-of-truth] The one spelling of that place, for the build's
// consumers: the install that stages it and the lane that runs it.

import path from "node:path";

export const ATTACH_DIR = "cc-extra";

// The launcher beside `bundle` (a `dist/index.mjs`).
export function attachLauncherOf(bundle: string): string {
  return path.join(path.dirname(bundle), ATTACH_DIR, "src", "bun-attach.js");
}

// cc-extra's reader of the module graph a Bun-compiled Claude Code embeds,
// beside `launcher`: the launcher's own self-check, run as a CLI.
export function moduleGraphReaderOf(launcher: string): string {
  return path.join(path.dirname(launcher), "bun-graph.js");
}
