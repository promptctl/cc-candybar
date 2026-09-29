// One tmux invocation against a session's recorded server.
//
// [LAW:one-source-of-truth] The doctor's probe and the slash edge both address
// the pane a client reported (src/tmux-hint.ts); this is the one place that
// spells `tmux -S <socket>`, its timeout, and how a failure reads.

import { launchSync, type LaunchCategory } from "./launch.js";
import type { TmuxHint } from "../tmux-hint.js";

export type TmuxRun =
  | { readonly kind: "ok"; readonly stdout: string }
  | { readonly kind: "failed"; readonly reason: string };

export function runTmux(
  hint: TmuxHint,
  category: LaunchCategory,
  args: readonly string[],
  stdinInput?: string,
): TmuxRun {
  const result = launchSync({
    bin: "tmux",
    args: ["-S", hint.socket, ...args],
    timeoutMs: 2000,
    category,
    stdinInput,
  });
  if (result.ok) return { kind: "ok", stdout: result.stdout };
  // `error` is a whole sentence when present (rate-limited, timeout, spawn);
  // a non-zero exit has only its stderr to say.
  const detail =
    result.error ??
    [result.reason, result.stderr.trim()].filter((s) => s !== "").join(": ");
  return { kind: "failed", reason: `tmux ${args[0]} failed (${detail})` };
}
