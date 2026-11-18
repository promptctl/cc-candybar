// The lane edge's `claude` runs in the session's environment, the one its
// client reported, never the daemon's (src/daemon/foundations/session-env.ts),
// and runs nothing for a session whose environment the host does not hold.

import { productionLaneEdge } from "../src/daemon/lane-edge";
import {
  NOT_HEARD,
  type SessionEnvironment,
} from "../src/daemon/foundations/session-env";
import { exits } from "../src/proc/spawner-fake";
import { processProbe } from "./helpers/host";
import { fakeLauncher } from "./helpers/fake-launcher";
import { systemTimekeeper } from "../src/time";
import { sessionIdOf } from "../src/daemon/foundations/session-id";
import { UNREACHED_CLAUDE_INPUT } from "./helpers/claude-input";

const S = sessionIdOf("s");

function edgeIn(environment: SessionEnvironment) {
  const fake = fakeLauncher(systemTimekeeper, {
    inherited: { PATH: "/daemon/bin", DAEMON_ONLY: "1" },
  });
  fake.spawner.program((bin) => bin === "claude", exits(0));
  const edge = productionLaneEdge(
    fake.launcher,
    () => new Set(),
    new AbortController().signal,
    systemTimekeeper,
    processProbe,
    (session) => (session === S ? environment : NOT_HEARD),
    UNREACHED_CLAUDE_INPUT,
  );
  return { edge, fake };
}

describe("the lane edge's claude", () => {
  test("starts from the session's environment, none of the daemon's", async () => {
    const session = { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: "/u/.claude-z" };
    const { edge, fake } = edgeIn({ kind: "ok", value: session });
    await edge.claude(["plugin", "list"], S);
    const [spawned] = fake.started();
    expect(spawned?.args).toEqual(["plugin", "list"]);
    expect(spawned?.options.env).toEqual(session);
  });

  test("runs nothing for a session whose environment the host does not hold, and says why", async () => {
    const { edge, fake } = edgeIn(NOT_HEARD);
    await expect(edge.claude(["plugin", "list"], S)).rejects.toThrow(
      /^claude plugin list not run: the daemon holds no request from this session/,
    );
    expect(fake.started()).toEqual([]);
  });
});
