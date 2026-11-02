import os from "node:os";
import { locations } from "../../src/daemon/paths";
import type { Host, World } from "../../src/host";
import { createOneShotLauncher } from "../../src/proc/launch";
import { systemTimekeeper } from "../../src/time";

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

// A process main's world over `host`: its launcher's children inherit `host.env`.
export function worldOf(host: Host): World {
  return {
    host,
    launcher: createOneShotLauncher({ inherited: host.env }, systemTimekeeper),
    clock: systemTimekeeper,
  };
}

export const WORLD: World = worldOf(HOST);

// The launcher a test that spawns for real holds: the worker's own world's.
export const processLauncher = WORLD.launcher;

// Where config and plugins live for this worker's host, read when asked.
export const locs = () => locations(HOST);
