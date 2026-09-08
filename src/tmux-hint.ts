// [LAW:single-enforcer] Only the CLIENT sees Claude Code's exact environment.
// [LAW:one-source-of-truth] Mirrored by the Rust client and anchored on by
// check-protocol — keep it a named const of string literals, or repoint the
// CHECKS row in the same commit.
export const TMUX_ENV = {
  // `socket,server-pid,session-id`; `tmux -S <socket>` needs the first field.
  socket: "TMUX",
  pane: "TMUX_PANE",
  // Truthy in Claude Code's own env stops 256-colour re-encoding inside tmux.
  truecolor: "CLAUDE_CODE_TMUX_TRUECOLOR",
} as const;

// [LAW:types-are-the-program] The facts, not a verdict.
export interface TmuxHint {
  readonly socket: string;
  readonly pane: string;
  readonly truecolor: string | null;
}

// [LAW:dataflow-not-control-flow] TOTAL: `null` affirmatively means "not in
// tmux", reserving ABSENT for "client too old". Both vars must be non-empty —
// TMUX alone leaks into shells detached from a pane.
export function detectTmuxHint(
  env: Readonly<Record<string, string | undefined>>,
): TmuxHint | null {
  const tmux = env[TMUX_ENV.socket] ?? "";
  const pane = env[TMUX_ENV.pane] ?? "";
  if (tmux === "" || pane === "") return null;
  const truecolor = env[TMUX_ENV.truecolor] ?? "";
  return {
    socket: tmux.split(",")[0]!,
    pane,
    truecolor: truecolor === "" ? null : truecolor,
  };
}
