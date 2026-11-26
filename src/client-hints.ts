// [LAW:single-enforcer] The host and the older daemon's Node relay use the
// same derivation of hints from a session environment. Terminal dimensions
// are observed on the client because the host has no access to its tty.

import type { Host } from "./host";
import type { UserHome } from "./utils/user-path";
import type { ClientHints } from "./daemon/foundations/protocol";
import { detectClaudeConfigDir } from "./claude-settings";
import { detectConfigEnv } from "./config-hint";
import { detectTermExtent } from "./term-extent";
import { detectTerminalEnv } from "./terminal-hint";
import { detectTmuxHint } from "./tmux-hint";

// The env vars an SSH login shell inherits from sshd. Any one of them present
// and non-empty means this session arrived over the network.
//
// [LAW:one-source-of-truth] This vocabulary is mirrored by the Rust client
// (rust-client/src/main.rs) and diffed by scripts/check-protocol.mjs, which
// anchors on the declaration below — keep it a named const holding string
// literals, or repoint the CHECKS row in the same commit. Both runtimes must
// agree on what "SSH" means or the fast path and the fallback path would
// disagree about the same session.
//
// All three are checked, not just SSH_CONNECTION: SSH_CLIENT is what older
// sshd builds (and the user's git-taculous zsh theme) key on, and SSH_TTY is
// the one that survives some `sudo` env_keep policies. Extra names can only
// widen recall of a fact that is otherwise reported as a plain `false`.
export const SSH_ENV_VARS = [
  "SSH_CONNECTION",
  "SSH_CLIENT",
  "SSH_TTY",
] as const;

export function terminalObservation(
  env: Readonly<NodeJS.ProcessEnv>,
  tty: { readonly columns?: number; readonly rows?: number },
): Pick<ClientHints, "termCols" | "termRows"> {
  return {
    termCols: detectTermExtent(env.COLUMNS, tty.columns),
    termRows: detectTermExtent(env.LINES, tty.rows),
  };
}

// `tty` is the stream still attached to the session's terminal: stderr for a
// statusline client, whose stdin is the hook JSON and stdout the captured line.
// Every hint but `client`: what the calling program IS is no fact of its
// environment, and only a statusline client has one to report.
export function detectClientHints(
  host: Pick<Host, "env"> & { readonly home: UserHome },
  cwd: string,
  tty: { readonly columns?: number; readonly rows?: number },
): Omit<ClientHints, "client"> {
  const { env } = host;
  return {
    ...terminalObservation(env, tty),
    // [LAW:dataflow-not-control-flow] A fold over the vocabulary — adding a
    // name is a data edit. TOTAL, unlike the extents: "no SSH var set" is the
    // affirmative answer "local", so an ABSENT `ssh` hint on the daemon side
    // means only "this client is too old to answer".
    ssh: SSH_ENV_VARS.some((name) => (env[name] ?? "") !== ""),
    // Total like ssh: `null` is the affirmative "not in tmux", so an absent
    // hint on the daemon side means only "client too old".
    tmux: detectTmuxHint(env),
    // Conditional like termCols: absent IS "no override", so the daemon
    // resolves the precedence chain. The daemon reads no env of its own.
    configEnv: detectConfigEnv(host, cwd),
    // Conditional too: absent is the default directory. The daemon reads
    // settings.json from THIS session's Claude Code directory.
    claudeConfigDir: detectClaudeConfigDir(env, cwd),
    // Total like tmux: always an object, so an absent hint means only "client
    // too old". No code reads them today; they name the terminal that draws the
    // bar (src/terminal-hint.ts).
    terminalEnv: detectTerminalEnv(env),
  };
}
