import os from "node:os";
import { locations } from "../../src/daemon/paths";
import {
  startWorld,
  type Host,
  type StartedWorld,
  type World,
} from "../../src/host";
import {
  createLauncher,
  createOneShotLauncher,
  type LaunchOwner,
  type OneShotLauncher,
  type TestableLauncher,
} from "../../src/proc/launch";
import { systemSpawner } from "../../src/proc/spawner";
import { systemProbe } from "../../src/daemon/process-fingerprint";
import { systemTimekeeper, type Timekeeper } from "../../src/time";

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
export const worldOf = (host: Host): StartedWorld =>
  startWorld(host, systemTimekeeper);

// A one-shot launcher over this machine, whose children inherit what `owner`
// names and which withholds nothing.
export const systemOneShotLauncher = (
  owner: LaunchOwner,
  clock: Timekeeper,
): TestableLauncher & OneShotLauncher =>
  createOneShotLauncher(owner, clock, systemSpawner);

// A launcher for an owner over this machine, whose children inherit what
// `owner` names: what a daemon's own launcher is, made without a daemon.
export const systemLauncher = (
  owner: LaunchOwner,
  clock: Timekeeper,
): TestableLauncher => createLauncher(owner, clock, systemSpawner);

export const WORLD: World = worldOf(HOST);

// The launcher a test that spawns for real holds: the worker's own world's.
export const processLauncher = WORLD.launcher;

// The probe a test that means real processes holds: this worker's own machine.
export const processProbe = systemProbe(processLauncher);

// Where config and plugins live for this worker's host, read when asked.
export const locs = () => locations(HOST);
