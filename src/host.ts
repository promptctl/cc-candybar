import os from "node:os";
import { homeOf, type RendererHome } from "./daemon/home.js";
import {
  processIdentityOf,
  startTimeLaunch,
  startTimeOf,
  type ParsedProcessIdentity,
} from "./daemon/process-fingerprint.js";
import type { Dialer } from "./dial/dialer.js";
import type { GitEnvAsk } from "./git-env.js";
import { systemDialer } from "./dial/system-dialer.js";
import type { Filesystem } from "./disk/filesystem.js";
import { systemFilesystem } from "./disk/system-filesystem.js";
import type { OneShotLauncher } from "./proc/launch.js";
import { systemOneShotLauncher } from "./proc/system-launcher.js";
import { systemTimekeeper, type Timekeeper } from "./time.js";

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

// What a process main hands every subcommand it runs: the machine's facts, the
// renderer home this process serves or reaches (parsed from the environment
// once, src/daemon/home.ts), the launcher over them (so a child inherits the
// same environment the process itself reads), the machine's clock, which
// real children and real files run on, the dialer a client reaches its
// daemon through, a read of the process that ran this one (Claude Code,
// for a statusline), which only a client reporting its hints asks for, and
// the disk it reads and writes.
export interface World {
  readonly host: Host;
  readonly home: RendererHome;
  readonly launcher: OneShotLauncher;
  readonly clock: Timekeeper;
  readonly dialer: Dialer;
  // `budgetMs` is the caller's: a statusline tick has a connect's worth, a
  // process that reads once for its whole life has a daemon read's.
  readonly parent: (budgetMs: number) => ParsedProcessIdentity;
  readonly filesystem: Filesystem;
}

// The longest a statusline tick waits to learn when the process that ran it
// started: a `ps` before the connect, inside the tick's total budget, so
// bounded like that connect (CONNECT_TIMEOUT_MS, src/daemon/protocol.ts).
export const TICK_PARENT_START_BUDGET_MS = 50;

// [LAW:single-enforcer] The one place src reads the process's environment, home
// and temporary directory (besides the preload's own main, which runs apart
// from the rest). The eslint config keeps every other file from naming them.
// Every subcommand's world holds the live `process.env`, not a copy, so a
// variable the process sets after this still reaches the children it
// launches; the daemon's (`daemonWorld`) holds a copy taken once at its boot.
// This is also the one file that names the real clock (src/time.ts):
// everything else is handed the world's.
export function processWorld(): World {
  return worldOver(process.env);
}

// [LAW:single-enforcer] The daemon's world: the process environment less the
// variables git reads as locating a repository, as git named them at boot
// (src/git-env.ts). The daemon's environment is whichever shell spawned it, so
// a `GIT_DIR` there (a hook, vcsh, yadm) would point every session's git reads
// at that shell's repository. Its host and its launcher hold the same copy, so
// the daemon and every child it launches see one environment. An ask that
// failed has nothing to drop by: the environment is kept as inherited, and the
// daemon says so on every bar.
export function daemonWorld(gitEnv: GitEnvAsk): World {
  return worldOver(daemonEnv(process.env, gitEnv));
}

// `env` less each variable git named, and nothing else changed: a failed ask
// names none.
export function daemonEnv(
  env: Readonly<NodeJS.ProcessEnv>,
  gitEnv: GitEnvAsk,
): NodeJS.ProcessEnv {
  const kept = { ...env };
  for (const name of gitEnv.kind === "asked" ? gitEnv.names : [])
    delete kept[name];
  return kept;
}

function worldOver(env: NodeJS.ProcessEnv): World {
  const clock = systemTimekeeper;
  const launcher = systemOneShotLauncher({ inherited: env }, clock);
  const host: Host = {
    env,
    home: os.homedir(),
    tmp: os.tmpdir(),
  };
  return {
    host,
    home: processHome(host),
    launcher,
    clock,
    dialer: systemDialer,
    // [LAW:no-silent-failure] Bounded by its caller, so a slow `ps` costs a
    // tick no more than a slow daemon would: one that runs out reads as a
    // start not known, with why, which the daemon says
    // (src/daemon/session-pane.ts).
    parent: (budgetMs) =>
      processIdentityOf(
        process.ppid,
        startTimeOf(
          launcher.launchSync(startTimeLaunch(process.ppid, budgetMs)),
        ),
      ),
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
