// The environment a client running in a Claude Code session's terminal sees,
// from which it reports its hints (detectClientHints).
//
// [LAW:one-source-of-truth] The load gate and the benchmark drive the daemon
// as the same kind of terminal, so what they report is spelled once.
export function sessionEnv(claudeDir: string): NodeJS.ProcessEnv {
  return {
    CLAUDE_CONFIG_DIR: claudeDir,
    TERM: "xterm-ghostty",
    TERM_PROGRAM: "ghostty",
    COLORTERM: "truecolor",
  };
}
