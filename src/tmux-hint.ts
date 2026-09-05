// The client's tmux probe — the facts about the tmux session Claude Code is
// running in, read from the client's own environment.
//
// [LAW:single-enforcer] Only the statusline CLIENT can observe these: Claude
// Code spawns it with Claude Code's exact environment, while the daemon is
// detached and one-per-user, its env answering for whichever shell spawned it.
// So the client reports and the daemon records (server.ts,
// SESSION_CLIENT_HINTS_KEY) — the doctor reasons over the facts of the
// session's last render, never over the daemon's own env.
//
// [LAW:one-source-of-truth] This vocabulary is mirrored by the Rust client
// (rust-client/src/main.rs, TMUX_ENV) and diffed by scripts/check-protocol.mjs,
// which anchors on the declaration below — keep it a named const holding string
// literals, or repoint the CHECKS row in the same commit. Both runtimes must
// agree on what "in tmux" means or the native fast path and the node fallback
// would report the same session differently.
export const TMUX_ENV = {
  // `socket,server-pid,session-id` — the socket is the part before the first
  // comma, and it is what `tmux -S <socket>` needs to reach THIS server.
  socket: "TMUX",
  pane: "TMUX_PANE",
  // Claude Code's own switch: when this is truthy in ITS environment, it stops
  // re-encoding the statusline at 256 colours inside tmux (verified against the
  // 2.1.259 binary: `if (env.CLAUDE_CODE_TMUX_TRUECOLOR) return false`).
  truecolor: "CLAUDE_CODE_TMUX_TRUECOLOR",
} as const;

// [LAW:types-are-the-program] The facts, not a verdict. `truecolor` is the
// value Claude Code's truthiness test sees: a non-empty string, or `null` for
// unset-or-empty (both falsy to that test, so both mean "not told"). Whether
// the terminal can do RGB is not here — that is tmux's own verdict, queried
// by the daemon at click time from `socket` and `pane`.
export interface TmuxHint {
  readonly socket: string;
  readonly pane: string;
  readonly truecolor: string | null;
}

// [LAW:dataflow-not-control-flow] TOTAL over the client's environment, like
// detectSsh: "not in tmux" is the affirmative answer `null`, never a failure to
// determine, so the client always reports and the daemon reads an ABSENT
// `tmux` hint as "client too old to answer" rather than as "not in tmux".
// In tmux iff both TMUX and TMUX_PANE are non-empty — TMUX alone leaks into
// shells that were merely started from a tmux pane and have since detached.
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
