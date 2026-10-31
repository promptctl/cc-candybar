// [LAW:behavior-not-structure] `findGitRoot`'s accept/reject table, driven
// against real repos rather than a mocked fs (brandon-git-cache-y9h). It stopped
// asking `git rev-parse --show-toplevel` and became a parent-directory ascent
// applying the same `.git` predicate the class's own short-circuits use, so the
// cases that matter are layout cases: which spellings of `.git` count, which
// ancestor wins, and where the ascent must stop.

import { processLauncher } from "../src/proc/launch";
import { execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitService } from "../src/segments/git";

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "pipe" });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  run("git init -q -b main", dir);
  run("git config user.email t@t.t && git config user.name t", dir);
  run("git commit -q --allow-empty -m init", dir);
}

describe("findGitRoot ascends to the nearest ancestor holding .git", () => {
  const git = new GitService(processLauncher);
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ccb-ascent-"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("a .git DIRECTORY is the root, from the root itself and from below it", async () => {
    const repo = join(root, "plain");
    initRepo(repo);
    const deep = join(repo, "a", "b", "c");
    mkdirSync(deep, { recursive: true });

    expect(git.findGitRoot(repo)).toEqual({
      kind: "ok",
      value: repo,
    });
    expect(git.findGitRoot(deep)).toEqual({
      kind: "ok",
      value: repo,
    });
  });

  // The path comes back spelled the way the caller spelled it, which the strict
  // equality below is the whole assertion of. It is a real distinction on macOS,
  // where the tmpdir sits under a symlinked /var: `rev-parse` answered with the
  // PHYSICAL path (/private/var/...) while the `isGitRepo` short-circuit answered
  // with the logical one, so ONE repo could occupy two cache keys depending on
  // which arm replied.
  test("the answer keeps the caller's spelling of the path", async () => {
    const repo = join(root, "spelling");
    initRepo(repo);
    const deep = join(repo, "x");
    mkdirSync(deep);

    expect(git.findGitRoot(deep)).toEqual({
      kind: "ok",
      value: repo,
    });
  });

  // A worktree and a submodule both spell `.git` as a FILE holding a
  // `gitdir:` pointer, and both are repos.
  test("a .git FILE is the root too", async () => {
    const main = join(root, "wt-main");
    initRepo(main);
    const worktree = join(root, "wt");
    run(`git worktree add -q "${worktree}"`, main);
    const inside = join(worktree, "nested");
    mkdirSync(inside);

    expect(git.findGitRoot(worktree)).toEqual({
      kind: "ok",
      value: worktree,
    });
    expect(git.findGitRoot(inside)).toEqual({
      kind: "ok",
      value: worktree,
    });
  });

  test("the NEAREST ancestor wins when repos nest", async () => {
    const outer = join(root, "outer");
    initRepo(outer);
    const inner = join(outer, "vendor", "inner");
    initRepo(inner);
    const deep = join(inner, "src");
    mkdirSync(deep);

    expect(git.findGitRoot(deep)).toEqual({
      kind: "ok",
      value: inner,
    });
  });

  // A bare repo has no work tree, so it has no root to report — `--show-toplevel`
  // printed nothing there and `nonEmpty` turned that into absent. Same answer.
  test("a bare repo is absent, not its own root", async () => {
    const bare = join(root, "bare.git");
    mkdirSync(bare);
    run("git init -q --bare .", bare);

    expect(git.findGitRoot(bare)).toEqual({ kind: "absent" });
  });

  test("a directory under no repo at all is absent", async () => {
    const plain = join(root, "not-a-repo", "deeper");
    mkdirSync(plain, { recursive: true });

    expect(git.findGitRoot(plain)).toEqual({ kind: "absent" });
  });

  // The predicate follows symlinks, like the `isGitRepo` short-circuit it shares:
  // a `.git` pointing at a real gitdir is a repo, and a DANGLING one is not — so
  // the ascent walks past it rather than claiming a root it cannot read.
  test("a .git symlink counts only when it resolves", async () => {
    const donor = join(root, "donor");
    initRepo(donor);

    const live = join(root, "sym-live");
    mkdirSync(live);
    symlinkSync(join(donor, ".git"), join(live, ".git"));
    expect(git.findGitRoot(live)).toEqual({
      kind: "ok",
      value: live,
    });

    const dangling = join(root, "sym-dangling");
    mkdirSync(dangling);
    symlinkSync(join(root, "nothing-here"), join(dangling, ".git"));
    expect(git.findGitRoot(dangling)).toEqual({
      kind: "absent",
    });
  });

  // An entry named `.git` that is neither a gitdir nor a pointer still reads as a
  // repo here, exactly as the `isGitRepo` short-circuit has always read it. The
  // ascent's job is to find the root; whether the repo is usable is the core
  // `git status` call's answer, which fails loudly rather than silently.
  test("the ascent locates a root; validating it is the status call's job", async () => {
    const junk = join(root, "junk-dotgit");
    mkdirSync(junk);
    writeFileSync(join(junk, ".git"), "not a gitdir pointer\n");

    expect(git.findGitRoot(junk)).toEqual({
      kind: "ok",
      value: junk,
    });
    const info = await git.getGitInfo(junk);
    expect(info.kind).toBe("failed");
  });
});
