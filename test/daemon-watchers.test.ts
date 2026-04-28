import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { CachedGitService } from "../src/daemon/cache/git";
import { GitService, type GitInfo } from "../src/segments/git";

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
    reg.acquire(repo, () => fired++);
    await new Promise((r) => setTimeout(r, 50));

    fs.writeFileSync(path.join(repo, ".git/HEAD"), "ref: refs/heads/x\n");
    await new Promise((r) => setTimeout(r, 400));

    expect(fired).toBeGreaterThanOrEqual(1);
    reg.closeAll();
    rmrf(repo);
  });

  test("refcount: release closes watchers when refcount hits zero", async () => {
    const repo = makeRepo();
    const reg = new WatcherRegistry();
    const h1 = reg.acquire(repo, () => {});
    const h2 = reg.acquire(repo, () => {});
    expect(reg.size()).toBe(1);
    h1.release();
    expect(reg.size()).toBe(1); // refcount still > 0
    h2.release();
    expect(reg.size()).toBe(0);
    rmrf(repo);
  });

  test("LRU evicts oldest watcher and fires invalidation on the evicted slot", async () => {
    const repos = [makeRepo(), makeRepo(), makeRepo()];
    const reg = new WatcherRegistry({ maxWatchers: 2 });
    const fired: string[] = [];
    reg.acquire(repos[0]!, () => fired.push(repos[0]!));
    reg.acquire(repos[1]!, () => fired.push(repos[1]!));
    reg.acquire(repos[2]!, () => fired.push(repos[2]!));

    expect(reg.size()).toBe(2);
    expect(fired).toContain(repos[0]); // evicted slot fires its invalidate
    reg.closeAll();
    repos.forEach(rmrf);
  });

  test("closeAll closes every watcher", () => {
    const repo = makeRepo();
    const reg = new WatcherRegistry();
    reg.acquire(repo, () => {});
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
  override async findGitRoot(): Promise<string> {
    return this.repo;
  }
  override async getGitInfo(): Promise<GitInfo> {
    this.calls++;
    return { branch: "main", status: "clean", ahead: 0, behind: 0 };
  }
}

describe("CachedGitService + watchers integration", () => {
  test("HEAD change invalidates the cache entry", async () => {
    const repo = makeRepo();
    const inner = new StubInner(repo);
    const svc = new CachedGitService({ inner, sanityIntervalMs: 0 });

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
    const svc = new CachedGitService({ inner, sanityIntervalMs: 0 });

    await svc.getGitInfo(repo, {});
    expect(svc.getStats().size).toBe(1);

    // Bypass watchers entirely: change HEAD mtime without going through
    // the events path. The sanity check must still detect this.
    const headPath = path.join(repo, ".git/HEAD");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(headPath, future, future);

    svc.runSanityCheckNow();
    // Allow the debounced watcher (which may also fire) plus sanity drop.
    await new Promise((r) => setTimeout(r, 100));

    expect(svc.getStats().size).toBe(0);
    svc.close();
    rmrf(repo);
  });

  test("close releases all watchers", async () => {
    const repo = makeRepo();
    const inner = new StubInner(repo);
    const svc = new CachedGitService({ inner, sanityIntervalMs: 0 });
    await svc.getGitInfo(repo, {});
    expect(svc.getStats().watchers).toBe(1);
    svc.close();
    expect(svc.getStats().watchers).toBe(0);
    rmrf(repo);
  });
});
