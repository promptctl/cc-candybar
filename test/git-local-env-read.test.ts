// [LAW:behavior-not-structure] A git read for a session's directory reads
// that directory's repository, whatever repository variables the shell that
// started the process carried: a hook's GIT_DIR, say.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitService } from "../src/daemon/cache/git-service";
import { hostOf, worldOf } from "./helpers/host";

const git = (cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

describe("a git read under a shell's GIT_DIR", () => {
  let root: string;
  let a: string;
  let b: string;
  let shell: NodeJS.ProcessEnv;

  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "candybar-git-env-")));
    a = join(root, "a");
    b = join(root, "b");
    for (const [repo, branch] of [
      [a, "alpha"],
      [b, "beta"],
    ] as const) {
      mkdirSync(repo);
      git(repo, process.env, "init", "-q", "-b", branch);
      git(
        repo,
        process.env,
        "-c",
        "user.email=t@t.t",
        "-c",
        "user.name=t",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
      );
    }
    shell = { ...process.env, GIT_DIR: join(a, ".git") };
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("the shell's env as given reads the other repository", () => {
    expect(git(b, shell, "rev-parse", "--abbrev-ref", "HEAD")).toBe("alpha");
  });

  test("the git service reads the session's directory's own branch", async () => {
    const svc = new GitService(worldOf(hostOf(shell)).launcher);
    const info = await svc.getGitInfo(b);
    expect(info).toMatchObject({ kind: "ok", value: { branch: "beta" } });
  });
});
