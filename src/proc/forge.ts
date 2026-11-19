// The forges whose CLIs this process runs, and what each CLI reads ahead of
// its working directory.

export type ForgeName = "github" | "gitlab";

// [LAW:one-source-of-truth] The CLI each forge is asked through — the PR lookup
// and the doctor's login probe name it from this one table.
export const FORGE_CLI: Readonly<Record<ForgeName, "gh" | "glab">> = {
  github: "gh",
  gitlab: "glab",
};

// [LAW:one-source-of-truth] The variable each forge's CLI reads a repository
// from ahead of its working directory (gh's GH_REPO, glab's GITLAB_REPO), so a
// process whose children read a repository by directory withholds them.
export const FORGE_REPOSITORY_VARS: Readonly<
  Record<ForgeName, readonly string[]>
> = {
  github: ["GH_REPO"],
  gitlab: ["GITLAB_REPO"],
};
