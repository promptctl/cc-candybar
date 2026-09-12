// [LAW:verifiable-goals] The per-cache-miss `git` spawn count, asserted as a
// number against a real repo (brandon-git-cache-y9h). The ticket's cost is a
// MULTIPLIER — the cache was already working — so the only measurement that can
// keep it fixed is one that names each invocation. A subclass counting
// `execGitAsync` is the seam, which is why that method is `protected`.
//
// [LAW:behavior-not-structure] The option set is the bundled default's
// `gitaculous` segment, read off src/config/default-dsl-config.ts, not an
// invented one: this budget is only meaningful for the flags production asks
// for.

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GitService, type GitInfoOptions } from "../src/segments/git";
import type { LaunchResult } from "../src/proc/launch";

// The seven flags gitaculous asks for: sha, the four worktree counts, stash,
// upstream, repoName, operation, timeSinceCommit.
const GITACULOUS_OPTIONS: GitInfoOptions = {
  showSha: true,
  showWorkingTree: true,
  showStashCount: true,
  showUpstream: true,
  showRepoName: true,
  showOperation: true,
  showTimeSinceCommit: true,
};

class CountingGitService extends GitService {
  readonly invocations: string[] = [];

  protected override async execGitAsync(
    args: readonly string[],
    options: { cwd: string; timeout: number },
  ): Promise<LaunchResult> {
    this.invocations.push(args.join(" "));
    return super.execGitAsync(args, options);
  }
}

function run(cmd: string, cwd: string): void {
  execSync(cmd, { cwd, stdio: "pipe" });
}

describe("git spawns per cache miss", () => {
  let root: string;
  let repo: string;
  let nested: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ccb-spawn-budget-"));
    repo = join(root, "repo");
    mkdirSync(repo);
    run("git init -q -b main", repo);
    run("git config user.email t@t.t && git config user.name t", repo);
    run("git remote add origin https://github.com/o/r.git", repo);
    run("git commit -q --allow-empty -m init", repo);
    nested = join(repo, "a", "b");
    mkdirSync(nested, { recursive: true });
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("one fetch with the gitaculous option set costs the invocations listed here", async () => {
    const svc = new CountingGitService();
    const info = await svc.getGitInfo(repo, GITACULOUS_OPTIONS);

    expect(info.kind).toBe("ok");
    expect(svc.invocations).toEqual([
      "status --porcelain=v2 --branch",
      // The commit is named explicitly, so the oid is the fixture's own.
      expect.stringMatching(/^log -1 --format=%ct [0-9a-f]{40} --$/),
      "config --local --get-regexp ^remote\\..*\\.url$",
    ]);
  });

  // The spawn no cache could help: `getGitInfo`'s `absent` for a non-repo cwd is
  // deliberately not cached (only `ok` is), so this cost was paid once per
  // render, forever, by every non-repo session. The ascent takes it to nothing.
  test("a cwd outside any repo spawns no git at all", async () => {
    const svc = new CountingGitService();
    const info = await svc.getGitInfo(root, GITACULOUS_OPTIONS);

    expect(info.kind).toBe("absent");
    expect(svc.invocations).toEqual([]);
  });

  // [LAW:verifiable-goals] The commit-timestamp memo, asserted as a spawn that
  // does not happen. A commit's committer date never changes, so the only honest
  // lifetime for it is "until HEAD moves" — which is what this measures.
  test("a second fetch at the same commit does not re-ask for the timestamp", async () => {
    const svc = new CountingGitService();
    await svc.getGitInfo(repo, GITACULOUS_OPTIONS);

    svc.invocations.length = 0;
    const again = await svc.getGitInfo(repo, GITACULOUS_OPTIONS);

    expect(again.kind).toBe("ok");
    expect(svc.invocations).toEqual([
      "status --porcelain=v2 --branch",
      "config --local --get-regexp ^remote\\..*\\.url$",
    ]);
  });

  test("a new commit is asked about exactly once", async () => {
    const svc = new CountingGitService();
    const moving = join(root, "moving");
    mkdirSync(moving);
    run("git init -q -b main", moving);
    run("git config user.email t@t.t && git config user.name t", moving);
    run("git commit -q --allow-empty -m one", moving);

    const logCalls = (): string[] =>
      svc.invocations.filter((i) => i.startsWith("log -1"));

    await svc.getGitInfo(moving, { showTimeSinceCommit: true });
    expect(logCalls()).toHaveLength(1);

    run("git commit -q --allow-empty -m two", moving);
    svc.invocations.length = 0;
    await svc.getGitInfo(moving, { showTimeSinceCommit: true });
    expect(logCalls()).toHaveLength(1);

    svc.invocations.length = 0;
    await svc.getGitInfo(moving, { showTimeSinceCommit: true });
    expect(logCalls()).toHaveLength(0);
  });

  // An unborn HEAD has no commit to time, and the absence the status call already
  // reported is the answer — so it costs no spawn at all, where the old implicit
  // `git log -1` had to fail to find that out.
  test("an unborn HEAD costs no timestamp spawn", async () => {
    const svc = new CountingGitService();
    const empty = join(root, "empty");
    mkdirSync(empty);
    run("git init -q -b main", empty);

    const info = await svc.getGitInfo(empty, { showTimeSinceCommit: true });
    expect(info.kind).toBe("ok");
    if (info.kind !== "ok") return;
    expect(info.value.timeSinceCommit).toEqual({ kind: "absent" });
    expect(svc.invocations).toEqual(["status --porcelain=v2 --branch"]);
  });

  test("a cwd below the repo root finds the root without spawning git", async () => {
    const svc = new CountingGitService();
    const info = await svc.getGitInfo(nested, GITACULOUS_OPTIONS);

    expect(info.kind).toBe("ok");
    expect(svc.invocations[0]).toBe("status --porcelain=v2 --branch");
  });
});
