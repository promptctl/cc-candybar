// The daemon's boot ask of git for the variables that locate a repository
// (src/git-env.ts), and the environment the daemon keeps by it (src/host.ts).
//
// [LAW:no-silent-failure] Every way the ask can end is an outcome: named
// variables, none when git is not installed, or a failure that says why.

import { askGitEnv, GIT_ENV_ASK_TIMEOUT_MS, gitEnvAskOf } from "../../src/git-env";
import { daemonEnv } from "../../src/host";
import type { LaunchResult } from "../../src/proc/launch";
import { exits, hangs, program } from "../../src/proc/spawner-fake";
import { fakeLauncher } from "../helpers/fake-launcher";
import { heldClock } from "../helpers/held-clock";

const failedWith = (fields: Partial<Extract<LaunchResult, { ok: false }>>): LaunchResult => ({
  ok: false,
  reason: "spawn-error",
  stdout: "",
  stderr: "",
  exitCode: null,
  signal: null,
  ...fields,
});

describe("the ask's outcome from a launch", () => {
  test("git's answer names each variable it printed", () => {
    expect(
      gitEnvAskOf({ ok: true, stdout: "GIT_DIR\nGIT_WORK_TREE\nGIT_INDEX_FILE\n", stderr: "", exitCode: 0 }),
    ).toEqual({ kind: "asked", names: ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] });
  });

  test("a git that is not installed names none, as a success", () => {
    expect(gitEnvAskOf(failedWith({ error: "spawnSync git ENOENT" }))).toEqual({ kind: "asked", names: [] });
  });

  test.each<[string, LaunchResult, string]>([
    ["a spawn the OS refused for want of resources", failedWith({ error: "spawnSync git EAGAIN" }), "spawnSync git EAGAIN"],
    ["a signal", failedWith({ reason: "signal", signal: "SIGKILL" }), "killed by SIGKILL"],
    [
      "a non-zero exit",
      failedWith({ reason: "non-zero", exitCode: 129, stderr: "error: unknown option" }),
      "exited with code 129: error: unknown option",
    ],
    ["the timeout", failedWith({ reason: "timeout", error: "timed out after 2 s" }), "timed out after 2 s"],
  ])("%s is a failure that says why", (_name, result, reason) => {
    expect(gitEnvAskOf(result)).toEqual({ kind: "failed", reason });
  });
});

describe("the ask", () => {
  test("asks git itself", () => {
    const { launcher, spawner } = fakeLauncher(heldClock(new Date(0)));
    spawner.program(program("git"), exits(0, "GIT_DIR\nGIT_COMMON_DIR\n"));
    expect(askGitEnv(launcher)).toEqual({ kind: "asked", names: ["GIT_DIR", "GIT_COMMON_DIR"] });
  });

  test("a git that never exits ends at the bound, as a failure naming it", () => {
    const { launcher, spawner } = fakeLauncher(heldClock(new Date(0)));
    spawner.program(program("git"), hangs());
    expect(askGitEnv(launcher)).toEqual({
      kind: "failed",
      reason: `timed out after ${GIT_ENV_ASK_TIMEOUT_MS / 1000} s`,
    });
  });
});

describe("the daemon's environment", () => {
  const env = { GIT_DIR: "/a/.git", GIT_WORK_TREE: "/a", PATH: "/bin", HOME: "/h" };

  test("is the inherited one less exactly the variables git named", () => {
    expect(daemonEnv(env, { kind: "asked", names: ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"] })).toEqual({
      PATH: "/bin",
      HOME: "/h",
    });
  });

  test("is the inherited one whole when the ask failed", () => {
    expect(daemonEnv(env, { kind: "failed", reason: "killed by SIGKILL" })).toEqual(env);
  });
});
