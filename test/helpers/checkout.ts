import { execFileSync } from "node:child_process";

import { FORGE_CLI } from "../../src/repository-cli";

// [LAW:single-enforcer] Git hooks export the repository, index and object
// store they run in. The program that initializes a fixture must also own
// its templates, identity and config. Keep unrelated shell settings, and
// ensure a forge lookup uses the same checkout as Git.
export function isolateGit(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    if (name.startsWith("GIT_")) delete env[name];
  }
  for (const { repoEnv } of Object.values(FORGE_CLI)) delete env[repoEnv];
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
}

// [LAW:one-source-of-truth] A bar run from the suite's own checkout draws that
// checkout's branch, its changes, its pull request as the forge answers for
// whoever is signed in, and any config in the folders above it: what differs
// from one machine to the next, and from day to day. A case that draws a
// checkout's cells draws this one: `dir` made a repository on `branch`, with
// one commit.
export function checkoutAt(dir: string, branch = "main"): string {
  const env = { ...process.env };
  isolateGit(env);
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, env, stdio: "pipe" });
  };
  git("init", "-q", "--template=", "-b", branch);
  git(
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "user.name=test",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "start",
  );
  return dir;
}
