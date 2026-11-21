// [LAW:one-source-of-truth] A fixture reports its own environment, separate
// from the daemon's or the Jest worker's, as a client reports the one Claude
// Code gave it. A case that tests an environment variable names it in that
// session's request.

import {
  variableOf,
  type Environment,
  type SessionEnvironment,
} from "../../src/daemon/foundations/session-env";
import { NOTHING_READ, type HostReadings } from "../../src/dsl/view-source";
import { instantOf } from "../../src/utils/instant";

// A session's children get this environment whole, so the shell fixtures
// reach only the system tools, such as cat and wc, that Linux and macOS both
// keep there. Its Claude directory is the empty one test/setup.ts made.
export const TEST_ENV: Environment = Object.freeze({
  PATH: "/usr/bin:/bin",
  CLAUDE_CONFIG_DIR: claudeConfigDir(),
});

function claudeConfigDir(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (dir === undefined)
    throw new Error("test/setup.ts names no empty Claude directory");
  return dir;
}

export const TEST_ENVIRONMENT: SessionEnvironment = {
  kind: "ok",
  value: TEST_ENV,
};

// What a view reads when the host read `env` for its `env` sources and
// nothing else yet.
export function readingsIn(env: Environment): HostReadings {
  return {
    ...NOTHING_READ,
    env: (name) => ({ ...variableOf(env, name), at: instantOf(new Date()) }),
  };
}
