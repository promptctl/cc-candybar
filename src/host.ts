import os from "node:os";
import type { OneShotLauncher } from "./proc/launch.js";
import { systemOneShotLauncher } from "./proc/system-launcher.js";
import { systemTimekeeper, type Timekeeper } from "./time.js";
import type { Host } from "./host-facts.js";

// [LAW:effects-at-boundaries] The machine's facts (src/host-facts.ts), read
// once below by a process main and handed down as a value.
export type { Host };

// What a process main hands every subcommand it runs: the machine's facts, the
// launcher over them (so a child inherits the same environment the process
// itself reads) and the machine's clock, which real children and real files run
// on.
export interface World {
  readonly host: Host;
  readonly launcher: OneShotLauncher;
  readonly clock: Timekeeper;
}

// [LAW:single-enforcer] The one place src reads the process's environment, home
// and temporary directory (besides the preload's own main, which runs apart
// from the rest). The eslint config keeps every other file from naming them.
// The launcher holds the live `process.env`, not a copy, so a variable the
// process sets after this still reaches the children it launches. This is also
// the one file that names the real clock (src/time.ts): everything else is
// handed the world's.
export function processWorld(): World {
  const host: Host = {
    env: process.env,
    home: os.homedir(),
    tmp: os.tmpdir(),
  };
  const clock = systemTimekeeper;
  return {
    host,
    launcher: systemOneShotLauncher({ inherited: process.env }, clock),
    clock,
  };
}
