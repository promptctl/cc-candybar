import { execFileSync } from "node:child_process";

// [LAW:one-source-of-truth] A bar run from the suite's own checkout draws that
// checkout's branch, its changes, its pull request as the forge answers for
// whoever is signed in, and any config in the folders above it: what differs
// from one machine to the next, and from day to day. A case that draws a
// checkout's cells draws this one: `dir` made a repository on `branch`, with
// one commit.
export function checkoutAt(dir: string, branch = "main"): string {
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  };
  git("init", "-q", "-b", branch);
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
