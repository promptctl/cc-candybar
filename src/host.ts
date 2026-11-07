import os from "node:os";
import { homeOf, type RendererHome } from "./daemon/home.js";
import type { Dialer } from "./dial/dialer.js";
import { systemDialer } from "./dial/system-dialer.js";
import type { Filesystem } from "./disk/filesystem.js";
import { systemFilesystem } from "./disk/system-filesystem.js";
import type { OneShotLauncher } from "./proc/launch.js";
import { systemOneShotLauncher } from "./proc/system-launcher.js";
import { systemTimekeeper, type Timekeeper } from "./time.js";

// [LAW:effects-at-boundaries] What a process knows of the machine it runs on,
// read once by its main and handed down as a value: the environment, the home
// directory, the temporary directory and the process that ran it. In-process code reads `home` and `tmp`
// from here and never from `env`, so the two cannot disagree inside src; `env`
// keeps both for the children that inherit it. A test builds one by hand
// instead of writing `process.env`.
export interface Host {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly home: string;
  readonly tmp: string;
  // The pid of the process that ran this one: Claude Code, for a statusline.
  readonly parentPid: number;
}

// What a process main hands every subcommand it runs: the machine's facts, the
// renderer home this process serves or reaches (parsed from the environment
// once, src/daemon/home.ts), the launcher over them (so a child inherits the
// same environment the process itself reads), the machine's clock, which
// real children and real files run on, the dialer a client reaches its
// daemon through, and the disk it reads and writes.
export interface World {
  readonly host: Host;
  readonly home: RendererHome;
  readonly launcher: OneShotLauncher;
  readonly clock: Timekeeper;
  readonly dialer: Dialer;
  readonly filesystem: Filesystem;
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
    parentPid: process.ppid,
  };
  const clock = systemTimekeeper;
  return {
    host,
    home: processHome(host),
    launcher: systemOneShotLauncher({ inherited: process.env }, clock),
    clock,
    dialer: systemDialer,
    filesystem: systemFilesystem,
  };
}

// [LAW:parse-dont-validate] A home the environment misstates refuses the
// process here, before any entry derives a path from it, in one line naming
// the rule, as the Rust client refuses the same input. Every entry (the CLI,
// the demo, the gallery) builds its world here, so the refusal
// is spoken once and the same way; there is no world yet to report through.
function processHome(host: Host): RendererHome {
  try {
    return homeOf(host);
  } catch (error) {
    process.stderr.write(
      `cc-candybar: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
