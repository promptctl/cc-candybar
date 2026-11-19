import os from "node:os";
import { locations } from "../../src/daemon/paths";
import {
  settledHost,
  type DroppedEnv,
  type Host,
  type Machine,
  type World,
} from "../../src/host";
import { systemOneShotLauncher } from "../../src/proc/system-launcher";
import { systemProbe } from "../../src/daemon/process-fingerprint";
import { systemTimekeeper } from "../../src/time";

// A machine a test states drops nothing from the environment it names.
const NOTHING_DROPPED: DroppedEnv = { names: [], values: {}, fault: null };

// [LAW:single-enforcer] A host as a process builds its own (src/host.ts): the
// machine's environment, settled by asking git through a launcher over that
// same environment, so this host has dropped what a process's would. It runs
// git, so only a tier that may launch real programs builds one.
export function hostOver(machine: Machine): Host {
  return settledHost(
    machine,
    systemOneShotLauncher({ inherited: machine.env }, systemTimekeeper),
  );
}

// [LAW:effects-at-boundaries] The machine a test runs on, as src is handed it:
// this worker's own environment, home and temporary directory. A test that
// means to be isolated builds its own with `hostOf`, naming only the variables
// it cares about, instead of writing `process.env`.
export const HOST: Host = {
  env: process.env,
  home: os.homedir(),
  tmp: os.tmpdir(),
  dropped: NOTHING_DROPPED,
};

// A host over the environment a test states, which drops nothing from it. Its
// home and temporary directory are the test's unless it names them.
export function hostOf(
  env: NodeJS.ProcessEnv,
  rest: Partial<Pick<Host, "home" | "tmp">> = {},
): Host {
  return {
    env,
    home: rest.home ?? HOST.home,
    tmp: rest.tmp ?? HOST.tmp,
    dropped: NOTHING_DROPPED,
  };
}

// A process main's world over `host`: its launcher's children inherit `host.env`.
export function worldOf(host: Host): World {
  return {
    host,
    launcher: systemOneShotLauncher({ inherited: host.env }, systemTimekeeper),
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
