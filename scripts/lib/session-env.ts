import type { Environment } from "../../src/daemon/foundations/session-env";

// The environment a client running in a Claude Code session's terminal sees,
// from which it reports its hints (detectClientHints).
//
// [LAW:one-source-of-truth] Every session the benchmark's world drives is the
// same kind of terminal, so what it reports is spelled once.
export function sessionEnv(claudeDir: string): NodeJS.ProcessEnv {
  return {
    CLAUDE_CONFIG_DIR: claudeDir,
    TERM: "xterm-ghostty",
    TERM_PROGRAM: "ghostty",
    COLORTERM: "truecolor",
  };
}

// [LAW:one-source-of-truth] The environment a fixture session reports, as a
// client reports the one Claude Code gave it: where its tools live, and its
// Claude Code config dir. Nothing else reaches the session's children.
export const reportedEnvironment = (
  PATH: string,
  CLAUDE_CONFIG_DIR: string,
): Environment => Object.freeze({ PATH, CLAUDE_CONFIG_DIR });
