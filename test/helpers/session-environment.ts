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

// A session's children get this environment whole. Where a machine keeps its
// tools is the machine's fact, so its PATH is the worker's; its Claude
// directory is the empty one test/setup.ts made. Nothing else of the worker's
// reaches a session.
export const TEST_ENV: Environment = Object.freeze({
  PATH: workerVariable("PATH"),
  CLAUDE_CONFIG_DIR: workerVariable("CLAUDE_CONFIG_DIR"),
});

function workerVariable(name: string): string {
  const value = process.env[name];
  if (value === undefined)
    throw new Error(`the test worker has no ${name} for its sessions`);
  return value;
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
