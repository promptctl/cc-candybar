// git's repository-local environment variables: what git reads ahead of its
// working directory to find a repository (a hook's GIT_DIR, a vcsh shell's
// GIT_WORK_TREE, and the rest `git rev-parse --local-env-vars` names). A
// process whose children read a repository by directory (the daemon's git and
// PR reads, `plugin install`'s clone) withholds them from every child that
// inherits its environment, so the shell that happened to start it steers
// nothing. Its main asks once; admission (src/host.ts) builds the launcher.

import type { RepositoryLocalEnvWarning } from "../facts/world-state";
import { FORGE_REPOSITORY_VARS } from "./forge";
import {
  failureText,
  isMissingCommand,
  type Launcher,
  type LaunchResult,
} from "./launcher";

// [LAW:types-are-the-program] git's answer, as a plain value: the names it
// printed (at least one), or the reason it could not answer. Holding one
// launches nothing.
export type RepositoryLocalEnv =
  | { readonly kind: "named"; readonly names: readonly [string, ...string[]] }
  | { readonly kind: "unknown"; readonly reason: string };

// How long the ask may take: a bound, or none at all.
export type AskLimit = { readonly withinMs: number } | "unbounded";

// Who asked, which decides what a git that cannot answer means.
export type Asker = "daemon" | "plugin install";

// A variable name as git prints one. An old git that does not know the flag
// echoes it back with exit 0, which this refuses.
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// [LAW:parse-dont-validate] git's output, or its failure, made the answer.
export function parseRepositoryLocalEnv(
  result: LaunchResult,
): RepositoryLocalEnv {
  if (!result.ok)
    return {
      kind: "unknown",
      reason: isMissingCommand(result) ? "git not found" : failureText(result),
    };
  const [first, ...rest] = result.stdout
    .split("\n")
    .filter((line) => line !== "");
  if (first === undefined)
    return { kind: "unknown", reason: "git named no variables" };
  const names: [string, ...string[]] = [first, ...rest];
  const stray = names.find((line) => !VARIABLE_NAME.test(line));
  return stray === undefined
    ? { kind: "named", names }
    : {
        kind: "unknown",
        reason: `git answered ${JSON.stringify(stray)}, which names no variable`,
      };
}

// [LAW:single-enforcer] The one ask, through the process's own launcher
// before admission. It holds no loop: the daemon serves its clients' cached
// renders and hears its signals while git answers.
export const askGit = async (
  launcher: Pick<Launcher, "launch">,
  limit: AskLimit,
): Promise<RepositoryLocalEnv> =>
  parseRepositoryLocalEnv(
    await launcher.launch({
      bin: "git",
      args: ["rev-parse", "--local-env-vars"],
      environment: "inherited",
      timeoutMs: limit === "unbounded" ? undefined : limit.withinMs,
      category: "repository-local-env",
    }),
  );

// [LAW:one-source-of-truth] What a launcher admitted on `answer` withholds:
// the forges' repository variables always, and what git named.
export const withheldFor = (answer: RepositoryLocalEnv): readonly string[] => [
  ...Object.values(FORGE_REPOSITORY_VARS).flat(),
  ...(answer.kind === "named" ? answer.names : []),
];

const CONSEQUENCE: Readonly<Record<Asker, string>> = {
  daemon:
    "so the branch and PR shown may come from the repository of the shell that started the daemon, until the daemon restarts",
  "plugin install":
    "so a clone could act on the repository of the shell it runs in",
};

// [LAW:single-enforcer] The one wording of a git that could not answer, and
// what that means to whoever asked: the daemon's log and bar, and `plugin
// install`'s refusal.
export const describeUnknown = (
  answer: Extract<RepositoryLocalEnv, { kind: "unknown" }>,
  asker: Asker,
): string =>
  `git could not name its repository-local environment variables: ${answer.reason}, ${CONSEQUENCE[asker]}`;

// The daemon's admission as its bar reads it: a warning while git could not
// answer, none once it named its variables.
export const admissionWarnings = (
  answer: RepositoryLocalEnv,
): readonly RepositoryLocalEnvWarning[] =>
  answer.kind === "named"
    ? []
    : [
        {
          kind: "repository-local-env",
          message: describeUnknown(answer, "daemon"),
        },
      ];
