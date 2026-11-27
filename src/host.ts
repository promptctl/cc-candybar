import os from "node:os";
import type { OneShotLauncher } from "./proc/launch.js";
import { systemOneShotLauncher } from "./proc/system-launcher.js";
import {
  clockOver,
  rethrowing,
  systemTimers,
  type Timekeeper,
} from "./time.js";
import { reportingClock, type ReportingClock } from "./daemon/task-throws.js";
import type { Host } from "./host-facts.js";

// [LAW:effects-at-boundaries] The machine's facts (src/host-facts.ts), read
// once below by a process main and handed down as a value.
export type { Host };

// What a process main hands a command that acts on the machine: its facts, the
// launcher over them (so a child inherits the same environment the process
// itself reads) and the machine's clock, which real children and real files run
// on.
export interface World<C extends Timekeeper = Timekeeper> {
  readonly host: Host;
  readonly launcher: OneShotLauncher;
  readonly clock: C;
}

// The machine's readings alone, with nothing to schedule on: for the renderer
// process, whose held work runs on its own turns.
export const machineReadings: Pick<Timekeeper, "now" | "monotonic"> = {
  now: () => systemTimers.now(),
  monotonic: () => systemTimers.monotonic(),
};

// A command's world: what any of its tasks throws ends the process, naming
// the task (`rethrowing`).
export function processWorld(): World {
  return worldOver(clockOver(systemTimers, rethrowing));
}

// [LAW:single-enforcer] The daemon's clock: it carries the inbox its tasks'
// throws land in, so what any of them throws, before the daemon exists too,
// shows on every bar.
export const daemonClock = (): ReportingClock => reportingClock(systemTimers);

export function daemonWorld(): World<ReportingClock> {
  return worldOver(daemonClock());
}

// [LAW:single-enforcer] The one place src reads the process's environment, home
// and temporary directory (besides the preload's own main, which runs apart
// from the rest). The eslint config keeps every other file from naming them.
export const machineHost = (): Host => ({
  env: process.env,
  home: os.homedir(),
  tmp: os.tmpdir(),
});

// A process main has no narrower shutdown signal. Its lifeline ends when the
// process exits. The live environment is resolved separately at each spawn.
function worldOver<C extends Timekeeper>(clock: C): World<C> {
  return {
    host: machineHost(),
    launcher: systemOneShotLauncher(
      { inherited: process.env, signal: AbortSignal.any([]) },
      clock,
    ),
    clock,
  };
}
