import os from "node:os";
import { createOneShotLauncher, type OneShotLauncher } from "./proc/launch.js";

// [LAW:effects-at-boundaries] What a process knows of the machine it runs on,
// read once by its main and handed down as a value: the environment, the home
// directory and the temporary directory. In-process code reads `home` and `tmp`
// from here and never from `env`, so the two cannot disagree inside src; `env`
// keeps both for the children that inherit it. A test builds one by hand
// instead of writing `process.env`.
export interface Host {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly home: string;
  readonly tmp: string;
}

// What a process main hands every subcommand it runs: the machine's facts and
// the launcher over them, so a child inherits the same environment the process
// itself reads.
export interface World {
  readonly host: Host;
  readonly launcher: OneShotLauncher;
}

// [LAW:single-enforcer] The one place src reads the process's environment, home
// and temporary directory (besides the preload's own main, which runs apart
// from the rest). The eslint config keeps every other file from naming them.
// The launcher holds the live `process.env`, not a copy, so a variable the
// process sets after this still reaches the children it launches.
export function processWorld(): World {
  const host: Host = {
    env: process.env,
    home: os.homedir(),
    tmp: os.tmpdir(),
  };
  return { host, launcher: createOneShotLauncher({ inherited: process.env }) };
}
