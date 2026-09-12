// [LAW:behavior-not-structure] The stash count against real git. It stopped
// spawning `git stash list` and became a read of the `refs/stash` reflog
// (brandon-git-cache-y9h), so every test here compares the answer to what git
// itself reports rather than to a hand-computed number — an equivalence claim is
// only worth what it is measured against.
//
// The worktree case is the reason this file exists. The design doc specified
// `<gitDir>/logs/refs/stash`, and `resolveGitDir` answers with the PER-WORKTREE
// gitdir, which never holds that reflog: a linked worktree would have reported
// zero stashes, silently, for a repo that has them.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitService } from "../src/segments/git";

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, stdio: "pipe", encoding: "utf8" });
}

// git's own answer, so the assertions below compare two readings of one fact.
function gitStashCount(cwd: string): number {
  const out = run("git stash list", cwd).trim();
  return out ? out.split("\n").length : 0;
}

function stashOnce(cwd: string, marker: string): void {
  writeFileSync(join(cwd, "f.txt"), marker);
  run("git add f.txt", cwd);
  run("git stash push -q -m " + marker, cwd);
}

describe("stash count reads the refs/stash reflog", () => {
  const git = new GitService();
  let root: string;
  let repo: string;
  let worktree: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ccb-stash-"));
    repo = join(root, "main");
    mkdirSync(repo);
    run("git init -q -b main", repo);
    run("git config user.email t@t.t && git config user.name t", repo);
    run("git commit -q --allow-empty -m init", repo);
    worktree = join(root, "wt");
    run(`git worktree add -q "${worktree}"`, repo);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function count(dir: string): Promise<unknown> {
    const info = await git.getGitInfo(dir, { showStashCount: true });
    expect(info.kind).toBe("ok");
    return info.kind === "ok" ? info.value.stashCount : undefined;
  }

  test("no stash ever pushed is a REAL zero, not absent and not failed", async () => {
    expect(gitStashCount(repo)).toBe(0);
    await expect(count(repo)).resolves.toEqual({ kind: "ok", value: 0 });
  });

  test("the count tracks git's own, entry for entry", async () => {
    stashOnce(repo, "one");
    expect(gitStashCount(repo)).toBe(1);
    await expect(count(repo)).resolves.toEqual({ kind: "ok", value: 1 });

    stashOnce(repo, "two");
    expect(gitStashCount(repo)).toBe(2);
    await expect(count(repo)).resolves.toEqual({ kind: "ok", value: 2 });
  });

  // The regression the common-dir resolution exists to prevent: `refs/stash` is
  // shared, so a linked worktree's `git stash list` shows the main repo's
  // stashes, but the per-worktree gitdir holds no reflog of its own.
  test("a linked worktree reports the stashes git reports there", async () => {
    const expected = gitStashCount(worktree);
    expect(expected).toBe(2);
    await expect(count(worktree)).resolves.toEqual({
      kind: "ok",
      value: expected,
    });
  });

  test("popping is reflected, and reaching zero again is ok(0)", async () => {
    run("git stash pop -q", repo);
    run("git reset -q && rm -f f.txt", repo);
    run("git stash pop -q", repo);
    run("git reset -q && rm -f f.txt", repo);
    expect(gitStashCount(repo)).toBe(0);
    await expect(count(repo)).resolves.toEqual({ kind: "ok", value: 0 });
  });

  // [LAW:no-silent-failure] A read that fails for a reason other than "no stash
  // here" is `failed`, never a zero. Without this, swapping the spawn for a file
  // read would have reintroduced exactly the catch-to-0 meaning-erasure the
  // outcome version was written to remove.
  //
  // A DIRECTORY where the reflog belongs is the portable representative of that
  // class: EISDIR, deterministic on every platform and for every user. A
  // permission bit would have been the obvious choice and the wrong one — a
  // privileged CI user ignores mode 000, so the test would go red for the
  // environment rather than for the behaviour.
  test("a reflog that cannot be read is failed, not zero", async () => {
    const broken = join(root, "broken");
    mkdirSync(broken);
    run("git init -q -b main", broken);
    run("git config user.email t@t.t && git config user.name t", broken);
    run("git commit -q --allow-empty -m init", broken);
    mkdirSync(join(broken, ".git", "logs", "refs", "stash"), {
      recursive: true,
    });

    const info = await git.getGitInfo(broken, { showStashCount: true });
    expect(info.kind).toBe("ok");
    if (info.kind !== "ok") return;
    expect(info.value.stashCount).toMatchObject({ kind: "failed" });
  });
});
