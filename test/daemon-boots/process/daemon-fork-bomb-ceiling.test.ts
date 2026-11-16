import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  prepareIsolatedDaemonEnv,
  spawnDaemonWithEnv,
  type IsolatedDaemonEnv,
} from "../../helpers/spawn-isolated-daemon";
import {
  listRegistryFiles,
  readRegistryEntry,
} from "../../../src/daemon/fork-bomb-breaker";
import {
  sameLiveProcess,
  systemProbe,
  type ProcessIdentity,
} from "../../../src/daemon/process-fingerprint";
import { systemLauncher } from "../../../src/proc/system-launcher";
import { systemTimekeeper } from "../../../src/time";
import { until } from "../../helpers/until";

// [LAW:verifiable-goals] Integration proof for the daemon-side fork-bomb
// circuit breaker (brandon-daemon-lifecycle-gad.2): with a real, tiny ceiling
// and a real registry directory on disk, the (ceiling+1)th isolated daemon
// must refuse to boot — exiting with failure, never binding its own socket —
// and a dead sibling's stale registry entry must not permanently occupy a
// ceiling slot. The pure decision logic (decideBoot/countLiveEntries/
// admitDaemon) is exhaustively unit-tested in fork-bomb-breaker.test.ts; this
// file is the wiring proof and doubles as the CI regression gate the ticket's
// acceptance asks for ("a regression that lets the count run away fails CI").
//
// [LAW:one-source-of-truth] Every daemon boots through the suite's one
// isolated-daemon helper, so its readiness budget, and its diagnosis of a
// refusal (how far the socket got, how the process ended, the daemon's own
// log and stderr), are the suite's. How long a boot takes measures the
// machine's load, not the breaker, so nothing here times one.

const CEILING = 2;

// The registry this test's daemons share, and each daemon's environment
// pointed at it under the tiny ceiling.
const registryDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "ccb-breaker-registry-"),
);
const fixtures: IsolatedDaemonEnv[] = [];
function fixture(): IsolatedDaemonEnv {
  const isolated = prepareIsolatedDaemonEnv("ccb-breaker");
  fixtures.push(isolated);
  return {
    ...isolated,
    env: {
      ...isolated.env,
      CC_CANDYBAR_DAEMON_REGISTRY_DIR: registryDir,
      CC_CANDYBAR_DAEMON_CEILING: String(CEILING),
    },
  };
}

afterAll(() => {
  for (const { removeTmpDirs } of fixtures) removeTmpDirs();
  fs.rmSync(registryDir, { recursive: true, force: true });
});

// Who the registry names now: the daemon workers that hold its slots, not
// their tsx wrappers.
const registered = (): ProcessIdentity[] =>
  listRegistryFiles(registryDir).flatMap((file) => {
    const entry = readRegistryEntry(file);
    return entry === null ? [] : [entry];
  });

// [LAW:one-source-of-truth] Whether an entry still holds its slot, read as the
// breaker reads it: a killed worker stays a zombie, still live, until it is
// reaped, and a reused pid with another start time is not it.
const probe = systemProbe(
  systemLauncher({ inherited: process.env }, systemTimekeeper),
);
const holdsSlot = (entry: ProcessIdentity): Promise<boolean> =>
  sameLiveProcess(entry.pid, entry.startTime, probe);

describe("daemon-side fork-bomb circuit breaker (integration)", () => {
  jest.setTimeout(30_000);

  test("refuses the (ceiling+1)th isolated daemon; a dead sibling's slot is reclaimed", async () => {
    // [LAW:single-enforcer] One cleanup list, run in reverse in a single
    // `finally`, so an assertion's throw mid-test still kills every daemon.
    const cleanups: Array<() => void> = [];
    try {
      const d1 = await spawnDaemonWithEnv(fixture().env);
      cleanups.push(() => d1.killTree());
      const before = registered().map(({ pid }) => pid);
      const d2 = await spawnDaemonWithEnv(fixture().env);
      cleanups.push(() => d2.killTree());
      const added = registered().filter(({ pid }) => !before.includes(pid));
      expect(added).toHaveLength(1);
      const d2Entry = added[0]!;

      // Ceiling is full (2/2 live isolated daemons registered). The 3rd must
      // refuse: the helper's diagnosis says it never bound its socket, exited
      // with code 1, and quotes the daemon's log, which the log writes out
      // as the process exits, saying the breaker refused it.
      // One the breaker wrongly admitted is still a daemon to kill.
      const d3 = spawnDaemonWithEnv(fixture().env);
      d3.then(
        (admitted) => cleanups.push(() => admitted.killTree()),
        () => {},
      );
      await expect(d3).rejects.toThrow(
        /no socket at .*; the process exited \(code 1\)[\s\S]*fork-bomb breaker: .*; refusing to boot/,
      );

      // Kill one of the two admitted daemons WITHOUT its graceful shutdown
      // path (SIGKILL — the runaway/OOM case this epic fights) so its
      // registry entry is left behind as a stale file: the exact condition
      // admitDaemon()'s sweep exists to reclaim.
      d2.killTree();
      await until(
        async () => !(await holdsSlot(d2Entry)),
        `d2's worker (pid ${d2Entry.pid}) gone`,
      );

      // A daemon set up as d3 was boots once a slot is free, and its
      // admission swept d2's stale entry.
      const d4 = await spawnDaemonWithEnv(fixture().env);
      cleanups.push(() => d4.killTree());
      expect(registered().map(({ pid }) => pid)).not.toContain(d2Entry.pid);
    } finally {
      for (const cleanup of cleanups.reverse()) cleanup();
    }
  });
});
