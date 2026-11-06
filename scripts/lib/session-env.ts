// The environment a client running in a Claude Code session's terminal sees,
// from which it reports its hints (detectClientHints).
//
// [LAW:one-source-of-truth] Every session the benchmark's world drives is one
// kind of terminal, so what it reports is spelled once.
export function sessionEnv(claudeDir: string): NodeJS.ProcessEnv {
  return {
    CLAUDE_CONFIG_DIR: claudeDir,
    TERM: "xterm-ghostty",
    TERM_PROGRAM: "ghostty",
    COLORTERM: "truecolor",
  };
}
