import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { WatcherRegistry } from "../src/daemon/cache/watchers";
import { GitDataProvider } from "../src/daemon/cache/git";
import { GitService, type GitInfo } from "../src/segments/git";
import { ok, type Outcome } from "../src/utils/outcome";
import { Holds } from "../src/utils/holds";
import { until } from "./helpers/until";

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
  test("a HEAD change re-reads the repo with no read asking", async () => {
    const repo = makeRepo();
    const inner = new StubInner(repo);
    const svc = new GitDataProvider({ inner });
    const holds = new Holds();

    await svc.getGitInfo(holds, repo, {});
    await svc.getGitInfo(holds, repo, {});
    expect(inner.calls).toBe(1);
    await new Promise((r) => setTimeout(r, 50));

    fs.writeFileSync(path.join(repo, ".git/HEAD"), "ref: refs/heads/y\n");
    // FSEvents may deliver the one write as more than one event, and a fire
    // mid-read queues one re-read after it, so the count is at least one more.
    await until(() => inner.calls >= 2, "the HEAD change's re-read");
    expect(svc.getStats().changes).toBeGreaterThanOrEqual(1);
    // The read takes the value the change's re-read stored.
    const reads = inner.calls;
    await svc.getGitInfo(holds, repo, {});
    expect(inner.calls).toBe(reads);

    svc.close();
    rmrf(repo);
  });

  test("a held repo is re-read on its period, which a dropped watch event cannot stop", async () => {
    const repo = makeRepo();
    const inner = new StubInner(repo);
    const svc = new GitDataProvider({ inner, periodMs: 150 });
    const holds = new Holds();

    await svc.getGitInfo(holds, repo, {});
    expect(inner.calls).toBe(1);
    await new Promise((r) => setTimeout(r, 400));
    expect(inner.calls).toBeGreaterThanOrEqual(3);

    // Released, the repo costs no read on the period.
    holds.declare(() => {});
    const after = inner.calls;
    await new Promise((r) => setTimeout(r, 400));
    expect(inner.calls).toBe(after);
    svc.close();
    rmrf(repo);
  });

  test("close releases all watchers", async () => {
    const repo = makeRepo();
    const inner = new StubInner(repo);
    const svc = new GitDataProvider({ inner });
    await svc.getGitInfo(new Holds(), repo, {});
    expect(svc.getStats().watchers).toBe(1);
    svc.close();
    expect(svc.getStats().watchers).toBe(0);
    rmrf(repo);
  });
});
