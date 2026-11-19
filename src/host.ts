import os from "node:os";
import type { OneShotLauncher } from "./proc/launch";
import { whyFailed } from "./proc/launcher";
import { systemOneShotLauncher } from "./proc/system-launcher";
import { systemTimekeeper, type Timekeeper } from "./time";
import type { DroppedEnv, Host } from "./host-facts";

// [LAW:effects-at-boundaries] The machine's facts (src/host-facts.ts), read
// once below by a process main and handed down as a value.
export type { DroppedEnv, Host };

// What a process main hands every subcommand it runs: the machine's facts, the
// launcher over them (so a child inherits the same environment the process
// itself reads) and the machine's clock, which real children and real files run
// on.
export interface World {
  readonly host: Host;
  readonly launcher: OneShotLauncher;
  readonly clock: Timekeeper;
}

// The machine as a process finds it, before its world is built: `env` is the
// one its children will inherit, which the build changes in place.
export interface Machine {
  readonly env: NodeJS.ProcessEnv;
  readonly home: string;
  readonly tmp: string;
}

// [LAW:one-source-of-truth] git names the variables that locate a repository
// ahead of the working directory (`git rev-parse --local-env-vars`). This is
// its list as of git 2.50, which stands in only when git cannot say.
const GIT_LOCAL_ENV_VARS = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
];
// gh reads the repository from here ahead of the checkout's remote.
const FORGE_REPO_VAR = "GH_REPO";
const ASK = ["rev-parse", "--local-env-vars"];
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// [LAW:parse-dont-validate] git's answer, or why it is none: a git too old to
// know the flag exits 0 and prints the flag back, so every line must be a
// variable's name.
function gitNames(
  launcher: OneShotLauncher,
): { readonly names: readonly string[] } | { readonly fault: string } {
  const run = launcher.launchSync({
    bin: "git",
    args: ASK,
    timeoutMs: 5000,
    category: "host.git",
  });
  const asked = `\`git ${ASK.join(" ")}\``;
  if (!run.ok) return { fault: `${asked} ${whyFailed(run)}` };
  const lines = run.stdout.split("\n").filter((line) => line !== "");
  const odd = lines.find((line) => !VARIABLE_NAME.test(line));
  if (lines.length === 0) return { fault: `${asked} named no variable` };
  if (odd !== undefined)
    return {
      fault: `${asked} answered ${JSON.stringify(odd)}, which is no variable's name`,
    };
  return { names: lines };
}

// [LAW:single-enforcer] The one place a process's environment stops locating
// a repository: every child the process launches inherits `machine.env`, so a
// git or gh read, the renderer, a plugin clone each find their repository from
// their working directory, never from the shell that started the process.
// Settled once, before anything launches; what it removed is the host's
// `dropped`, which every report of it reads.
export function settledHost(machine: Machine, launcher: OneShotLauncher): Host {
  const answer = gitNames(launcher);
  const fault =
    "fault" in answer
      ? `${answer.fault}, so a fixed list of the variables that locate a repository was unset, which may miss one this git reads`
      : null;
  const names = [
    ...("names" in answer ? answer.names : GIT_LOCAL_ENV_VARS),
    FORGE_REPO_VAR,
  ];
  const values: Record<string, string> = {};
  for (const name of names) {
    const value = machine.env[name];
    if (value !== undefined) values[name] = value;
    delete machine.env[name];
  }
  return { ...machine, dropped: { names, values, fault } };
}

// [LAW:single-enforcer] The one place src reads the process's environment, home
// and temporary directory (besides the preload's own main, which runs apart
// from the rest, and execs a session's Claude Code with the session's
// environment). The eslint config keeps every other file from naming them.
// The launcher holds the live `process.env`, not a copy, so the drop above and
// a variable the process sets after this both reach the children it launches.
// This is also the one file that names the real clock (src/time.ts):
// everything else is handed the world's.
export function processWorld(): World {
  const clock = systemTimekeeper;
  const launcher = systemOneShotLauncher({ inherited: process.env }, clock);
  const host = settledHost(
    { env: process.env, home: os.homedir(), tmp: os.tmpdir() },
    launcher,
  );
  return { host, launcher, clock };
}
