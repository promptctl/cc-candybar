// What a launch of `git rev-parse --local-env-vars` comes to, and the
// environment a daemon runs with once it has the names.
import { gitEnvAskOf } from "../../src/proc/git-env-ask";
import type { LaunchResult } from "../../src/proc/launcher";
import { withoutNames } from "../../src/segments/git-env";

const failed = (
  reason: Extract<LaunchResult, { ok: false }>["reason"],
  rest: Partial<Extract<LaunchResult, { ok: false }>> = {},
): LaunchResult => ({
  ok: false,
  reason,
  stdout: "",
  stderr: "",
  exitCode: null,
  signal: null,
  ...rest,
});

test("an answer is the names git printed", () => {
  expect(
    gitEnvAskOf({
      ok: true,
      stdout: "GIT_DIR\nGIT_WORK_TREE\n",
      stderr: "",
      exitCode: 0,
    }),
  ).toEqual({ kind: "asked", names: ["GIT_DIR", "GIT_WORK_TREE"] });
});

test("no git installed is an answer with no names", () => {
  expect(
    gitEnvAskOf(failed("spawn-error", { error: "spawn git ENOENT" })),
  ).toEqual({ kind: "asked", names: [] });
});

test.each([
  ["a spawn the OS refused for want of room", failed("spawn-error", { error: "spawn git EAGAIN" })],
  ["a signal", failed("signal")],
  ["a non-zero exit", failed("non-zero", { exitCode: 128, stderr: "fatal: no" })],
  ["the timeout", failed("timeout", { error: "timed out after 2 s" })],
])("%s is a failure that says why", (_, run) => {
  const ask = gitEnvAskOf(run);
  expect(ask.kind).toBe("failed");
  expect(ask.kind === "failed" && ask.reason.length > 0).toBe(true);
});

test("the daemon's environment drops exactly the named variables", () => {
  expect(
    withoutNames(
      { GIT_DIR: "/a/.git", GIT_WORK_TREE: "/a", PATH: "/bin", HOME: "/h" },
      ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"],
    ),
  ).toEqual({ PATH: "/bin", HOME: "/h" });
});
