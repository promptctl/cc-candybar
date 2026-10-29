// [LAW:behavior-not-structure] Whether a directory sits in a linked worktree
// of a repository, proven from the repository's side: what `git worktree add`
// writes is linked to the main worktree, and nothing a directory can write
// about itself (a forged or symlinked `.git`) borrows another repository's
// identity. A link that cannot be proven is said, never thrown.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { worktreeLink } from "../src/utils/git-root";

let root: string;
let main: string;
let wt: string;

const git = (...args: string[]): void => {
  execFileSync("git", args, { stdio: "ignore" });
};

beforeEach(() => {
  root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "cc-candybar-worktree-link-")),
  );
  main = path.join(root, "main");
  wt = path.join(root, "wt");
  git("init", "-q", main);
  git(
    "-C",
    main,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "c",
  );
  git("-C", main, "worktree", "add", "-q", "--detach", wt);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const linked = (to: string) => ({ kind: "linked", main: to });

test("a linked worktree, and a directory in it, are their main worktree's counterparts", () => {
  expect(worktreeLink(wt)).toEqual(linked(main));
  const sub = path.join(wt, "pkg", "a");
  fs.mkdirSync(sub, { recursive: true });
  expect(worktreeLink(sub)).toEqual(linked(path.join(main, "pkg", "a")));
});

test("a main worktree and a directory in no checkout are not linked", () => {
  expect(worktreeLink(main)).toEqual({ kind: "unlinked" });
  const loose = path.join(root, "loose");
  fs.mkdirSync(loose);
  expect(worktreeLink(loose)).toEqual({ kind: "unlinked" });
});

test("a bare repository's worktrees share the bare repository's spelling", () => {
  const bare = path.join(root, "bare.git");
  git("clone", "-q", "--bare", main, bare);
  const bwt = path.join(root, "bwt");
  git("-C", bare, "worktree", "add", "-q", "--detach", bwt);
  expect(worktreeLink(bwt)).toEqual(linked(bare));
});

test("a --separate-git-dir checkout, whose git dir has no commondir, is not linked", () => {
  const sep = path.join(root, "sep");
  git("init", "-q", "--separate-git-dir", path.join(root, "sep.git"), sep);
  expect(worktreeLink(sep)).toEqual({ kind: "unlinked" });
});

test("a .git symlinked to a git directory claims no worktree", () => {
  const linkedDir = path.join(root, "linked-git");
  fs.mkdirSync(linkedDir);
  fs.symlinkSync(path.join(main, ".git"), path.join(linkedDir, ".git"));
  expect(worktreeLink(linkedDir)).toEqual({ kind: "unlinked" });
});

describe("what a directory writes about itself proves nothing", () => {
  test("a .git naming a real worktree's metadata fails git's back-pointer", () => {
    const evil = path.join(root, "evil");
    fs.mkdirSync(evil);
    fs.writeFileSync(
      path.join(evil, ".git"),
      `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`,
    );
    expect(worktreeLink(evil).kind).toBe("unproven");
  });

  test("a .git naming metadata of its own, pointing at the repository, is not registered there", () => {
    const evil = path.join(root, "evil");
    const meta = path.join(evil, "meta");
    fs.mkdirSync(meta, { recursive: true });
    fs.writeFileSync(path.join(evil, ".git"), "gitdir: meta\n");
    fs.writeFileSync(path.join(meta, "commondir"), path.join(main, ".git"));
    fs.writeFileSync(path.join(meta, "gitdir"), path.join(evil, ".git"));
    expect(worktreeLink(evil).kind).toBe("unproven");
  });

  test("a .git that is a symlink to a real worktree's .git is not that worktree", () => {
    const evil = path.join(root, "evil");
    fs.mkdirSync(evil);
    fs.symlinkSync(path.join(wt, ".git"), path.join(evil, ".git"));
    expect(worktreeLink(evil).kind).toBe("unproven");
  });
});

describe("a link that cannot be proven is said, never thrown", () => {
  test("a worktree moved by hand", () => {
    const moved = path.join(root, "moved");
    fs.renameSync(wt, moved);
    expect(worktreeLink(moved)).toMatchObject({ kind: "unproven" });
  });

  test("a worktree whose metadata was pruned", () => {
    fs.rmSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
    expect(worktreeLink(wt)).toMatchObject({ kind: "unproven" });
  });

  test("a .git that cannot be read says why", () => {
    const dotGit = path.join(wt, ".git");
    fs.chmodSync(dotGit, 0o000);
    try {
      expect(worktreeLink(wt)).toEqual({
        kind: "unproven",
        reason: expect.stringContaining("EACCES"),
      });
    } finally {
      fs.chmodSync(dotGit, 0o644);
    }
  });

  test("a .git naming a git dir that is not there", () => {
    const dangling = path.join(root, "dangling");
    fs.mkdirSync(dangling);
    fs.writeFileSync(path.join(dangling, ".git"), "gitdir: /nonexistent/x\n");
    expect(worktreeLink(dangling)).toEqual({
      kind: "unproven",
      reason: "/nonexistent/x is not there",
    });
  });
});
