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
// prints, which git itself clears before it runs a command in another
// repository. A test checks it against the installed git's.
const GIT_REPOSITORY_ENV = [
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

export type RepositoryNamingVariable =
  | (typeof GIT_REPOSITORY_ENV)[number]
  | (typeof FORGE_CLI)[ForgeName]["repoEnv"];

// [LAW:one-source-of-truth] The variables that name a repository ahead of the
// working directory, git's and each forge's. In a detached process they
// describe whichever shell spawned it (a git hook's, a vcsh shell's), never
// the directory a child is launched in.
export const REPOSITORY_NAMING_ENV: readonly RepositoryNamingVariable[] = [
  ...GIT_REPOSITORY_ENV,
  ...Object.values(FORGE_CLI).map(({ repoEnv }) => repoEnv),
];
