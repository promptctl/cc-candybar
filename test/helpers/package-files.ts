import { execFileSync } from "node:child_process";

// The env var that carries the answer from the run's global setup to its workers.
export const IGNORED_ENV = "CC_CANDYBAR_TEST_IGNORED_PATHS";

const isNodeModules = (entry: string): boolean => entry.replace(/\/$/, "").split("/").pop() === "node_modules";

// What git listed, as paths relative to the root. A `node_modules` at any depth is
// ignored and still read: the lockfile pins it, so it is the same data on every run.
export function ignoredFrom(listing: string): string[] {
  return listing.split("\0").filter((entry) => entry !== "" && !isNodeModules(entry));
}

// [LAW:one-source-of-truth] What the checkout holds that a run produces is what
// .gitignore says it is, so the unit refusal asks git instead of keeping a list.
// `-z` keeps a path with a special character as itself, not C-quoted. A failing
// git throws, because an empty answer here would read as "nothing is ignored"
// and let a test read a build.
export function gitIgnored(root: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return ignoredFrom(out);
  } catch (error) {
    throw new Error(
      `the unit refusal asks git which files .gitignore names, so the unit run needs git and a git work tree at ${root}`,
      { cause: error },
    );
  }
}
