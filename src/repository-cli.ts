// The command-line tools that act on a repository: git, and the forge CLIs a
// branch's PR is asked through. A leaf, so the launcher below every module and
// the git segment above it read one table.

export type ForgeName = "github" | "gitlab";

// [LAW:one-source-of-truth] The CLI each forge is asked through.
export const FORGE_CLI: Readonly<Record<ForgeName, "gh" | "glab">> = {
  github: "gh",
  gitlab: "glab",
};

// [LAW:one-source-of-truth] The variables that name a repository ahead of the
// working directory: git's repository-local variables (the set
// `git rev-parse --local-env-vars` prints, which git itself clears before it
// runs a command in another repository), `GH_REPO` for gh and `GITLAB_REPO`
// for glab. In a detached process they describe whichever shell spawned it, a
// git hook's or a vcsh shell's, never the directory a child is launched in.
// A test checks this list against the installed git's.
export const REPOSITORY_LOCAL_ENV: readonly string[] = [
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
  "GH_REPO",
  "GITLAB_REPO",
];
