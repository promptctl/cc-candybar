// Specifiers here carry no `.js`: Jest's global teardown loads this module
// through the test helpers with plain Node resolution, which has no mapping
// from `./x.js` to `./x.ts`.
import os from "node:os";
import type { OneShotLauncher } from "./proc/launch";
import {
  withheldFor,
  type RepositoryLocalEnv,
} from "./proc/repository-local-env";
import { systemAdmittable } from "./proc/system-launcher";
import { systemTimekeeper, type Timekeeper } from "./time";
import type { Host } from "./host-facts";

// [LAW:effects-at-boundaries] The machine's facts (src/host-facts.ts), read
// once below by a process main and handed down as a value.
export type { Host };

// What a process main hands every subcommand it runs: the machine's facts, the
// launcher over them (whose children inherit the environment the process
// itself reads, less what an admitted world withholds) and the machine's
// clock, which real children and real files run on.
export interface World {
  readonly host: Host;
  readonly launcher: OneShotLauncher;
  readonly clock: Timekeeper;
}

const WITHHOLD: unique symbol = Symbol("withhold");
const ADMITTED: unique symbol = Symbol("admitted");

// [LAW:types-are-the-program] The world as a process main builds it, before
// anything is admitted. Its launcher withholds nothing, and the one way to
// make that same launcher withhold names sits under a key only this module
// can name, so admission alone reaches it.
export interface StartedWorld extends World {
  readonly [WITHHOLD]: (names: readonly string[]) => OneShotLauncher;
}

// [LAW:types-are-the-program] A world whose children read repositories by
// directory: its launcher withholds what `answer` says to (withheldFor). Only
// `admit` makes one, so a daemon or a clone handed one cannot be handed the
// world it was made from.
export interface AdmittedWorld extends World {
  readonly answer: RepositoryLocalEnv;
  readonly [ADMITTED]: true;
}

// [LAW:effects-at-boundaries] A started world over `host`: its launcher's
// children inherit `host.env`. A process main's, and a test's world over a
// host it states.
export function startWorld(host: Host, clock: Timekeeper): StartedWorld {
  const { launcher, withhold } = systemAdmittable(
    { inherited: host.env },
    clock,
  );
  return { host, clock, launcher, [WITHHOLD]: withhold };
}

// [LAW:single-enforcer] The one admission: the started world's own launcher
// (its limits, its lifeline) withholding what git's answer says to. Its main
// asks git (askGit) and hands the answer here.
export function admit(
  started: StartedWorld,
  answer: RepositoryLocalEnv,
): AdmittedWorld {
  return {
    host: started.host,
    clock: started.clock,
    launcher: started[WITHHOLD](withheldFor(answer)),
    answer,
    [ADMITTED]: true,
  };
}

// [LAW:single-enforcer] The one place src reads the process's environment, home
// and temporary directory (besides the preload's own main, which runs apart
// from the rest). The eslint config keeps every other file from naming them.
// The launcher holds the live `process.env`, not a copy, so a variable the
// process sets after this still reaches the children it launches. This is also
// the one file that names the real clock (src/time.ts): everything else is
// handed the world's.
export function processWorld(): StartedWorld {
  return startWorld(
    { env: process.env, home: os.homedir(), tmp: os.tmpdir() },
    systemTimekeeper,
  );
}
