// Classification contract for GitService against real git: a non-zero exit
// that is the domain answering "there is none" (no upstream, no tags, no
// remote) is `absent`; a real value — including 0 stashes — is `ok`; only a
// transport failure is `failed` (covered at the boundary by stub tests).
// [LAW:types-are-the-program] These assert the states the old
// catch-and-substitute blocks made unrepresentable.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitService } from "../src/segments/git";
import { ABSENT, ok } from "../src/utils/outcome";

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "pipe" });
}

describe("GitService outcome classification", () => {
  let root: string;
  let repo: string;
  const svc = new GitService();

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "candybar-git-outcome-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    run("git init -q -b main", repo);
    run("git config user.email t@t.t && git config user.name t", repo);
    run("git commit -q --allow-empty -m init", repo);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("non-repo directory is absent, not a failure", async () => {
    const dir = join(root, "not-a-repo");
    mkdirSync(dir);
    expect(await svc.getGitInfo(dir)).toEqual(ABSENT);
  });

  test("no upstream: aheadBehind and upstream are absent — not a confident 0", async () => {
    const info = await svc.getGitInfo(repo, { showUpstream: true });
    expect(info.kind).toBe("ok");
    if (info.kind !== "ok") return;
    expect(info.value.aheadBehind).toEqual(ABSENT);
    expect(info.value.upstream).toEqual(ABSENT);
  });

  test("no tags: tag is absent", async () => {
    const info = await svc.getGitInfo(repo, { showTag: true });
    expect(info.kind).toBe("ok");
    if (info.kind !== "ok") return;
    expect(info.value.tag).toEqual(ABSENT);
  });

  test("empty stash list is a REAL ok(0), distinct from absent/failed", async () => {
    const info = await svc.getGitInfo(repo, { showStashCount: true });
    expect(info.kind).toBe("ok");
    if (info.kind !== "ok") return;
    expect(info.value.stashCount).toEqual(ok(0));
  });

  test("a stashed change counts as ok(1)", async () => {
    writeFileSync(join(repo, "f.txt"), "x");
    run("git add f.txt && git stash -q", repo);
    const info = await svc.getGitInfo(repo, { showStashCount: true });
    run("git stash pop -q && git reset -q && rm f.txt", repo);
    expect(info.kind).toBe("ok");
    if (info.kind !== "ok") return;
    expect(info.value.stashCount).toEqual(ok(1));
  });

  test("repoName without a remote is the basename POLICY, as ok", async () => {
    const info = await svc.getGitInfo(repo, { showRepoName: true });
    expect(info.kind).toBe("ok");
    if (info.kind !== "ok") return;
    expect(info.value.repoName).toEqual(ok("repo"));
  });

  test("repoName with a remote parses the remote URL", async () => {
    run("git remote add origin git@github.com:user/myrepo.git", repo);
    const info = await svc.getGitInfo(repo, { showRepoName: true });
    run("git remote remove origin", repo);
    expect(info.kind).toBe("ok");
    if (info.kind !== "ok") return;
    expect(info.value.repoName).toEqual(ok("myrepo"));
  });

  test("with an upstream, aheadBehind is ok with real counts", async () => {
    const remote = join(root, "remote.git");
    run(`git init -q --bare "${remote}"`, root);
    run(`git remote add origin "${remote}"`, repo);
    run("git push -q -u origin main", repo);
    run("git commit -q --allow-empty -m ahead", repo);
    const info = await svc.getGitInfo(repo);
    run("git remote remove origin", repo);
    expect(info.kind).toBe("ok");
    if (info.kind !== "ok") return;
    expect(info.value.aheadBehind).toEqual(ok({ ahead: 1, behind: 0 }));
  });
});
