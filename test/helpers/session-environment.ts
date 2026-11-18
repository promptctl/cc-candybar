// The environment a test's session reports: the test process's own, as a
// client started by Claude Code reports the one Claude Code gave it.

import {
  plainEnvironment,
  variableOf,
  type Environment,
  type SessionEnvironment,
} from "../../src/daemon/foundations/session-env";
import { NOTHING_READ, type HostReadings } from "../../src/dsl/view-source";
import { instantOf } from "../../src/utils/instant";

export const TEST_ENV: Environment = plainEnvironment(process.env);

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
