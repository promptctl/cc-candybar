// [LAW:single-enforcer] The one environment a program the daemon runs for a
// session gets: the daemon's own, less every variable that states a session
// fact, plus the facts this session knows. The daemon is detached, so its own
// session variables are whichever shell spawned it, and wrong for every other
// session (.claude/memory/architecture.md).

// The variables that state a session fact. Each is removed from the daemon's
// environment, and set again only from the session's own facts.
const SESSION_FACT_VARIABLES = [
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_CONFIG_DIR",
  "TMUX",
  "TMUX_PANE",
] as const;

// What the daemon knows of a session that a program run for it reads from its
// environment: its id, its project directory (from the hook JSON), and the
// Claude Code directory its client reported — undefined when the client's
// Claude Code runs under the default directory, which a program finds with
// the variable unset. The tmux facts stay unset: a hint carries the pane and
// socket, not a whole `TMUX` value, and a partial one would lie.
export interface SessionFacts {
  readonly sessionId: string;
  readonly projectDir: string;
  readonly claudeConfigDir: string | undefined;
}

export function sessionEnv(
  daemonEnv: NodeJS.ProcessEnv,
  facts: SessionFacts,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...daemonEnv };
  for (const name of SESSION_FACT_VARIABLES) delete env[name];
  return {
    ...env,
    CLAUDE_CODE_SESSION_ID: facts.sessionId,
    CLAUDE_PROJECT_DIR: facts.projectDir,
    ...(facts.claudeConfigDir !== undefined && {
      CLAUDE_CONFIG_DIR: facts.claudeConfigDir,
    }),
  };
}
