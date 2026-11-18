// The variables that point git, and the forge CLIs that run it, at a
// repository other than the one in their working directory: `GIT_DIR`,
// `GIT_WORK_TREE` and the rest of what `git rev-parse --local-env-vars` names,
// and gh's `GH_REPO`. A detached daemon's environment is the shell that
// happened to spawn it (a git hook, a `rebase --exec`, a vcsh shell), so those
// variables describe that shell's repository and never a session's.
//
// [LAW:one-source-of-truth] Which names those are is a fact of the process's
// own environment and its git, fixed for the life of the process: settled once
// where the process starts, and handed to whatever launches as data.

import { failureText, type LaunchOpts, type LaunchResult } from "./launcher.js";

// [LAW:locality-or-seam] What the ask needs of a process's launcher: its
// blocking form, which only a process holding no loop anyone waits on has.
interface BlockingLauncher {
  launchSync(opts: LaunchOpts): LaunchResult;
}

// What git 2.50.1 answers to `git rev-parse --local-env-vars`: the names
// dropped when git cannot say for itself.
export const FIXED_REPO_VARIABLES: readonly string[] = [
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

// gh reads the repository from `GH_REPO` before its working directory.
const FORGE_REPO_VARIABLES: readonly string[] = ["GH_REPO"];

// [LAW:types-are-the-program] The names a process's launches drop, and where
// they came from: git's own answer, or the fixed list, with why git gave none.
export type RepoVariables =
  | { readonly kind: "asked"; readonly names: readonly string[] }
  | {
      readonly kind: "fixed";
      readonly why: string;
      readonly names: readonly string[];
    };

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// [LAW:parse-dont-validate] git's answer as the names it lists, or why it is
// no such list. [LAW:no-silent-failure] An empty answer is a failure: a drop
// of nothing is the bug this exists to prevent.
function namesIn(stdout: string): readonly string[] | { readonly why: string } {
  const names = stdout.split("\n").map((line) => line.trim());
  const listed = names.filter((name) => name !== "");
  if (listed.length === 0) return { why: "git named no variables" };
  const odd = listed.find((name) => !VARIABLE_NAME.test(name));
  return odd === undefined
    ? listed
    : { why: `git answered ${JSON.stringify(odd)}, which is no variable name` };
}

// [LAW:single-enforcer] The one ask, made once by a process before anything it
// launches reads a repository. One blocking spawn: the process has no loop
// anyone waits on yet.
export function settleRepoVariables(launcher: BlockingLauncher): RepoVariables {
  const run = launcher.launchSync({
    bin: "git",
    args: ["rev-parse", "--local-env-vars"],
    timeoutMs: 2000,
    category: "repo-variables",
  });
  const parsed = run.ok
    ? namesIn(run.stdout)
    : { why: `git rev-parse --local-env-vars ${failureText(run)}` };
  return "why" in parsed
    ? {
        kind: "fixed",
        why: parsed.why,
        names: [...FIXED_REPO_VARIABLES, ...FORGE_REPO_VARIABLES],
      }
    : { kind: "asked", names: [...parsed, ...FORGE_REPO_VARIABLES] };
}

// `env` without the names.
export function withoutRepoVariables(
  env: Readonly<NodeJS.ProcessEnv>,
  { names }: RepoVariables,
): NodeJS.ProcessEnv {
  const kept = { ...env };
  for (const name of names) delete kept[name];
  return kept;
}

// [LAW:one-source-of-truth] What is said of the names a process settled, for
// the launches named by `reads`: in the daemon's log, on its bars and in the
// doctor, and by plugin install.
export function repoVariablesText(
  vars: RepoVariables,
  reads = "the daemon's git and forge reads",
): string {
  const names = vars.names.join(", ");
  return vars.kind === "asked"
    ? `${reads} run without ${names}, which would point them at the repository of the shell that started the process rather than their own directory`
    : `git could not name the variables that point it at another repository (${vars.why}), so ${reads} run without a fixed list: ${names}`;
}

// The bar's warning while the reads run on the fixed list.
export interface RepoVariablesWarning {
  readonly kind: "repo-variables";
  readonly message: string;
}

// [LAW:dataflow-not-control-flow] The fixed list is a warning on every bar;
// git's own answer is none.
export const repoVariablesWarnings = (
  vars: RepoVariables,
): readonly RepoVariablesWarning[] =>
  vars.kind === "fixed"
    ? [{ kind: "repo-variables", message: repoVariablesText(vars) }]
    : [];
