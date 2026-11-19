import os from "node:os";
import { locations } from "../../src/daemon/paths";
import type { Host, World } from "../../src/host";
import { systemOneShotLauncher } from "../../src/proc/system-launcher";
import type { TestableLauncher } from "../../src/proc/launch";
import { systemProbe } from "../../src/daemon/process-fingerprint";
import { systemTimekeeper } from "./system-clock";

declare global {
  function releaseTestFixture(release: () => Promise<void>): void;
}

// [LAW:effects-at-boundaries] The machine a test runs on, as src is handed it:
// this worker's own environment, home and temporary directory. A test that
// means to be isolated builds its own with `hostOf`, naming only the variables
// it cares about, instead of writing `process.env`.
export const HOST: Host = {
  env: process.env,
  home: os.homedir(),
  tmp: os.tmpdir(),
};

// A host over the environment a test states. Its home and temporary directory
// are the test's unless it names them.
export function hostOf(
  env: NodeJS.ProcessEnv,
  rest: Partial<Pick<Host, "home" | "tmp">> = {},
): Host {
  return { env, home: rest.home ?? HOST.home, tmp: rest.tmp ?? HOST.tmp };
}

const fixtureLaunchers: Array<{
  owner: AbortController;
  launcher: TestableLauncher;
}> = [];

// A real launcher belongs to this module's runtime. Async launches keep a
// lifeline open until their owner ends, even after every child has returned.
export function fixtureLauncher(inherited: NodeJS.ProcessEnv) {
  const owner = new AbortController();
  const launcher = systemOneShotLauncher(
    { inherited, signal: owner.signal },
    systemTimekeeper,
  );
  fixtureLaunchers.push({ owner, launcher });
  return launcher;
}

export async function releaseFixtureLaunchers(): Promise<void> {
  const releases = fixtureLaunchers.splice(0);
  for (const { owner } of releases) owner.abort();
  const settled = await Promise.all(releases.map(({ launcher }) => launcher.settled()));
  const unreaped = settled.flatMap((result) => result.unreaped);
  if (unreaped.length > 0)
    throw new Error(`Fixture launches still running: ${unreaped.join(", ")}`);
}

// Jest gives each file a separate runtime and releases it after the last
// hook. The runner's global teardown imports this module in its own runtime
// and calls releaseFixtureLaunchers itself.
if (typeof releaseTestFixture === "function")
  releaseTestFixture(releaseFixtureLaunchers);

// A process main's world over `host`: its launcher's children inherit `host.env`.
export function worldOf(host: Host): World {
  return {
    host,
    launcher: fixtureLauncher(host.env),
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
