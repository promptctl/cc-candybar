// The command-line tools that act on a repository: git, and the forge CLIs a
// branch's PR is asked through. A leaf, so the launcher that withholds the
// variables they honour and the git segment that asks a forge depend on
// neither each other nor anything above them.

export type ForgeName = "github" | "gitlab";

// [LAW:one-source-of-truth] Each forge's CLI, and the variable that CLI reads
// as the repository it acts on, ahead of its working directory.
// [LAW:types-are-the-program] One entry per forge holds both, so a forge
// added here cannot leave its variable out of the list below.
export const FORGE_CLI = {
  github: { cli: "gh", repoEnv: "GH_REPO" },
  gitlab: { cli: "glab", repoEnv: "GITLAB_REPO" },
} as const satisfies Record<ForgeName, { cli: string; repoEnv: string }>;

// git's repository-local variables: the set `git rev-parse --local-env-vars`
// prints. All are withheld, config included, which is more than git clears
// for a submodule: git lets `-c` config through, but a hook's `-c` flags
// travel in GIT_CONFIG_PARAMETERS, and config can relocate a child's worktree
// (`core.worktree`) or alter a clone (`http.sslVerify`,
// `url.<base>.insteadOf`).
// [LAW:one-source-of-truth] exception: git's list is external; a test fails
// when git prints a name this one lacks.
const GIT_LOCAL_ENV = [
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
] as const;

// [LAW:one-source-of-truth] The variables scoped to one repository: git's
// local ones and each forge's. A detached process's environment is whichever
// shell spawned it, and spawned from a git hook, a `rebase --exec` or a vcsh
// shell it carries these for that shell's repository. A child inheriting them
// would read every session's branch, status and PR, and clone a plugin, there,
// since nothing but this filter bounds them to a child's working directory. So
// every child started with the inherited environment goes without them. A
// session's own environment is the session's, and passes as it is. The
// process's own environment is never edited, because the client reports it
// whole as its session's.
export const REPOSITORY_SCOPED_ENV: readonly string[] = [
  ...GIT_LOCAL_ENV,
  ...Object.values(FORGE_CLI).map(({ repoEnv }) => repoEnv),
];

// [LAW:single-enforcer] The one filter: an environment less
// REPOSITORY_SCOPED_ENV.
export function withoutRepositoryScopedEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => !REPOSITORY_SCOPED_ENV.includes(name),
    ),
  );
}
