import { execFileSync } from "node:child_process";

// The env var that carries the answer from the run's global setup to its workers.
export const IGNORED_ENV = "CC_CANDYBAR_TEST_IGNORED_PATHS";

// [LAW:one-source-of-truth] What the checkout holds that a run produces is what
// .gitignore says it is, so the unit refusal asks git instead of keeping a list.
// node_modules is ignored and still read: the lockfile pins it, so it is the
// same data on every run. A failing git throws, because an empty answer here
// would read as "nothing is ignored" and let a test read a build.
export function gitIgnored(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split("\n")
    .filter((entry) => entry !== "" && entry !== "node_modules/");
}
