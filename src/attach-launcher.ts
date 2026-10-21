// Where the attach launcher lane B restarts Claude Code under sits: cc-extra's
// `bun-attach.js`, vendored at vendor/cc-extra (scripts/vendor-cc-extra.mjs),
// which the build lays beside the bundle (tsdown.config.ts) and an install
// stages beside it (src/install/index.ts).
//
// [LAW:one-source-of-truth] The one spelling of that place, for the build's
// consumers: the install that stages it and the lane that runs it.

import path from "node:path";
import {
  claudeCommandLine,
  type ClaudeCommand,
} from "./claude-command-line.js";

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

// The preload that starts Claude Code under the launcher from one variable
// (src/attach-preload.ts), built beside the bundle (tsdown.config.ts) and
// staged beside it (src/install/index.ts).
export const ATTACH_PRELOAD = "attach-preload.cjs";

export function attachPreloadOf(bundle: string): string {
  return path.join(path.dirname(bundle), ATTACH_PRELOAD);
}

// The variable that carries the preload into a Bun-compiled Claude Code.
export const PRELOAD_VARIABLE = "BUN_OPTIONS";

// `command` started under the launcher with `preload`: BUN_OPTIONS set to
// `--preload <preload>` on it — `BUN_OPTIONS='--preload <preload>' claude`.
// Bun splits BUN_OPTIONS on whitespace and reads a backslash as taking the
// next character (quotes it does not read, and `--preload=` keeps the
// backslash), so a space in the path is escaped for Bun, and the whole value
// then quoted for the shell.
export function attachCommandLine(
  preload: string,
  command: ClaudeCommand,
): string {
  return claudeCommandLine({
    ...command,
    env: [
      ...command.env,
      [PRELOAD_VARIABLE, `--preload ${preload.replace(/[\\\s]/g, "\\$&")}`],
    ],
  });
}
