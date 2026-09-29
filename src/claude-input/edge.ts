// Typing a slash command into the Claude Code session a click came from.
//
// [LAW:effects-at-boundaries] The two tmux calls — read the pane, type into
// it — live behind `ClaudeInputEdge`; whether to type is `typeSlash`'s fold
// over pure facts (the session's recorded tmux hint, promptState).
//
// [LAW:single-enforcer] tmux is the only route: the client reports the
// session's tmux socket and pane (src/tmux-hint.ts), so the keys reach THAT
// pane and nothing else. Outside tmux there is no pane to address, and typing
// into whatever window has focus is exactly what this must never do.

import type { ClientHints } from "../daemon/protocol.js";
import type { LaunchCategory } from "../proc/launch.js";
import { runTmux } from "../proc/tmux.js";
import type { TmuxHint } from "../tmux-hint.js";
import { promptState, REFUSALS, type PaneSnapshot } from "./prompt-screen.js";
import type { SlashLine } from "./slash-line.js";

export interface ClaudeInputEdge {
  // Throws naming tmux's own failure.
  readonly read: (hint: TmuxHint) => PaneSnapshot;
  readonly type: (hint: TmuxHint, line: SlashLine) => void;
}

export type TypeResult =
  | { readonly kind: "typed"; readonly pane: string }
  | { readonly kind: "refused"; readonly reason: string };

export function typeSlash(
  edge: ClaudeInputEdge,
  tmux: ClientHints["tmux"],
  line: SlashLine,
): TypeResult {
  if (tmux === undefined) {
    return {
      kind: "refused",
      reason:
        "this session's statusline client reports no tmux facts (it predates this daemon) — rebuild or reinstall cc-candybar",
    };
  }
  if (tmux === null) {
    return {
      kind: "refused",
      reason:
        "this Claude Code is not running inside tmux — the bar can only type into a tmux pane",
    };
  }
  const state = promptState(edge.read(tmux));
  if (state.kind !== "ready") {
    return { kind: "refused", reason: REFUSALS[state.kind] };
  }
  edge.type(tmux, line);
  return { kind: "typed", pane: tmux.pane };
}

// A command separator inside one tmux invocation: the commands run in order
// in the server, so nothing lands between them.
const THEN = ";";
const BUFFER = "cc-candybar-slash";

function tmux(
  hint: TmuxHint,
  category: LaunchCategory,
  args: string[],
  stdinInput?: string,
): string {
  const run = runTmux(hint, category, args, stdinInput);
  if (run.kind === "failed") throw new Error(run.reason);
  return run.stdout;
}

function read(hint: TmuxHint): PaneSnapshot {
  const [mode = "", ...screen] = tmux(hint, "claude-input.read", [
    "display",
    "-p",
    "-t",
    hint.pane,
    "#{pane_in_mode}",
    THEN,
    "capture-pane",
    "-p",
    "-t",
    hint.pane,
  ]).split("\n");
  return { inMode: mode !== "0", screen };
}

// ctrl+s stashes a draft (a no-op on an empty input) and Claude Code restores
// it after the submit. The line goes in as a BRACKETED paste: sent as keys, a
// long line reads as a paste and swallows the Enter after it as a newline;
// the paste's end marker makes the Enter a keystroke whatever the timing.
// The line reaches the buffer over stdin, never as an argument: tmux reads an
// argument ending in `;` as a command separator and drops it, so
// `/compact keep the api;` would be typed without its last character.
function type(hint: TmuxHint, line: SlashLine): void {
  tmux(
    hint,
    "claude-input.type",
    [
      "load-buffer",
      "-b",
      BUFFER,
      "-",
      THEN,
      "send-keys",
      "-t",
      hint.pane,
      "C-s",
      THEN,
      "paste-buffer",
      "-p",
      "-d",
      "-b",
      BUFFER,
      "-t",
      hint.pane,
      THEN,
      "send-keys",
      "-t",
      hint.pane,
      "Enter",
    ],
    line,
  );
}

export function productionClaudeInputEdge(): ClaudeInputEdge {
  return { read, type };
}
