import { GitDataProvider } from "../src/daemon/cache/git";
import { GitService, type GitInfo } from "../src/segments/git";

class StubGitService extends GitService {
  public computeCalls: Array<{ workingDir: string; projectDir?: string }> = [];
  public resolveCalls: Array<{ workingDir: string; projectDir?: string }> = [];
  public repoRootByDir: Record<string, string | null> = {};
  // Per-(workingDir, projectDir) override for resolveEffectiveGitDir. The
  // default behavior (when a key is absent) falls back to repoRootByDir.
  // Tests that exercise projectDir-driven cache-key behavior populate this
  // map directly.
  public effectiveDirByKey: Record<string, string | null> = {};
  public stubInfo: GitInfo = {
    branch: "main",
    status: "clean",
    ahead: 0,
    behind: 0,
  };

  override async findGitRoot(workingDir: string): Promise<string | null> {
    return this.repoRootByDir[workingDir] ?? null;
  }

  override async resolveEffectiveGitDir(
    workingDir: string,
    projectDir?: string,
  ): Promise<string | null> {
    this.resolveCalls.push({ workingDir, projectDir });
    const key = projectDir ? `${workingDir}|${projectDir}` : workingDir;
    if (key in this.effectiveDirByKey) {
      return this.effectiveDirByKey[key] ?? null;
    }
    return this.repoRootByDir[workingDir] ?? null;
  }

  override async getGitInfo(
    workingDir: string,
    _options: Parameters<GitService["getGitInfo"]>[1] = {},
    projectDir?: string,
  ): Promise<GitInfo | null> {
    if (!(workingDir in this.repoRootByDir)) return null;
    if (this.repoRootByDir[workingDir] === null) return null;
    this.computeCalls.push({ workingDir, projectDir });
    return this.stubInfo;
  }
}

function makeCache(opts: { ttlMs?: number; maxEntries?: number } = {}) {
  const inner = new StubGitService();
  // sanityIntervalMs=0 disables the periodic check in unit tests; we drive
  // it manually via runSanityCheckNow().
  const svc = new GitDataProvider({ ...opts, inner, sanityIntervalMs: 0 });
  return { svc, inner };
}

afterEach(() => {
  // Watchers will fail on the synthetic /repo/* paths but registry guards
  // against the resulting throw; nothing to clean up here.
});

describe("GitDataProvider", () => {
  test("two cwds in same repo share one cache entry", async () => {
    const { svc, inner } = makeCache();
    // After kz8.3 review fix, provider's inner.getGitInfo is invoked with the
    // resolved repoRoot (not the cwd) so the inner doesn't re-walk findGitRoot.
    // The stub's lookups expect to see the resolved key.
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
    await svc.getGitInfo("/a", {}); // bumps /a
    await svc.getGitInfo("/c", {}); // should evict /b, not /a

    // Re-access /a → cache hit; /b → miss (evicted).
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

  test("non-repo path returns null and does not cache", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/nowhere": null };

    const r1 = await svc.getGitInfo("/nowhere", {});
    expect(r1).toBeNull();
    expect(svc.getStats().size).toBe(0);
  });

  test("projectDir override keys cache on effective gitDir, not workingDir", async () => {
    // workingDir=/cwd is in repoA, but a projectDir=/repoB override makes the
    // effective gitDir /repoB. The cache key must follow the effective gitDir
    // so repo B's data doesn't get cached under repo A's key (the pre-fix bug
    // Copilot flagged on the second-pass review of kz8.3).
    const { svc, inner } = makeCache();
    inner.repoRootByDir = {
      "/cwd": "/repoA",
      "/repoA": "/repoA",
      "/repoB": "/repoB",
    };
    inner.effectiveDirByKey = {
      "/cwd|/repoB": "/repoB", // with projectDir, gitDir becomes /repoB
      "/cwd": "/repoA", // without, gitDir is /repoA
    };

    await svc.getGitInfo("/cwd", {}, "/repoB");
    await svc.getGitInfo("/cwd", {});

    // Two distinct effective gitDirs → two cache entries, no contamination.
    expect(svc.getStats().size).toBe(2);
    // Inner shell-outs land on the resolved gitDirs, not the cwd.
    const dirs = inner.computeCalls.map((c) => c.workingDir).sort();
    expect(dirs).toEqual(["/repoA", "/repoB"]);
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

// Microtask drain helper — subscribe()'s initial delivery happens on a
// microtask chain after findGitRoot + getGitInfo settle.
async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
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
    // No subscriber registered → no watcher acquired.
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

    // Both subscribers acquire the same key "git:/repo"; refcount = 2 inside
    // one slot. The cache's getInfo path also acquires the same key — slot
    // count, not refcount, is the right metric.
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

    // The throwing subscriber must not prevent later notifications.
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
    expect(calls).toHaveLength(1); // initial

    // Schedule invalidation; unsubscribe before the async refresh delivers.
    inner.stubInfo = { ...inner.stubInfo, branch: "feature" };
    svc.invalidateRepo("/repo");
    unsub();
    await tick();

    expect(calls).toHaveLength(1); // no post-unsubscribe delivery
  });

  test("refresh path does not re-resolve repoRoot on invalidation", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const unsub = svc.subscribe("/repo", () => {});
    await tick();
    // Subscribe resolves once.
    expect(inner.resolveCalls.length).toBe(1);

    // Invalidate a few times; the refresh loop should reuse the stored
    // repoRoot — not call resolveEffectiveGitDir again per iteration.
    svc.invalidateRepo("/repo");
    svc.invalidateRepo("/repo");
    await tick(10);

    // Still 1 — refreshes used the stored repoRoot.
    expect(inner.resolveCalls.length).toBe(1);
    unsub();
  });

  test("rapid invalidations coalesce into at most two refreshes", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo": "/repo" };

    const calls: Array<GitInfo | null> = [];
    const unsub = svc.subscribe("/repo", (info) => calls.push(info));
    await tick();
    expect(calls).toHaveLength(1); // initial
    const initialComputeCalls = inner.computeCalls.length;

    // Fire 10 invalidations synchronously. The first triggers a refresh; the
    // rest collapse into one trailing-edge re-fetch via refreshAgain.
    for (let i = 0; i < 10; i++) svc.invalidateRepo("/repo");
    await tick(10);

    // Subscribers see at most 2 additional deliveries (the leading edge fetch
    // and the trailing-edge fetch). Without coalescing this would be 10.
    expect(calls.length - 1).toBeLessThanOrEqual(2);
    // Inner shell-outs also bounded — leading + trailing only.
    expect(inner.computeCalls.length - initialComputeCalls).toBeLessThanOrEqual(
      2,
    );
    unsub();
  });
});
