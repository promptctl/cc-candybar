// The repository variables: the ones that locate a repository, which a process
// whose children read a session's repository keeps from them.
//
// git finds its repository from the variables `git rev-parse --local-env-vars`
// prints ahead of its working directory, and `gh` honours GH_REPO. A process
// started from a git hook, a `rebase --exec` or a vcsh shell carries them, so
// its children would read that shell's repository for every session.

import type { OneShotLauncher, TestableLauncher } from "./launch";
import {
  failureText,
  type LaunchOpts,
  type LaunchResult,
  type StandingFault,
} from "./launcher";

// [LAW:types-are-the-program] git's answer: the repository variables it names,
// or why it named none.
export type RepositoryVars =
  | { readonly kind: "named"; readonly names: readonly string[] }
  | { readonly kind: "unknown"; readonly reason: string };

const ASK = ["rev-parse", "--local-env-vars"] as const;
const ASKED = `\`git ${ASK.join(" ")}\``;

// A daemon's boot blocks on the ask, and a client that finds no daemon spawns
// another once SPAWN_COOLDOWN_MS (src/daemon/acquire.ts) has passed, so the ask
// gives up well inside that cooldown; a test holds the relation. git answers
// from memory, so a git still silent by then is hung.
export const ASK_TIMEOUT_MS = 2000;

// [LAW:one-source-of-truth] The forge's repository variable, which git does
// not name, so a reader withholds it whatever git answers.
const FORGE_VARS = ["GH_REPO"] as const;

// A POSIX variable name: anything else on a line is not a name, such as the
// flag itself, which a git too old to know it echoes back.
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// [LAW:parse-dont-validate] git's answer, one name per line. Every git that
// knows the flag names at least GIT_DIR, so an empty answer is a fault too.
export function parseLocalEnvVars(stdout: string): RepositoryVars {
  const lines = stdout.split("\n").filter((line) => line !== "");
  const stray = lines.find((line) => !VARIABLE_NAME.test(line));
  if (stray !== undefined)
    return {
      kind: "unknown",
      reason: `${ASKED} answered ${JSON.stringify(stray)}, which is no variable name`,
    };
  return lines.length === 0
    ? { kind: "unknown", reason: `${ASKED} named no variable` }
    : { kind: "named", names: lines };
}

// [LAW:single-enforcer] The one wording of git's unknown answer, wherever it
// shows: the bar's ⚠, the daemon's log, plugin install's refusal.
export const repositoryVarsFault = (reason: string): string =>
  `git may read the repository this process was started in rather than a session's: ${reason}`;

// What a launcher's children that inherit the process's environment do not
// get, and the faults that stand because of it. A plain launcher withholds
// nothing.
export interface Withholding {
  withheld(): readonly string[];
  faults(): readonly StandingFault[];
}

export const WITHHOLDS_NOTHING: Withholding = {
  withheld: () => [],
  faults: () => [],
};

// [LAW:single-enforcer] The one owner of git's answer: asked on first read,
// once, and held for the launcher's lifetime. Every later launch and every
// reader reads the held answer. Its private field makes the type nominal, so
// only `askOnce` makes one and no caller can hand a reader an answer git never
// gave.
class AskedOnce implements Withholding {
  #held: RepositoryVars | undefined;

  // `launch` runs git in an environment of its own, so the ask never reads
  // the answer it is making.
  constructor(
    private readonly launch: (opts: LaunchOpts) => LaunchResult,
    private readonly timeoutMs: number,
  ) {}

  answer(): RepositoryVars {
    if (this.#held !== undefined) return this.#held;
    const run = this.launch({
      bin: "git",
      args: [...ASK],
      timeoutMs: this.timeoutMs,
      category: "repository-vars",
    });
    this.#held = run.ok
      ? parseLocalEnvVars(run.stdout)
      : { kind: "unknown", reason: `${ASKED} failed (${failureText(run)})` };
    return this.#held;
  }

  withheld(): readonly string[] {
    const vars = this.answer();
    return [...FORGE_VARS, ...(vars.kind === "named" ? vars.names : [])];
  }

  faults(): readonly StandingFault[] {
    const vars = this.answer();
    return vars.kind === "named"
      ? []
      : [
          {
            kind: "standing",
            source: "repository-vars",
            message: repositoryVarsFault(vars.reason),
          },
        ];
  }
}

export type RepositoryVarsAnswer = AskedOnce;

export const askOnce = (
  launch: (opts: LaunchOpts) => LaunchResult,
  timeoutMs: number,
): RepositoryVarsAnswer => new AskedOnce(launch, timeoutMs);

// [LAW:types-are-the-program] A launcher whose children read a session's
// repository: it withholds the repository variables, and owns git's answer.
export interface ReaderLauncher extends TestableLauncher, OneShotLauncher {
  readonly repositoryVars: RepositoryVarsAnswer;
}
