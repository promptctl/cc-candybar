import { GitDataProvider } from "../src/daemon/cache/git";
import {
  GitService,
  type GitInfo,
  type PullRequest,
} from "../src/segments/git";
import { ABSENT, ok, type Outcome } from "../src/utils/outcome";

class StubGitService extends GitService {
  public computeCalls: Array<{ workingDir: string; projectDir?: string }> = [];
  public resolveCalls: Array<{ workingDir: string; projectDir?: string }> = [];
  public gitDirCalls: string[] = [];
  // Per-workingDir override for resolveGitDir, so worktree tests need no real fs.
  public gitDirByDir: Record<string, string> = {};
  public repoRootByDir: Record<string, string | null> = {};
  // Per-(workingDir, projectDir) override; an absent key falls back to repoRootByDir.
  public effectiveDirByKey: Record<string, string | null> = {};
  public stubInfo: GitInfo = {
    branch: "main",
    status: "clean",
    aheadBehind: ok({ ahead: 0, behind: 0 }),
  };
  public prCalls: Array<{ workingDir: string; remoteUrl: string }> = [];
  public stubPr: Outcome<PullRequest> = ok({
    number: 7,
    state: "OPEN",
    url: "https://example.test/pull/7",
  });
  public stubRemote: Outcome<string> = ok("git@github.com:acme/widget.git");

  override async getRepoRemoteUrl(
    _workingDir: string,
  ): Promise<Outcome<string>> {
    return this.stubRemote;
  }

  override async resolvePullRequest(
    workingDir: string,
    remoteUrl: string,
  ): Promise<Outcome<PullRequest>> {
    this.prCalls.push({ workingDir, remoteUrl });
    return this.stubPr;
  }

  override async findGitRoot(workingDir: string): Promise<Outcome<string>> {
    const root = this.repoRootByDir[workingDir] ?? null;
    return root === null ? ABSENT : ok(root);
  }

  override resolveGitDir(workingDir: string): string {
    this.gitDirCalls.push(workingDir);
    if (workingDir in this.gitDirByDir) return this.gitDirByDir[workingDir]!;
    return `${workingDir}/.git`;
  }

  override async resolveEffectiveGitDir(
    workingDir: string,
    projectDir?: string,
  ): Promise<Outcome<string>> {
    this.resolveCalls.push({ workingDir, projectDir });
    const key = projectDir ? `${workingDir}|${projectDir}` : workingDir;
    if (key in this.effectiveDirByKey) {
      const dir = this.effectiveDirByKey[key] ?? null;
      return dir === null ? ABSENT : ok(dir);
    }
    const root = this.repoRootByDir[workingDir] ?? null;
    return root === null ? ABSENT : ok(root);
  }

  override async getGitInfo(
    workingDir: string,
    _options: Parameters<GitService["getGitInfo"]>[1] = {},
    projectDir?: string,
  ): Promise<Outcome<GitInfo>> {
    if (!(workingDir in this.repoRootByDir)) return ABSENT;
    if (this.repoRootByDir[workingDir] === null) return ABSENT;
    this.computeCalls.push({ workingDir, projectDir });
    return ok(this.stubInfo);
  }
}

function makeCache(opts: { ttlMs?: number; maxEntries?: number } = {}) {
  const inner = new StubGitService();
  // sanityIntervalMs=0 disables the periodic check; tests drive it manually.
  const svc = new GitDataProvider({ ...opts, inner, sanityIntervalMs: 0 });
  return { svc, inner };
}

afterEach(() => {
});

describe("GitDataProvider", () => {
  test("two cwds in same repo share one cache entry", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = {
      "/repo/a": "/repo",
      "/repo/b": "/repo",
      "/repo": "/repo",
    };

    await svc.getGitInfo("/repo/a", { showSha: false });
    await svc.getGitInfo("/repo/b", { showSha: false });

    expect(inner.computeCalls).toHaveLength(1);
    expect(svc.getStats()).toMatchObject({ size: 1, hits: 1, misses: 1 });
  });

  test("different repos get different entries", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/r1": "/r1", "/r2": "/r2" };

    await svc.getGitInfo("/r1", {});
    await svc.getGitInfo("/r2", {});

    expect(svc.getStats().size).toBe(2);
    expect(inner.computeCalls).toHaveLength(2);
  });

  test("different option sets in same repo are separate entries", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    await svc.getGitInfo("/repo", { showSha: true });
    await svc.getGitInfo("/repo", { showSha: false });

    expect(svc.getStats().size).toBe(2);
  });

  test("LRU evicts oldest at cap", async () => {
    const { svc, inner } = makeCache({ maxEntries: 3 });
    for (let i = 0; i < 5; i++) {
      inner.repoRootByDir[`/r${i}`] = `/r${i}`;
      await svc.getGitInfo(`/r${i}`, {});
    }
    expect(svc.getStats().size).toBe(3);
  });

  test("LRU bumps recently-used entries past eviction", async () => {
    const { svc, inner } = makeCache({ maxEntries: 2 });
    inner.repoRootByDir = { "/a": "/a", "/b": "/b", "/c": "/c" };

    await svc.getGitInfo("/a", {});
    await svc.getGitInfo("/b", {});
    await svc.getGitInfo("/a", {});
    await svc.getGitInfo("/c", {});

    inner.computeCalls = [];
    await svc.getGitInfo("/a", {});
    await svc.getGitInfo("/b", {});
    expect(inner.computeCalls.map((c) => c.workingDir)).toEqual(["/b"]);
  });

  test("TTL expiry forces recompute", async () => {
    const { svc, inner } = makeCache({ ttlMs: 0 });
    inner.repoRootByDir["/repo"] = "/repo";

    await svc.getGitInfo("/repo", {});
    await svc.getGitInfo("/repo", {});

    expect(inner.computeCalls).toHaveLength(2);
  });

  test("non-repo path returns absent and does not cache", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/nowhere": null };

    const r1 = await svc.getGitInfo("/nowhere", {});
    expect(r1).toEqual({ kind: "absent" });
    expect(svc.getStats().size).toBe(0);
  });

  test("projectDir override keys cache on effective gitDir, not workingDir", async () => {
    // A projectDir override makes the effective gitDir /repoB while the cwd is in
    // repoA; the key must follow the EFFECTIVE dir or B caches under A's key.
    const { svc, inner } = makeCache();
    inner.repoRootByDir = {
      "/cwd": "/repoA",
      "/repoA": "/repoA",
      "/repoB": "/repoB",
    };
    inner.effectiveDirByKey = {
      "/cwd|/repoB": "/repoB",
      "/cwd": "/repoA",
    };

    await svc.getGitInfo("/cwd", {}, "/repoB");
    await svc.getGitInfo("/cwd", {});

    expect(svc.getStats().size).toBe(2);
    const dirs = inner.computeCalls.map((c) => c.workingDir).sort();
    expect(dirs).toEqual(["/repoA", "/repoB"]);
  });

  test("worktree path resolves HEAD/index from .git file's gitdir target", async () => {
    // In a worktree, repoRoot/.git is a *file* pointing at the real metadata dir;
    // watchers and mtime snapshots must follow it or they silently no-op.
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/wt": "/wt" };
    inner.gitDirByDir = { "/wt": "/main/.git/worktrees/wt" };

    const r = await svc.getGitInfo("/wt", {});
    expect(r).toMatchObject({ kind: "ok", value: { branch: "main" } });

    expect(inner.gitDirCalls).toContain("/wt");
  });

  test("concurrent cache misses on same key coalesce into one fetch", async () => {
    // Without in-flight coalescing both callers see "no entry" and both shell out.
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const [r1, r2] = await Promise.all([
      svc.getGitInfo("/repo", {}),
      svc.getGitInfo("/repo", {}),
    ]);

    expect(r1).toMatchObject({ kind: "ok", value: { branch: "main" } });
    expect(r2).toBe(r1);
    expect(inner.computeCalls).toHaveLength(1);
    expect(svc.getStats()).toMatchObject({ size: 1, hits: 0, misses: 1 });
  });

  test("two cwds with same projectDir share one cache entry", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = {
      "/cwd-x": "/repoA",
      "/cwd-y": "/repoA",
      "/repoA": "/repoA",
    };
    inner.effectiveDirByKey = {
      "/cwd-x|/repoA": "/repoA",
      "/cwd-y|/repoA": "/repoA",
    };

    await svc.getGitInfo("/cwd-x", {}, "/repoA");
    await svc.getGitInfo("/cwd-y", {}, "/repoA");

    expect(svc.getStats()).toMatchObject({ size: 1, hits: 1, misses: 1 });
  });
});

// Each `setImmediate` yield drains one round of microtasks; nested chains need N.
async function tick(times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((r) => setImmediate(r));
  }
}

describe("GitDataProvider.subscribe", () => {
  test("delivers initial snapshot once", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const calls: Array<GitInfo | null> = [];
    const unsub = svc.subscribe("/repo", (info) => calls.push(info));
    await tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ branch: "main", status: "clean" });
    unsub();
  });

  test("delivers null once for non-repo cwd; no watcher held", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/nowhere": null };

    const calls: Array<GitInfo | null> = [];
    const unsub = svc.subscribe("/nowhere", (info) => calls.push(info));
    await tick();

    expect(calls).toEqual([null]);
    expect(svc.getStats().watchers).toBe(0);
    unsub();
  });

  test("invalidateRepo refreshes subscribers", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const calls: Array<GitInfo | null> = [];
    const unsub = svc.subscribe("/repo", (info) => calls.push(info));
    await tick();
    expect(calls).toHaveLength(1);

    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.invalidateRepo("/repo");
    await tick();

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ branch: "feature" });
    unsub();
  });

  test("multiple subscribers in same repo share one watcher slot", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo/a": "/repo", "/repo/b": "/repo" };

    const unsubA = svc.subscribe("/repo/a", () => {});
    const unsubB = svc.subscribe("/repo/b", () => {});
    await tick();

    // Both subscribers share key "git:/repo": slot count, not refcount, is the metric.
    expect(svc.getStats().watchers).toBe(1);
    unsubA();
    unsubB();
  });

  test("unsubscribe before delivery suppresses the callback", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const calls: Array<GitInfo | null> = [];
    const unsub = svc.subscribe("/repo", (info) => calls.push(info));
    unsub();
    await tick();

    expect(calls).toHaveLength(0);
  });

  test("subscriber throwing in initial delivery does not crash", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const goodCalls: Array<GitInfo | null> = [];
    const unsubBad = svc.subscribe("/repo", () => {
      throw new Error("bad subscriber");
    });
    const unsubGood = svc.subscribe("/repo", (info) => goodCalls.push(info));
    await tick();

    expect(goodCalls).toHaveLength(1);
    expect(goodCalls[0]).toMatchObject({ branch: "main" });
    unsubBad();
    unsubGood();
  });

  test("subscriber throwing on null delivery does not crash", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/nowhere": null };

    expect(() => {
      const unsub = svc.subscribe("/nowhere", () => {
        throw new Error("bad subscriber");
      });
      unsub();
    }).not.toThrow();
    await tick();
  });

  test("unsubscribe during invalidation prevents stale delivery", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const calls: Array<GitInfo | null> = [];
    const unsub = svc.subscribe("/repo", (info) => calls.push(info));
    await tick();
    expect(calls).toHaveLength(1);

    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.invalidateRepo("/repo");
    unsub();
    await tick();

    expect(calls).toHaveLength(1);
  });

  test("refresh path does not re-resolve repoRoot on invalidation", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const unsub = svc.subscribe("/repo", () => {});
    await tick();
    expect(inner.resolveCalls.length).toBe(1);

    // The refresh loop reuses the stored repoRoot instead of re-resolving each time.
    svc.invalidateRepo("/repo");
    svc.invalidateRepo("/repo");
    await tick(10);

    expect(inner.resolveCalls.length).toBe(1);
    unsub();
  });

  test("rapid invalidations coalesce into at most two refreshes", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const calls: Array<GitInfo | null> = [];
    const unsub = svc.subscribe("/repo", (info) => calls.push(info));
    await tick();
    expect(calls).toHaveLength(1);
    const initialComputeCalls = inner.computeCalls.length;

    // The first invalidation triggers a refresh; the rest collapse into one trailing.
    for (let i = 0; i < 10; i++) svc.invalidateRepo("/repo");
    await tick(10);

    expect(calls.length - 1).toBeLessThanOrEqual(2);
    expect(inner.computeCalls.length - initialComputeCalls).toBeLessThanOrEqual(
      2,
    );
    unsub();
  });
});

describe("GitDataProvider PR cache", () => {
  test("showPullRequest off → resolvePullRequest never called, no PR attached", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const out = await svc.getGitInfo("/repo", {});
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.value.pullRequest).toBeUndefined();
    expect(inner.prCalls).toHaveLength(0);
  });

  test("showPullRequest on → PR attached to GitInfo", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const out = await svc.getGitInfo("/repo", { showPullRequest: true });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.value.pullRequest).toEqual(
      ok({ number: 7, state: "OPEN", url: "https://example.test/pull/7" }),
    );
    expect(inner.prCalls).toHaveLength(1);
  });

  test("PR cache survives GitInfo refetch — one forge call across many renders", async () => {
    // ttlMs:0 forces a GitInfo miss every call, isolating the PR cache's own TTL.
    const { svc, inner } = makeCache({ ttlMs: 0 });
    inner.repoRootByDir = { "/repo": "/repo" };

    await svc.getGitInfo("/repo", { showPullRequest: true });
    await svc.getGitInfo("/repo", { showPullRequest: true });
    await svc.getGitInfo("/repo", { showPullRequest: true });

    expect(inner.computeCalls.length).toBeGreaterThanOrEqual(3);
    expect(inner.prCalls).toHaveLength(1);
  });

  test("branch switch → PR re-fetched (branch is part of the key)", async () => {
    const { svc, inner } = makeCache({ ttlMs: 0 });
    inner.repoRootByDir = { "/repo": "/repo" };

    inner.stubInfo = { ...inner.stubInfo, branch: "feature-a" };
    await svc.getGitInfo("/repo", { showPullRequest: true });
    inner.stubInfo = { ...inner.stubInfo, branch: "feature-b" };
    await svc.getGitInfo("/repo", { showPullRequest: true });

    expect(inner.prCalls).toHaveLength(2);
  });

  test("a failed forge lookup is attached as failed (surfaced, not dropped)", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.stubPr = { kind: "failed", reason: "gh pr view: non-zero, HTTP 401" };

    const out = await svc.getGitInfo("/repo", { showPullRequest: true });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.value.pullRequest).toEqual({
      kind: "failed",
      reason: "gh pr view: non-zero, HTTP 401",
    });
  });

  test("remote change → new key → PR re-fetched (remote is part of the key)", async () => {
    const { svc, inner } = makeCache({ ttlMs: 0 });
    inner.repoRootByDir = { "/repo": "/repo" };

    inner.stubRemote = ok("git@github.com:acme/widget.git");
    await svc.getGitInfo("/repo", { showPullRequest: true });
    inner.stubRemote = ok("git@gitlab.com:acme/widget.git");
    await svc.getGitInfo("/repo", { showPullRequest: true });

    expect(inner.prCalls).toHaveLength(2);
    expect(inner.prCalls.map((c) => c.remoteUrl)).toEqual([
      "git@github.com:acme/widget.git",
      "git@gitlab.com:acme/widget.git",
    ]);
  });

  test("failed remote read → PR failed (surfaced); no forge call", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.stubRemote = { kind: "failed", reason: "git config: timeout" };

    const out = await svc.getGitInfo("/repo", { showPullRequest: true });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.value.pullRequest).toEqual({
      kind: "failed",
      reason: "git config: timeout",
    });
    expect(inner.prCalls).toHaveLength(0);
  });

  test("no remote (absent) → PR absent; no forge call", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };
    inner.stubRemote = ABSENT;

    const out = await svc.getGitInfo("/repo", { showPullRequest: true });
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.value.pullRequest).toEqual(ABSENT);
    expect(inner.prCalls).toHaveLength(0);
  });
});
