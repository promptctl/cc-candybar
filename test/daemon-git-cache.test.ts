import { CachedGitService } from "../src/daemon/cache/git";
import { GitService, type GitInfo } from "../src/segments/git";

class StubGitService extends GitService {
  public computeCalls: Array<{ workingDir: string; projectDir?: string }> = [];
  public repoRootByDir: Record<string, string | null> = {};
  public stubInfo: GitInfo = {
    branch: "main",
    status: "clean",
    ahead: 0,
    behind: 0,
  };

  override async findGitRoot(workingDir: string): Promise<string | null> {
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
  const svc = new CachedGitService({ ...opts, inner, sanityIntervalMs: 0 });
  return { svc, inner };
}

afterEach(() => {
  // Watchers will fail on the synthetic /repo/* paths but registry guards
  // against the resulting throw; nothing to clean up here.
});

describe("CachedGitService", () => {
  test("two cwds in same repo share one cache entry", async () => {
    const { svc, inner } = makeCache();
    inner.repoRootByDir = { "/repo/a": "/repo", "/repo/b": "/repo" };

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
});
