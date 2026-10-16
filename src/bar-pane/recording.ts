// The invocation a Claude Code pane's statusline last received, recorded by
// scripts/bar-pane/record-statusline.
//
// A render request needs the session's hook payload, and only the statusline
// command Claude Code spawns is ever handed one. Until the daemon pushes a
// session's frames (candybar-animation-wbxz.jmm.usl) — and so holds the
// payload itself — the bar pane replays the invocation the statusline last saw.

import fs from "node:fs";
import path from "node:path";
import type { ClaudeHookData } from "../utils/claude";
import { stateDir } from "../daemon/paths";

// One tmux server run, as `$TMUX` (`socket,server-pid,session`) names it: its
// socket's file name and its pid. A pane id is unique only within one run —
// ids start again at %0 when a server restarts.
export function serverOf(tmuxVar: string): string {
  return path.basename(tmuxVar.slice(0, tmuxVar.lastIndexOf(",")));
}

// [LAW:one-source-of-truth] The recorder script spells this path too
// (`$XDG_STATE_HOME/cc-candybar/bar-pane/<server><pane>`); stateDir is the
// layout both read.
export function recordingPath(server: string, pane: string): string {
  return path.join(stateDir(), "bar-pane", `${server}${pane}`);
}

// What the statusline client was run with: everything it builds its render
// request from.
export interface Invocation {
  readonly hookData: ClaudeHookData;
  readonly cwd: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

// `absent`: the pane's statusline has not run since the recorder was put in
// front of it — a state the bar pane shows, not a failure.
export type Recording =
  | { readonly kind: "absent"; readonly path: string }
  | { readonly kind: "recorded"; readonly invocation: Invocation };

// [LAW:parse-dont-validate] The record's layout, NUL-separated (no field can
// hold a NUL — JSON escapes it, argv and the environment cannot carry one):
// the payload, the cwd, argc, argv, then one `NAME=value` per variable, each
// field NUL-terminated. The payload's shape is the daemon's to check
// (validateHookData), as for every render request.
function parseInvocation(file: string, text: string): Invocation {
  const [payload, cwd, argc, ...rest] = text.split("\0");
  const n = Number(argc);
  if (cwd === undefined || !Number.isInteger(n) || rest.length < n + 1) {
    throw new Error(`bar-pane: ${file} is not a statusline record`);
  }
  let hookData: ClaudeHookData;
  try {
    hookData = JSON.parse(payload!) as ClaudeHookData;
  } catch (e) {
    throw new Error(
      `bar-pane: ${file} holds no JSON payload (${(e as Error).message})`,
    );
  }
  return {
    hookData,
    cwd,
    argv: rest.slice(0, n),
    env: Object.fromEntries(
      rest.slice(n, -1).map((entry) => {
        const eq = entry.indexOf("=");
        return [entry.slice(0, eq), entry.slice(eq + 1)];
      }),
    ),
  };
}

// The recorder renames a whole file into place, so a read never sees half a
// record; anything else unreadable is a fault and throws.
export function readRecording(server: string, pane: string): Recording {
  const file = recordingPath(server, pane);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent", path: file };
    }
    throw e;
  }
  return { kind: "recorded", invocation: parseInvocation(file, text) };
}
