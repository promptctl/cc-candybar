import type { LaunchCategory, ContextualLauncher } from "../proc/launcher.js";
import { runTmuxIn, type TmuxRun } from "../proc/tmux.js";
import type { TmuxHint } from "../tmux-hint.js";
import { type PaneSnapshot } from "./prompt-screen.js";
import type { SlashLine } from "./slash-line.js";
import type { ClaudeInputEdge, Typed } from "./typing";

// A command separator inside one tmux invocation: the commands run in order
// in the server, so nothing lands between them.
const THEN = ";";
const BUFFER = "cc-candybar-slash";

async function tmux(
  launcher: ContextualLauncher,
  hint: TmuxHint,
  category: LaunchCategory,
  args: string[],
  stdinInput?: string,
): Promise<Exclude<TmuxRun, { kind: "failed" }>> {
  const run = await runTmuxIn(launcher, hint, category, args, stdinInput);
  if (run.kind === "failed") throw new Error(run.reason);
  return run;
}

async function read(
  launcher: ContextualLauncher,
  hint: TmuxHint,
): Promise<PaneSnapshot> {
  const run = await tmux(launcher, hint, "claude-input.read", [
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
  ]);
  if (run.kind === "rate-limited") throw new Error(run.reason);
  const [mode = "", ...screen] = run.stdout.split("\n");
  return { inMode: mode !== "0", screen };
}

// [LAW:one-source-of-truth] The one way a line is typed into a pane: it goes
// in as a BRACKETED paste then Enter, in one tmux call. Sent as keys, a long
// line reads as a paste and swallows the Enter after it as a newline; the
// paste's end marker makes the Enter a keystroke whatever the timing. The
// line reaches the buffer over stdin, never as an argument: tmux reads an
// argument ending in `;` as a command separator and drops it, so
// `/compact keep the api;` would be typed without its last character.
// `before` are keys sent ahead of the paste.
export function pasteLineArgs(
  pane: string,
  buffer: string,
  before: readonly string[],
): string[] {
  return [
    "load-buffer",
    "-b",
    buffer,
    "-",
    THEN,
    ...(before.length === 0 ? [] : ["send-keys", "-t", pane, ...before, THEN]),
    "paste-buffer",
    "-p",
    "-d",
    "-b",
    buffer,
    "-t",
    pane,
    THEN,
    "send-keys",
    "-t",
    pane,
    "Enter",
  ];
}

// ctrl+s stashes a draft (a no-op on an empty input) and Claude Code restores
// it after the submit.
async function type(
  launcher: ContextualLauncher,
  hint: TmuxHint,
  line: SlashLine,
): Promise<Typed> {
  const run = await tmux(
    launcher,
    hint,
    "claude-input.type",
    pasteLineArgs(hint.pane, BUFFER, ["C-s"]),
    line,
  );
  return run.kind === "ok"
    ? { kind: "typed" }
    : {
        kind: "refused",
        reason: `cc-candybar typed a command moments ago — click again in a second (${run.reason})`,
      };
}

export function productionClaudeInputEdge(
  launcher: ContextualLauncher,
): ClaudeInputEdge {
  return {
    read: (hint) => read(launcher, hint),
    type: (hint, line) => type(launcher, hint, line),
  };
}
