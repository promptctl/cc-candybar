// [LAW:single-enforcer] The one environment a program the host runs for a
// session starts from: the environment the session's client reported, which
// is the one Claude Code gave it, with the session's facts laid over it. The
// host is detached, so its own environment is whichever shell spawned it, and
// wrong for every other session (.claude/memory/architecture.md).

import type { SessionId } from "./session-id";
import { ABSENT, ok, type Asked, type Outcome } from "../../utils/outcome";
import { CLAUDE_CONFIG_DIR_ENV } from "../../claude-settings";

// A process environment as plain data: its set variables.
export type Environment = Readonly<Record<string, string>>;

// [LAW:one-source-of-truth] A process's environment as it crosses a process:
// its set variables, since JSON drops an unset one's `undefined`.
export function plainEnvironment(
  env: Readonly<NodeJS.ProcessEnv>,
): Environment {
  return Object.fromEntries(
    Object.entries(env).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, value]],
    ),
  );
}

// [LAW:single-enforcer] One variable of an environment: its value, or absent
// when it is unset. Own keys only, so a name like `constructor` reads unset.
export function variableOf(env: Environment, name: string): Outcome<string> {
  return Object.hasOwn(env, name) ? ok(env[name]!) : ABSENT;
}

// [LAW:types-are-the-program] What the host holds of a session's environment:
// the one its newest request reported, or why it holds none. A session the
// host knows only from its book, or one whose client is too old to report it,
// has no environment to run a program in, and the host's own is never one.
export type SessionEnvironment = Asked<Environment>;

// The reason the book holds no environment for a session: the host never
// writes one to disk, since it carries keys and tokens, and drops a session's
// with the rest of it when the book's bound drops the session.
export const NOT_HEARD: SessionEnvironment = {
  kind: "failed",
  reason:
    "the daemon holds no request from this session, so its environment is not known: none has arrived since the daemon started, or the session was among the oldest of more sessions than the daemon keeps",
};

// What the host knows of a session that a program run for it reads from its
// environment: its id, its project directory (from the hook JSON), and the
// Claude Code directory its client reported — undefined when its Claude Code
// runs under the default directory.
export interface SessionFacts {
  readonly sessionId: SessionId;
  readonly projectDir: string;
  readonly claudeConfigDir: string | undefined;
}

// The reported variables the host never passes on. The client resolved the
// Claude Code directory to an absolute path, which wins over the variable it
// read. tmux hands a closed pane's id to the next pane opened, and the host
// holds a session's environment past the client that reported it, so a run
// started from it after its pane closed would name another pane.
const NOT_PASSED_ON: readonly string[] = [
  CLAUDE_CONFIG_DIR_ENV,
  "TMUX",
  "TMUX_PANE",
];

// The session's facts over its reported environment; a default Claude Code
// directory is the variable unset.
export function sessionEnvironment(
  reported: Environment,
  facts: SessionFacts,
): Environment {
  return {
    ...Object.fromEntries(
      Object.entries(reported).filter(
        ([name]) => !NOT_PASSED_ON.includes(name),
      ),
    ),
    CLAUDE_CODE_SESSION_ID: facts.sessionId,
    CLAUDE_PROJECT_DIR: facts.projectDir,
    ...(facts.claudeConfigDir !== undefined && {
      [CLAUDE_CONFIG_DIR_ENV]: facts.claudeConfigDir,
    }),
  };
}
