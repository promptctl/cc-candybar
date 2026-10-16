// The hook payload a Claude Code pane's statusline last received, recorded by
// scripts/bar-pane/record-statusline.
//
// A render request needs the session's hook payload, and only the statusline
// command Claude Code spawns is ever handed one. Until the daemon pushes a
// session's frames (candybar-animation-wbxz.jmm.usl) — and so holds the
// payload itself — the bar pane re-sends the one the statusline last saw.

import fs from "node:fs";
import path from "node:path";
import type { ClaudeHookData } from "../utils/claude";
import type { TmuxHint } from "../tmux-hint";
import { stateDir } from "../daemon/paths";

// [LAW:one-source-of-truth] The recorder script spells this path too
// (`$XDG_STATE_HOME/cc-candybar/bar-pane/<server><pane>.json`); stateDir is the
// layout both read. A pane id is unique only within its tmux server, so the
// server's name — its socket's file name, `default` or `-L`'s — leads it.
export function recordingPath(tmux: TmuxHint, pane: string): string {
  return path.join(
    stateDir(),
    "bar-pane",
    `${path.basename(tmux.socket)}${pane}.json`,
  );
}

// `absent`: the pane's statusline has not run since the recorder was put in
// front of it — a state the bar pane shows, not a failure.
export type Recording =
  | { readonly kind: "absent"; readonly path: string }
  | { readonly kind: "recorded"; readonly hookData: ClaudeHookData };

// The recorder renames a whole file into place, so a read never sees half a
// payload; anything else unreadable is a fault and throws. The payload's shape
// is the daemon's to check (validateHookData), as for every render request.
export function readRecording(tmux: TmuxHint, pane: string): Recording {
  const file = recordingPath(tmux, pane);
  try {
    return {
      kind: "recorded",
      hookData: JSON.parse(fs.readFileSync(file, "utf8")) as ClaudeHookData,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent", path: file };
    }
    throw e;
  }
}
