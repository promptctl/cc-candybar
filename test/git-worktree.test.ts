import { execSync } from "node:child_process";
import { processLauncher } from "./helpers/host";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "../src/segments/git";

// [LAW:behavior-not-structure] Real repos + a real `git worktree add`, not a
// child_process mock. The previous mock targeted `exec`, which the launch
// seam stopped using — git failed for real against a dangling .git pointer
// and the assertions only passed through the old swallow-to-fallback path.
// With outcomes, a failing git is a `failed` outcome, so the fixture must be
// a genuinely working worktree.
function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "pipe" });
}

describe("GitService and a linked worktree", () => {
  let root: string;
  let mainRepo: string;
  let worktree: string;
  const gitService = new GitService(processLauncher);

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "candybar-worktree-test-"));
    mainRepo = join(root, "main-repo");
    mkdirSync(mainRepo);
    run("git init -q -b main", mainRepo);
    run("git config user.email t@t.t && git config user.name t", mainRepo);
    run("git commit -q --allow-empty -m init", mainRepo);
    worktree = join(root, "wt");
    run(`git worktree add -q "${worktree}"`, mainRepo);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads the worktree where .git is a file", async () => {
    await expect(gitService.getGitInfo(worktree)).resolves.toMatchObject({
      kind: "ok",
      value: { branch: "wt" },
    });
  });

  it("reads the main repo where .git is a directory", async () => {
    await expect(gitService.getGitInfo(mainRepo)).resolves.toMatchObject({
      kind: "ok",
      value: { branch: "main" },
    });
  });

  it("reads the worktree its working directory is in, whatever repo projectDir names", async () => {
    await expect(
      gitService.getGitInfo(worktree, mainRepo),
    ).resolves.toMatchObject({ kind: "ok", value: { branch: "wt" } });
  });
});
