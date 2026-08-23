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

  test("repoUrl without a remote is absent — no page, not an empty string", async () => {
    const info = await svc.getGitInfo(repo, { showRepoUrl: true });
    expect(info.kind).toBe("ok");
    if (info.kind !== "ok") return;
    expect(info.value.repoUrl).toEqual(ABSENT);
  });

  test("repoUrl transposes an ssh remote to its browsable page", async () => {
    run("git remote add origin git@github.com:user/myrepo.git", repo);
    const info = await svc.getGitInfo(repo, { showRepoUrl: true });
    run("git remote remove origin", repo);
    expect(info.kind).toBe("ok");
    if (info.kind !== "ok") return;
    expect(info.value.repoUrl).toEqual(ok("https://github.com/user/myrepo"));
  });

  test("repoUrl of a bare-path remote is absent — nothing serves it a page", async () => {
    run(`git remote add origin "${join(root, "remote.git")}"`, repo);
    const info = await svc.getGitInfo(repo, { showRepoUrl: true });
    run("git remote remove origin", repo);
    expect(info.kind).toBe("ok");
    if (info.kind !== "ok") return;
    expect(info.value.repoUrl).toEqual(ABSENT);
  });

  // [LAW:one-source-of-truth] repoName and repoUrl are two projections of ONE
  // remotes read, so they cannot disagree about which remote is origin. This is
  // the contract that replaced two independent `config --get remote.origin.url`
  // spawns; asserting them TOGETHER is what pins it.
  test("repoName and repoUrl agree, read together", async () => {
    run("git remote add origin https://gitlab.com/group/sub/proj.git", repo);
    const info = await svc.getGitInfo(repo, {
      showRepoName: true,
      showRepoUrl: true,
    });
    run("git remote remove origin", repo);
    expect(info.kind).toBe("ok");
    if (info.kind !== "ok") return;
    expect(info.value.repoName).toEqual(ok("proj"));
    expect(info.value.repoUrl).toEqual(ok("https://gitlab.com/group/sub/proj"));
  });

  test("origin is the repo's page even when other remotes exist", async () => {
    run("git remote add upstream git@github.com:upstream/proj.git", repo);
    run("git remote add origin git@github.com:me/proj.git", repo);
    const info = await svc.getGitInfo(repo, { showRepoUrl: true });
    run("git remote remove origin && git remote remove upstream", repo);
    expect(info.kind).toBe("ok");
    if (info.kind !== "ok") return;
    expect(info.value.repoUrl).toEqual(ok("https://github.com/me/proj"));
  });

  test("getRemoteOriginUrl still reports the raw origin URL the PR cache keys on", async () => {
    run("git remote add origin git@github.com:user/myrepo.git", repo);
    const withOrigin = await svc.getRemoteOriginUrl(repo);
    run("git remote remove origin", repo);
    const withoutOrigin = await svc.getRemoteOriginUrl(repo);
    expect(withOrigin).toEqual(ok("git@github.com:user/myrepo.git"));
    expect(withoutOrigin).toEqual(ABSENT);
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
