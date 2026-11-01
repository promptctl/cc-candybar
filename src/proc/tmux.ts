// One tmux invocation against a session's recorded server.
//
// [LAW:one-source-of-truth] The doctor's probe, the slash edge and the tmux
// segment's session lookup all address the pane a client reported
// (src/tmux-hint.ts); this is the one place that spells `tmux -S <socket>`,
// its timeout, and how a failure reads.

import type {
  LaunchCategory,
  LaunchOpts,
  LaunchResult,
  Launcher,
} from "./launch.js";
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
    return { kind: "rate-limited", reason: result.error ?? "rate-limited" };
  }
  // `error` is a whole sentence when present (rate-limited, timeout, spawn);
  // a non-zero exit has only its stderr to say.
  const detail =
    result.error ??
    [result.reason, result.stderr.trim()].filter((s) => s !== "").join(": ");
  return { kind: "failed", reason: `tmux ${args[0]} failed (${detail})` };
}

// Holds the caller's loop until tmux answers: for what must finish before the
// process does, the status lines put back at exit, where no later turn comes.
export function runTmux(
  launcher: Launcher,
  hint: Pick<TmuxHint, "socket">,
  category: LaunchCategory,
  args: readonly string[],
  stdinInput?: string,
): TmuxRun {
  return tmuxRun(
    launcher.launchSync(invocation(hint, category, args, stdinInput)),
    args,
  );
}

// The same invocation off the loop: for everything else the daemon asks.
export async function runTmuxAsync(
  launcher: Launcher,
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
