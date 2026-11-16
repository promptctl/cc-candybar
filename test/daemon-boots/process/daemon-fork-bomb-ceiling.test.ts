import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  prepareIsolatedDaemonEnv,
  READINESS_BUDGET_MS,
  spawnDaemonWithEnv,
  type IsolatedDaemonEnv,
  type RunningDaemon,
} from "../../helpers/spawn-isolated-daemon";
import {
  listRegistryFiles,
  readRegistryEntry,
} from "../../../src/daemon/fork-bomb-breaker";
import {
  sameLiveProcess,
  type ProcessIdentity,
} from "../../../src/daemon/process-fingerprint";
import { processProbe } from "../../helpers/host";
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
// isolated-daemon helper, so its readiness budget, its safe socket parent,
// and its diagnosis of a refusal (how far the socket got, how the process
// ended, the daemon's own log and stderr), are the suite's. How long a boot
// takes measures the machine's load, not the breaker, so nothing here times
// one.

const CEILING = 2;

// The registry this test's daemons share.
const registryDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "ccb-breaker-registry-"),
);
const fixtures: IsolatedDaemonEnv[] = [];
// The daemons booted and not yet killed.
const daemons = new Set<RunningDaemon>();

// A daemon's environment, pointed at the shared registry under the tiny
// ceiling.
function fixture(): NodeJS.ProcessEnv {
  const isolated = prepareIsolatedDaemonEnv("ccb-breaker");
  fixtures.push(isolated);
  return {
    ...isolated.env,
    CC_CANDYBAR_DAEMON_REGISTRY_DIR: registryDir,
    CC_CANDYBAR_DAEMON_CEILING: String(CEILING),
  };
}

// A daemon booted on `env`, killed when the file ends however the test did.
// One that never became ready the helper has killed already.
const boot = (env: NodeJS.ProcessEnv): Promise<RunningDaemon> =>
  spawnDaemonWithEnv(env).then((daemon) => {
    daemons.add(daemon);
    return daemon;
  });

// Killed now, and so not again at the end, when its group's id may be
// another's.
const kill = (daemon: RunningDaemon): void => {
  daemons.delete(daemon);
  daemon.killTree();
};

// [LAW:single-enforcer] The one teardown, which jest runs after a timeout too:
// every daemon killed before the directories it runs in are removed.
afterAll(() => {
  for (const daemon of daemons) daemon.killTree();
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

describe("daemon-side fork-bomb circuit breaker (integration)", () => {
  // Four boots, each bounded by the helper's readiness budget, and the
  // reap's wait (until's own budget), so a step
  // that hangs fails by name before the test's timeout.
  jest.setTimeout(4 * READINESS_BUDGET_MS + 5_000);

  test("refuses the (ceiling+1)th isolated daemon; a dead sibling's slot is reclaimed", async () => {
    await boot(fixture());
    const first = registered();
    expect(first).toHaveLength(1);
    const d1Entry = first[0]!;
    const d2 = await boot(fixture());
    const added = registered().filter(({ pid }) => pid !== d1Entry.pid);
    expect(added).toHaveLength(1);
    const d2Entry = added[0]!;

    // Ceiling is full (2/2 live isolated daemons registered). The 3rd must
    // refuse: the helper's diagnosis says it never bound its socket, exited
    // with code 1, and quotes the daemon's log, which the log writes out as
    // the process exits, saying the breaker refused it.
    const d3Env = fixture();
    await expect(boot(d3Env)).rejects.toThrow(
      /no socket at .*; the process exited \(code 1\)[\s\S]*fork-bomb breaker: .*; refusing to boot/,
    );

    // Kill one of the two admitted daemons WITHOUT its graceful shutdown
    // path (SIGKILL — the runaway/OOM case this epic fights) so its
    // registry entry is left behind as a stale file: the exact condition
    // admitDaemon()'s sweep exists to reclaim. It is waited out as the
    // breaker reads it: a killed worker stays a zombie, still live, until it
    // is reaped, and a reused pid with another start time is not it.
    kill(d2);
    await until(
      async () =>
        !(await sameLiveProcess(d2Entry.pid, d2Entry.startTime, processProbe)),
      `d2's worker (pid ${d2Entry.pid}) gone`,
    );

    // d3's own environment boots once a slot is free, so its refusal was the
    // ceiling's; and its admission swept d2's stale entry: the registry
    // names d1 and this one alone.
    await boot(d3Env);
    const now = registered();
    expect(now).toHaveLength(2);
    expect(now).toContainEqual(d1Entry);
    expect(now).not.toContainEqual(d2Entry);
  });
});
