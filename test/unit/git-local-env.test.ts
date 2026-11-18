// [LAW:behavior-not-structure] A launch for a directory's repository, through
// what reaches the launcher: the ask, the overlay the read carries, and the
// result a failed ask returns.

import type { AsyncLaunchOpts, LaunchResult } from "../../src/proc/launcher";
import type { Launcher } from "../../src/proc/launcher";
import { localEnvUnset, repoLaunch } from "../../src/proc/git-local-env";
import { GitService } from "../../src/daemon/cache/git-service";

const NAMES = "GIT_DIR\nGIT_WORK_TREE\nGIT_CONFIG_PARAMETERS\n";
const okRun = (stdout: string): LaunchResult => ({
  ok: true,
  stdout,
  stderr: "",
  exitCode: 0,
});
const failedRun = (
  reason: "non-zero" | "spawn-error" | "timeout",
): LaunchResult => ({
  ok: false,
  reason,
  stdout: "",
  stderr: reason === "non-zero" ? "fatal: broken" : "",
  exitCode: reason === "non-zero" ? 128 : null,
  signal: null,
  ...(reason === "spawn-error" ? { error: "spawn git ENOENT" } : {}),
});

const isAsk = (o: AsyncLaunchOpts) =>
  o.bin === "git" && o.args?.join(" ") === "rev-parse --local-env-vars";

function recording(answers: LaunchResult[]) {
  const launched: AsyncLaunchOpts[] = [];
  return {
    launched,
    launch: async (opts: AsyncLaunchOpts) => {
      launched.push(opts);
      return isAsk(opts) ? answers.shift()! : okRun("read");
    },
  };
}

const READ: AsyncLaunchOpts = {
  bin: "git",
  args: ["status"],
  cwd: "/repo",
  envOverlay: { GIT_OPTIONAL_LOCKS: "0" },
  category: "git",
};

test("the overlay unsets exactly the names git gave", () => {
  expect(localEnvUnset(NAMES)).toEqual({
    GIT_DIR: null,
    GIT_WORK_TREE: null,
    GIT_CONFIG_PARAMETERS: null,
  });
  expect(localEnvUnset("")).toEqual({});
});

test("a read carries the asked names unset under its own overlay, and the second read asks nothing", async () => {
  const l = recording([okRun(NAMES)]);
  const launch = repoLaunch(l);
  expect(await launch(READ)).toEqual(okRun("read"));
  await launch({ ...READ, envOverlay: { GIT_DIR: "/kept" } });
  expect(l.launched.filter(isAsk)).toHaveLength(1);
  expect(l.launched.filter((o) => !isAsk(o)).map((o) => o.envOverlay)).toEqual([
    {
      GIT_DIR: null,
      GIT_WORK_TREE: null,
      GIT_CONFIG_PARAMETERS: null,
      GIT_OPTIONAL_LOCKS: "0",
    },
    { GIT_DIR: "/kept", GIT_WORK_TREE: null, GIT_CONFIG_PARAMETERS: null },
  ]);
});

test("concurrent first reads share one ask", async () => {
  const l = recording([okRun(NAMES)]);
  const launch = repoLaunch(l);
  await Promise.all([launch(READ), launch(READ)]);
  expect(l.launched.filter(isAsk)).toHaveLength(1);
});

test.each(["non-zero", "spawn-error", "timeout"] as const)(
  "an ask that fails (%s) is the read's result, the read never runs, and the next read asks again",
  async (reason) => {
    const l = recording([failedRun(reason), okRun(NAMES)]);
    const launch = repoLaunch(l);
    expect(await launch(READ)).toEqual(failedRun(reason));
    expect(l.launched.filter((o) => !isAsk(o))).toEqual([]);
    expect(await launch(READ)).toEqual(okRun("read"));
    expect(l.launched.filter(isAsk)).toHaveLength(2);
  },
);

// The forge CLIs run git themselves, so their launch carries the same unset.
test("a PR lookup launches its forge CLI with git's repository variables unset", async () => {
  const l = recording([okRun(NAMES)]);
  await new GitService(l as unknown as Launcher).resolvePullRequest(
    "/repo",
    "git@github.com:o/r.git",
  );
  expect(l.launched.filter((o) => !isAsk(o))).toEqual([
    expect.objectContaining({
      bin: "gh",
      envOverlay: {
        GIT_DIR: null,
        GIT_WORK_TREE: null,
        GIT_CONFIG_PARAMETERS: null,
      },
    }),
  ]);
});
