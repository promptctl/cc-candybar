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

// git's repository-local variables (the set `git rev-parse --local-env-vars`
// prints, which git clears before it runs a command in another repository)
// fall in two parts: those that locate a repository or what is read from it,
// and those that carry config. A test fails when git prints a name in
// neither.
// [LAW:one-source-of-truth] exception: git's list is external; the test fails
// when git adds a name.
const GIT_LOCATING_ENV = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
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

// The config git's list carries, which names no repository, so it passes: a
// user's exported config (a container's `safe.directory` through
// GIT_CONFIG_COUNT and its KEY/VALUE pairs) applies to every repository.
export const GIT_CONFIG_ENV: readonly string[] = [
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
];

// [LAW:one-source-of-truth] The variables that name the repository a command
// acts on ahead of its working directory: git's locating ones and each
// forge's. A detached process's environment is whichever shell spawned it, and
// spawned from a git hook, a `rebase --exec` or a vcsh shell it carries these
// for that shell's repository. A child inheriting them would read every
// session's branch, status and PR, and clone a plugin, there. So a child that
// inherits its owner's environment never gets them: its repository is its
// working directory's. A session's own environment is the session's, and
// passes as it is. The process's own environment is never edited, because the
// client reports it whole as its session's.
export const REPOSITORY_SCOPED_ENV: readonly string[] = [
  ...GIT_LOCATING_ENV,
  ...Object.values(FORGE_CLI).map(({ repoEnv }) => repoEnv),
];
