// [LAW:effects-at-boundaries] A fixture reports its own environment, separate
// from the daemon's or the Jest worker's. A case that tests an environment
// variable names it in that session's request.

import {
  variableOf,
  type Environment,
  type SessionEnvironment,
} from "../../src/daemon/foundations/session-env";
import { NOTHING_READ, type HostReadings } from "../../src/dsl/view-source";
import { instantOf } from "../../src/utils/instant";

// The shell fixtures use system tools such as cat and wc on Linux and macOS.
export const TEST_ENV = Object.freeze({ PATH: "/usr/bin:/bin" });

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
