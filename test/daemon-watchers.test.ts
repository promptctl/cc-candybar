import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { GitDataProvider } from "../src/daemon/cache/git";
import { GitService, type GitInfo } from "../src/segments/git";
import { ok, type Outcome } from "../src/utils/outcome";

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "powerline-watch-"));
  execSync("git init -q", { cwd: dir });
  execSync("git config user.email t@t.t && git config user.name t", {
    cwd: dir,
  });
  fs.writeFileSync(path.join(dir, "f"), "x");
  execSync("git add . && git commit -q -m init", { cwd: dir });
  return dir;
}

function rmrf(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("WatcherRegistry", () => {
  test("HEAD modification fires invalidation within debounce window", async () => {
    const repo = makeRepo();
    const reg = new WatcherRegistry();
    let fired = 0;
    const headPath = path.join(repo, ".git/HEAD");
    reg.acquire(repo, { files: [headPath], dirs: [] }, () => fired++);
    await new Promise((r) => setTimeout(r, 50));

    fs.writeFileSync(headPath, "ref: refs/heads/x\n");
    await new Promise((r) => setTimeout(r, 400));

    expect(fired).toBeGreaterThanOrEqual(1);
    reg.closeAll();
    rmrf(repo);
  });

  test("refcount: release closes watchers when refcount hits zero", async () => {
    const repo = makeRepo();
    const reg = new WatcherRegistry();
    const h1 = reg.acquire(repo, { files: [], dirs: [] }, () => {});
    const h2 = reg.acquire(repo, { files: [], dirs: [] }, () => {});
    expect(reg.size()).toBe(1);
    h1.release();
    expect(reg.size()).toBe(1); // refcount still > 0
    h2.release();
    expect(reg.size()).toBe(0);
    rmrf(repo);
  });

  // brandon-unfiled-3248.576q: the registry bounds nothing — its consumers do.
  // An LRU cap here closed watches under holders that still held them.
  test("a slot closes only when its last holder releases it, however many are open", () => {
    const counters = { watchersOpened: 0, watchersClosed: 0 };
    const reg = new WatcherRegistry({ counters });
    const fired: string[] = [];
    const handles = Array.from({ length: 300 }, (_, i) =>
      reg.acquire(`k${i}`, { files: [], dirs: [] }, () => fired.push(`k${i}`)),
    );

    expect(reg.size()).toBe(300);
    expect(counters).toEqual({ watchersOpened: 300, watchersClosed: 0 });
    expect(fired).toEqual([]);

    handles[0]!.release();
    expect(reg.size()).toBe(299);
    expect(counters.watchersClosed).toBe(1);
    reg.closeAll();
  });

  test("closeAll closes every watcher", () => {
    const repo = makeRepo();
    const reg = new WatcherRegistry();
    reg.acquire(repo, { files: [], dirs: [] }, () => {});
    expect(reg.size()).toBe(1);
    reg.closeAll();
    expect(reg.size()).toBe(0);
    rmrf(repo);
  });
});

class StubInner extends GitService {
  public calls = 0;
  constructor(private repo: string) {
    super();
  }
  override async findGitRoot(): Promise<Outcome<string>> {
    return ok(this.repo);
  }
  override async getGitInfo(): Promise<Outcome<GitInfo>> {
    this.calls++;
    return ok({
      branch: "main",
      status: "clean",
      aheadBehind: ok({ ahead: 0, behind: 0 }),
      head: ok("c0ffee"),
    });
  }
}

describe("GitDataProvider + watchers integration", () => {
  test("HEAD change invalidates the cache entry", async () => {
    const repo = makeRepo();
    const inner = new StubInner(repo);
    const svc = new GitDataProvider({ inner, sanityIntervalMs: 0 });

    await svc.getGitInfo(repo, {});
    await svc.getGitInfo(repo, {});
    expect(inner.calls).toBe(1);
    await new Promise((r) => setTimeout(r, 50));

    fs.writeFileSync(path.join(repo, ".git/HEAD"), "ref: refs/heads/y\n");
    await new Promise((r) => setTimeout(r, 400));

    await svc.getGitInfo(repo, {});
    expect(inner.calls).toBe(2);
    expect(svc.getStats().invalidations).toBeGreaterThanOrEqual(1);

    svc.close();
    rmrf(repo);
  });

  test("sanity check catches missed events via mtime mismatch", async () => {
    const repo = makeRepo();
    const inner = new StubInner(repo);
    const svc = new GitDataProvider({ inner, sanityIntervalMs: 0 });

    await svc.getGitInfo(repo, {});
    expect(svc.getStats().size).toBe(1);

    // Bypass watchers entirely: change HEAD mtime without going through
    // the events path. The sanity check must still detect this.
    const headPath = path.join(repo, ".git/HEAD");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(headPath, future, future);

    svc.runSanityCheckNow();
    // Allow the debounced watcher (which may also fire) plus sanity expiry.
    await new Promise((r) => setTimeout(r, 100));

    // The cached value is stale: the next read fetches afresh.
    expect(svc.getStats().invalidations).toBeGreaterThanOrEqual(1);
    await svc.getGitInfo(repo, {});
    expect(inner.calls).toBe(2);
    svc.close();
    rmrf(repo);
  });

  test("close releases all watchers", async () => {
    const repo = makeRepo();
    const inner = new StubInner(repo);
    const svc = new GitDataProvider({ inner, sanityIntervalMs: 0 });
    await svc.getGitInfo(repo, {});
    expect(svc.getStats().watchers).toBe(1);
    svc.close();
    expect(svc.getStats().watchers).toBe(0);
    rmrf(repo);
  });
});
