// A daemon spawned from a shell that exports one of git's repository variables
// (a hook's GIT_DIR, vcsh, yadm) reads each session's repository from the
// session's directory: its environment is the process's less the variables git
// names (src/host.ts daemonEnv), and every git read inherits it.
//
// [LAW:behavior-not-structure] Real git in two real repos, read through the
// GitService a daemon holds. [LAW:effects-at-boundaries] An adapter case: what
// it proves is real git's own behaviour (it honours GIT_DIR over its cwd, and
// names it when asked), which a scripted git could only restate.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { askGitEnv } from "../../src/git-env";
import { daemonEnv } from "../../src/host";
import { GitService } from "../../src/segments/git";
import { HOST, hostOf, processLauncher, worldOf } from "../helpers/host";

// The worker's environment less git's repository variables, so a run from a
// hook (the case this file is about) neither builds its fixtures in the
// hook's repository nor reads it where a case means another.
const workerAsk = askGitEnv(processLauncher);
if (workerAsk.kind === "failed") throw new Error(`git rev-parse --local-env-vars failed: ${workerAsk.reason}`);
const worker = daemonEnv(HOST.env, workerAsk);

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "pipe", env: worker });
}

describe("a daemon spawned with GIT_DIR set", () => {
  let root: string;
  let a: string;
  let b: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ccb-git-env-"));
    a = join(root, "a");
    b = join(root, "b");
    for (const [repo, branch] of [
      [a, "alpha"],
      [b, "beta"],
    ] as const) {
      mkdirSync(repo);
      run(`git init -q -b ${branch}`, repo);
      run("git config user.email t@t.t && git config user.name t", repo);
      run("git commit -q --allow-empty -m init", repo);
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // The spawning shell's environment: the worker's, inside a hook of repo a.
  const shellEnv = (): NodeJS.ProcessEnv => ({ ...worker, GIT_DIR: join(a, ".git") });
  const branchIn = async (env: NodeJS.ProcessEnv, dir: string) =>
    new GitService(worldOf(hostOf(env)).launcher).getGitInfo(dir);

  test("its git reads answer for the session's directory", async () => {
    // Asked as the daemon's main asks: through the spawning shell's launcher.
    const asked = askGitEnv(worldOf(hostOf(shellEnv())).launcher);
    expect(asked).toMatchObject({ kind: "asked", names: expect.arrayContaining(["GIT_DIR"]) });
    expect(await branchIn(daemonEnv(shellEnv(), asked), b)).toMatchObject({
      kind: "ok",
      value: { branch: "beta" },
    });
  });

  // What the daemon read before it dropped them, and still reads when the ask
  // failed (the bar says so): the shell's repository, wherever the session is.
  test("over the environment as given, git answers for the shell's repository", async () => {
    expect(await branchIn(shellEnv(), b)).toMatchObject({
      kind: "ok",
      value: { branch: "alpha" },
    });
  });
});
