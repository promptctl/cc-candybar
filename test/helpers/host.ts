import { locations } from "../../src/daemon/paths";
import type { Host, World } from "../../src/host";
import { HOST } from "../../scripts/lib/host";
import { systemOneShotLauncher } from "../../src/proc/system-launcher";
import type { LaunchOwner, TestableLauncher } from "../../src/proc/launch";
import { systemProbe } from "../../src/daemon/process-fingerprint";
import { systemTimekeeper } from "../../scripts/lib/system-clock";

// A test file's environment (test/helpers/quarantine-environment.cjs) hands
// its runtime this hook and runs what it is given after the file's last hook.
// Only a test file's runtime loads this module.
declare global {
  function releaseTestFixture(release: () => Promise<void>): void;
}

// [LAW:no-ambient-temporal-coupling] This module's runtime is one test
// file's, and the file's end is its fixture launchers' one owner. Async
// launches keep a lifeline open until their owner ends, even after every child
// has returned, and a worker runs many files.
const fileEnd = new AbortController();
const fixtureLaunchers: TestableLauncher[] = [];

// [LAW:single-enforcer] The one way a test gets a real launcher it does not
// end itself.
export function fixtureLauncher(scope: Omit<LaunchOwner, "signal">) {
  const launcher = systemOneShotLauncher(
    { ...scope, signal: fileEnd.signal },
    systemTimekeeper,
  );
  fixtureLaunchers.push(launcher);
  return launcher;
}

releaseTestFixture(async () => {
  fileEnd.abort();
  const settled = await Promise.all(
    fixtureLaunchers.map((launcher) => launcher.settled()),
  );
  const unreaped = settled.flatMap((result) => result.unreaped);
  if (unreaped.length > 0)
    throw new Error(`Fixture launches still running: ${unreaped.join(", ")}`);
});

// A process main's world over `host`: its launcher's children inherit `host.env`.
export function worldOf(host: Host): World {
  return {
    host,
    launcher: fixtureLauncher({ inherited: host.env }),
    clock: systemTimekeeper,
  };
}

export const WORLD: World = worldOf(HOST);

// The launcher a test that spawns for real holds: the worker's own world's.
export const processLauncher = WORLD.launcher;

// The probe a test that means real processes holds: this worker's own machine.
export const processProbe = systemProbe(processLauncher);

// Where config and plugins live for this worker's host, read when asked.
export const locs = () => locations(HOST);
