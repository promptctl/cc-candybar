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
// repository.
// [LAW:one-source-of-truth] exception: git's list is external; the test fails
// when git adds a name.
const GIT_REPOSITORY_LOCAL_ENV = [
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
// repository-local set and each forge's repository variable. In a detached
// process they belong to whichever shell spawned it (a git hook's, a vcsh
// shell's), never to the directory a child is launched in. Dropping the git
// config those variables supply (`GIT_CONFIG*`) is intended: it is scoped to
// the spawning shell's repository, and git drops it the same way when a
// command crosses into another repository.
export const REPOSITORY_SCOPED_ENV: readonly string[] = [
  ...GIT_REPOSITORY_LOCAL_ENV,
  ...Object.values(FORGE_CLI).map(({ repoEnv }) => repoEnv),
];

// An environment less the variables scoped to a repository.
export function withoutRepositoryScoped(
  env: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => !REPOSITORY_SCOPED_ENV.includes(name),
    ),
  );
}
