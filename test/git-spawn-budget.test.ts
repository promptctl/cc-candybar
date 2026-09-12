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
      "log -1 --format=%ct",
      "stash list",
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

  test("a cwd below the repo root finds the root without spawning git", async () => {
    const svc = new CountingGitService();
    const info = await svc.getGitInfo(nested, GITACULOUS_OPTIONS);

    expect(info.kind).toBe("ok");
    expect(svc.invocations[0]).toBe("status --porcelain=v2 --branch");
  });
});
