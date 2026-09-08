import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitService } from "../src/segments/git";

// [LAW:behavior-not-structure] Real repos, not a mock: the fixture must genuinely work.
function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "pipe" });
}

describe("GitService isWorktree", () => {
  let root: string;
  let mainRepo: string;
  let worktree: string;
  const gitService = new GitService();

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

  describe("worktree detection", () => {
    it("should set isWorktree to true when .git is a file (worktree)", async () => {
      const info = await gitService.getGitInfo(worktree, {
        showRepoName: true,
      });

      expect(info).toMatchObject({
        kind: "ok",
        value: { branch: "wt", isWorktree: true },
      });
    });

    it("should set isWorktree to false when .git is a directory (normal repo)", async () => {
      const info = await gitService.getGitInfo(mainRepo, {
        showRepoName: true,
      });

      expect(info).toMatchObject({
        kind: "ok",
        value: { branch: "main", isWorktree: false },
      });
    });
  });

  describe("gitDir resolution", () => {
    it("should detect isWorktree based on workingDir, not gitDir from projectDir", async () => {
      const info = await gitService.getGitInfo(
        worktree,
        { showRepoName: true },
        mainRepo,
      );

      expect(info).toMatchObject({
        kind: "ok",
        value: { branch: "wt", isWorktree: true },
      });
    });
  });
});
