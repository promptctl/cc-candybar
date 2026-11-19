// [LAW:single-enforcer] The one environment a program the host runs for a
// session starts from: the environment the session's client reported, which
// is the one Claude Code gave it, with the session's facts laid over it. The
// host is detached, so its own environment is whichever shell spawned it, and
// wrong for every other session (.claude/memory/architecture.md).

import type { SessionId } from "./session-id";
import { ABSENT, ok, type Asked, type Outcome } from "../../utils/outcome";
import { CLAUDE_CONFIG_DIR_ENV } from "../../claude-settings";
import { digestOf, ownValue } from "../../utils/plain";

// A process environment as plain data: its set variables.
export type Environment = Readonly<Record<string, string>>;

// The native and Node relays identify the same snapshot even for numeric and
// non-ASCII variable names. JSON object and JavaScript string order both differ
// from UTF-8 byte order, so hash an explicitly ordered array of pairs.
export function environmentKey(env: Environment): string {
  const entries = Object.entries(env).map((pair) => ({
    name: Buffer.from(pair[0]),
    pair,
  }));
  entries.sort((a, b) => a.name.compare(b.name));
  return digestOf(entries.map(({ pair }) => pair));
}

// A full report that the host has verified for this session. The projection
// can be reused while the session's project and Claude Code directories agree.
export interface RegisteredEnvironment {
  readonly key: string;
  readonly reported: Environment;
  readonly projectDir: string;
  readonly claudeConfigDir: string | undefined;
  readonly execution: Environment;
}

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
  const value = ownValue(env, name);
  return value === undefined ? ABSENT : ok(value);
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

// The session's facts over its reported environment. The client resolved the
// Claude Code directory to an absolute path, which wins over the variable it
// read; a default directory is the variable unset.
export function sessionEnvironment(
  reported: Environment,
  facts: SessionFacts,
): Environment {
  const { [CLAUDE_CONFIG_DIR_ENV]: _reportedDir, ...rest } = reported;
  return {
    ...rest,
    CLAUDE_CODE_SESSION_ID: facts.sessionId,
    CLAUDE_PROJECT_DIR: facts.projectDir,
    ...(facts.claudeConfigDir !== undefined && {
      [CLAUDE_CONFIG_DIR_ENV]: facts.claudeConfigDir,
    }),
  };
}
