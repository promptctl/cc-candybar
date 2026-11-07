// What a daemon composed in a jest worker is handed for its process's edges:
// the bundle it names as its own, and what puts the tmux status lines back at
// its exit. Apart from the boot harness, so a case that boots nothing does not
// load it.

import path from "node:path";
import { pathToFileURL } from "node:url";

import type { RunningBundle } from "../../src/daemon/daemon";
import type { TmuxAtExit } from "../../src/daemon/tmux-status";

// A bundle at `checkout`, which need not exist: nothing runs it unless a case
// lays one down there.
export function bundleAt(checkout: string, digest: string | null = null): RunningBundle {
  const file = path.join(checkout, "dist", "index.mjs");
  return {
    entryUrl: pathToFileURL(file).href,
    digest,
    path: file,
    node: [process.execPath],
    targets: [file],
  };
}

// A worker's daemon lays out no tmux status line, so nothing is put back.
export const NO_TMUX_AT_EXIT: TmuxAtExit = () => ({
  kind: "failed",
  reason: "no tmux at this daemon's exit",
});
