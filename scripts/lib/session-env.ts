import type { Environment } from "../../src/daemon/foundations/session-env";

// [LAW:one-source-of-truth] The environment a fixture session reports, as a
// client reports the one Claude Code gave it: where its tools live, and its
// Claude Code config dir. Nothing else reaches the session's children.
export const reportedEnvironment = (
  PATH: string,
  CLAUDE_CONFIG_DIR: string,
): Environment => Object.freeze({ PATH, CLAUDE_CONFIG_DIR });
