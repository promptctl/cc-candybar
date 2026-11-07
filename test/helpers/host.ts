import os from "node:os";
import { HOME_ENV, NAME_ENV, homeOf } from "../../src/daemon/home";
import { locations } from "../../src/daemon/paths";
import { systemDialer } from "../../src/dial/system-dialer";
import type { Host, World } from "../../src/host";
import { systemOneShotLauncher } from "../../src/proc/system-launcher";
import { systemProbe } from "../../src/daemon/process-fingerprint";
import { systemTimekeeper } from "../../src/time";

// [LAW:effects-at-boundaries] The machine a test runs on, as src is handed it:
// this worker's own environment, home and temporary directory. A test that
// means to be isolated builds its own with `hostOf`, naming only the variables
// it cares about, instead of writing `process.env`.
export const HOST: Host = {
  env: process.env,
  home: os.homedir(),
  tmp: os.tmpdir(),
  parentPid: process.ppid,
};

// The worker's environment as a main home reads it: test setup names the
// worker a renderer home of its own, and a named home reads no XDG directory,
// so a test of the main layout that names one over the worker's environment
// states it over this, else the named home wins and the directory is never
// read. Read when asked, as `HOST.env` is: a test that writes `process.env`
// before building its host (a PATH of stubs) is building over what it wrote.
export function mainEnv(): NodeJS.ProcessEnv {
  const { [HOME_ENV]: _home, [NAME_ENV]: _name, ...main } = process.env;
  return main;
}

// A host over the environment a test states. Its home and temporary directory
// are the test's unless it names them.
export function hostOf(
  env: NodeJS.ProcessEnv,
  rest: Partial<Pick<Host, "home" | "tmp">> = {},
): Host {
  return {
    env,
    home: rest.home ?? HOST.home,
    tmp: rest.tmp ?? HOST.tmp,
    parentPid: HOST.parentPid,
  };
}

// A process main's world over `host`: its renderer home is the one its
// environment names, and its launcher's children inherit `host.env`.
export function worldOf(host: Host): World {
  return {
    host,
    home: homeOf(host),
    launcher: systemOneShotLauncher({ inherited: host.env }, systemTimekeeper),
    clock: systemTimekeeper,
    dialer: systemDialer,
  };
}

export const WORLD: World = worldOf(HOST);

// The launcher a test that spawns for real holds: the worker's own world's.
export const processLauncher = WORLD.launcher;

// The probe a test that means real processes holds: this worker's own machine.
export const processProbe = systemProbe(processLauncher);

// Where the worker's home keeps its config, and the host its plugins, read
// when asked.
export const locs = () => locations(HOST, WORLD.home);
