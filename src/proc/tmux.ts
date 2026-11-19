// One tmux invocation against a session's recorded server.
//
// [LAW:one-source-of-truth] The slash edge, pane renderer and tmux
// segment's session lookup all address the pane a client reported
// (src/tmux-hint.ts); this is the one place that spells `tmux -S <socket>`,
// its timeout, and how a failure reads.

import {
  failureText,
  type LaunchCategory,
  type LaunchOpts,
  type LaunchResult,
  type Launcher,
} from "./launcher.js";
import type { TmuxHint } from "../tmux-hint.js";

// `rate-limited`: launch.ts refused to spawn, so tmux never ran — a fact about
// the caller's cadence, not about tmux.
export type TmuxRun =
  | { readonly kind: "ok"; readonly stdout: string }
  | { readonly kind: "rate-limited"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

function invocation(
  hint: Pick<TmuxHint, "socket">,
  category: LaunchCategory,
  args: readonly string[],
  stdinInput?: string,
): LaunchOpts {
  return {
    bin: "tmux",
    args: ["-S", hint.socket, ...args],
    timeoutMs: 2000,
    category,
    stdinInput,
  };
}

function tmuxRun(result: LaunchResult, args: readonly string[]): TmuxRun {
  if (result.ok) return { kind: "ok", stdout: result.stdout };
  if (result.reason === "rate-limited") {
    return { kind: "rate-limited", reason: failureText(result) };
  }
  return {
    kind: "failed",
    reason: `tmux ${args[0]} failed (${failureText(result)})`,
  };
}

// One tmux invocation, off the loop.
export async function runTmuxAsync(
  launcher: Pick<Launcher, "launch">,
  hint: Pick<TmuxHint, "socket">,
  category: LaunchCategory,
  args: readonly string[],
  stdinInput?: string,
): Promise<TmuxRun> {
  return tmuxRun(
    await launcher.launch(invocation(hint, category, args, stdinInput)),
    args,
  );
}
