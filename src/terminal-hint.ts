// The client's terminal probe — the variables a terminal emulator sets to name
// itself, and the one that says where its config is, read from the client's
// own environment.
//
// [LAW:single-enforcer] Only the statusline CLIENT can observe these: Claude
// Code spawns it with Claude Code's exact environment, while the daemon is
// detached and one-per-user, its env answering for whichever shell spawned it.
// So the client reports them as the `terminalEnv` hint and the doctor reasons
// over the session's last render (src/doctor/terminal.ts).
//
// [LAW:one-source-of-truth] They cross raw, by name: which terminal a value
// means is the doctor's reading, made in one place. The names are mirrored by
// the Rust client (rust-client/src/main.rs, TERMINAL_ENV_VARS) and diffed by
// scripts/check-protocol.mjs, which anchors on the declaration below.
export const TERMINAL_ENV_VARS = [
  // iTerm2 (`iTerm.app`), Ghostty (`ghostty`), WezTerm (`WezTerm`), and the
  // version beside it. Inside tmux it is tmux's own `tmux`.
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  // kitty (`xterm-kitty`) and Alacritty (`alacritty`) name themselves here.
  "TERM",
  // The iTerm2 profile the session's window was opened with.
  "ITERM_PROFILE",
  // Where a terminal that reads a config file (Alacritty) finds it.
  "XDG_CONFIG_HOME",
] as const;

export type TerminalEnvVar = (typeof TERMINAL_ENV_VARS)[number];

// Each variable the client's environment sets; a name left out is one that
// environment does not set.
export type TerminalEnvHint = Readonly<Partial<Record<TerminalEnvVar, string>>>;

// [LAW:dataflow-not-control-flow] Total over the client's environment: an
// unset or empty variable is left out, and the hint is always an object, so its
// absence on the wire means only "client too old to report". Mirrored by the
// Rust client (terminal_env_hint).
export function detectTerminalEnv(
  env: Readonly<Record<string, string | undefined>>,
): TerminalEnvHint {
  return Object.fromEntries(
    TERMINAL_ENV_VARS.flatMap((name) => {
      const value = env[name] ?? "";
      return value === "" ? [] : [[name, value]];
    }),
  );
}
